import { z } from 'zod';
import { all, one, stmt, type NodeRow } from '../db/d1';
import { DbTree } from '../db/tree';
import { isSkillDoc } from '../db/fts';
import type { Authz } from '../authz/authorize';
import { AREA_IDS, SKILL_MD, areaOfPath, isAreaId, isFileFormat } from '../lib/areas';
import { distinctLinks, linkAllowed, linkSegments, place, resolvePath, type LinkStatus, type RawLink } from '../lib/links';
import { bodyLinks, lint, type LintContext, type Warning } from '../lib/lint';
import { canonicalPaths } from './shared';

/** Helpers shared by the document, skill, link and warning operations. Access is decided by the caller's Authz. */

export const WarningOut = z.object({
  code: z.string(),
  message: z.string(),
  key: z.string().describe('code|fingerprint of the flagged text. Pass it to dismiss_warning.'),
  level: z.enum(['warn', 'broken']),
});

export const LinkOut = z.object({
  index: z.number().describe('Position among the distinct links of the document, in order of appearance'),
  href: z.string().nullable().describe('The path as written. null when locked.'),
  label: z.string().nullable(),
  status: z.enum(['ok', 'wrong_direction', 'broken', 'locked']),
  id: z.string().nullable().describe('Target id when you can read it'),
  canonical_path: z.string().nullable(),
  kind: z.enum(['folder', 'skill', 'doc', 'file']).nullable(),
});
export type LinkOutT = z.infer<typeof LinkOut>;

// ---------- content ----------

export async function versionContent(db: D1Database, docId: string, n: number | null): Promise<string | null> {
  if (!n) return null;
  return (await one<{ content: string }>(db, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', docId, n))?.content ?? null;
}

/** The working copy: the draft if there is one, else the head version. */
export async function workingContent(db: D1Database, doc: NodeRow): Promise<string | null> {
  const d = await one<{ content: string }>(db, 'SELECT content FROM drafts WHERE doc_id = ?', doc.id);
  if (d) return d.content;
  return versionContent(db, doc.id, doc.head_version || null);
}

// ---------- links ----------

/** Rewrites the stored links of one document for its published version or its working copy ('draft'). */
export async function linkStmts(db: D1Database, tree: DbTree, doc: NodeRow, kind: 'published' | 'draft', content: string | null): Promise<D1PreparedStatement[]> {
  const out = [stmt(db, 'DELETE FROM links WHERE from_node = ? AND kind = ?', doc.id, kind)];
  if (content === null || doc.kind !== 'doc' || isFileFormat(doc.format)) return out;
  let ord = 0;
  for (const l of distinctLinks(content)) {
    const target = await resolvePath(tree, l.path);
    out.push(
      stmt(db, 'INSERT INTO links (from_node, kind, ord, to_path, label, to_node) VALUES (?,?,?,?,?,?)', doc.id, kind, ord++, linkSegments(l.path).join('/'), l.label, target?.id ?? null),
    );
  }
  return out;
}

export interface Classified {
  status: LinkStatus;
  target: NodeRow | null;
}

/** prototype classify(): broken (no target), locked (target exists, caller cannot read it), else ok or wrong_direction. */
export async function classifyLinks(az: Authz, tree: DbTree, src: NodeRow, paths: string[]): Promise<Map<string, Classified>> {
  const srcPlaced = place(src, await tree.chainSkills([src]));
  const targets = new Map<string, NodeRow | null>();
  for (const p of paths) if (!targets.has(p)) targets.set(p, (await resolvePath(tree, p)) as NodeRow | null);
  const found = [...new Map([...targets.values()].filter((t): t is NodeRow => !!t).map((t) => [t.id, t])).values()];
  const roles = await az.roles(found);
  const out = new Map<string, Classified>();
  for (const [p, t] of targets) {
    if (!t) out.set(p, { status: 'broken', target: null });
    else if ((roles.get(t.id) ?? 0) === 0) out.set(p, { status: 'locked', target: null });
    else out.set(p, { status: linkAllowed(srcPlaced, place(t, new Set())) ? 'ok' : 'wrong_direction', target: t });
  }
  return out;
}

async function targetKinds(tree: DbTree, targets: NodeRow[]): Promise<Map<string, LinkOutT['kind']>> {
  const skills = await tree.skillSet(targets.filter((t) => t.kind === 'folder').map((t) => t.id));
  return new Map(targets.map((t) => [t.id, t.kind === 'folder' ? (skills.has(t.id) ? 'skill' : 'folder') : isFileFormat(t.format) ? 'file' : 'doc']));
}

/** Outgoing links of a document (distinct, in order), classified for the caller. Locked targets are never named. */
export async function outgoingLinks(az: Authz, tree: DbTree, src: NodeRow, links: RawLink[]): Promise<LinkOutT[]> {
  if (isFileFormat(src.format)) return [];
  const cls = await classifyLinks(az, tree, src, links.map((l) => l.path));
  const targets = [...cls.values()].map((c) => c.target).filter((t): t is NodeRow => !!t);
  const canon = await canonicalPaths(az, targets);
  const kinds = await targetKinds(tree, targets);
  return links.map((l, index) => {
    const c = cls.get(l.path)!;
    if (c.status === 'locked') return { index, href: null, label: l.label, status: 'locked', id: null, canonical_path: null, kind: null };
    return {
      index,
      href: l.path,
      label: l.label,
      status: c.status,
      id: c.target?.id ?? null,
      canonical_path: c.target ? (canon.get(c.target.id) ?? null) : null,
      kind: c.target ? (kinds.get(c.target.id) ?? null) : null,
    };
  });
}

// ---------- rules ----------

/** Bytes of every published rule (the prototype's rulesBytes, used by the rules-cap warning). */
export async function rulesTotalBytes(db: D1Database): Promise<number> {
  const row = await one<{ b: number }>(
    db,
    `SELECT COALESCE(SUM(length(CAST(v.content AS BLOB))), 0) AS b FROM nodes n JOIN doc_versions v ON v.doc_id = n.id AND v.n = n.published_version
     WHERE n.parent_id = ? AND n.kind = 'doc' AND n.deleted_at IS NULL`,
    AREA_IDS.rules,
  );
  return row?.b ?? 0;
}

// ---------- warnings ----------

/** All authoring warnings for a node and the given content, from the caller's point of view (link access). */
export async function lintNode(az: Authz, tree: DbTree, node: NodeRow, content: string): Promise<Warning[]> {
  const area = areaOfPath(node.path);
  const base: LintContext = {
    kind: node.kind,
    area,
    isAreaRoot: isAreaId(node.id),
    isSkillMd: isSkillDoc(node),
    isFile: node.kind === 'doc' && isFileFormat(node.format),
    rulesBytes: 0,
    links: new Map(),
    nestedRefs: [],
  };
  if (area === 'rules') base.rulesBytes = await rulesTotalBytes(az.db);
  if (node.kind === 'folder' || base.isFile) return lint(base, content);

  const cls = await classifyLinks(az, tree, node, distinctLinks(content).map((l) => l.path));
  base.links = new Map([...cls].map(([p, c]) => [p, c.status]));

  if (base.isSkillMd && node.parent_id) {
    const skillPrefix = node.path.slice(0, node.path.length - node.id.length - 1);
    const nested: string[] = [];
    const seen = new Set<string>();
    for (const p of bodyLinks(content)) {
      const t = cls.get(p)?.target ?? null;
      if (!t || t.kind !== 'doc' || t.id === node.id || isFileFormat(t.format) || !t.path.startsWith(skillPrefix) || seen.has(t.id)) continue;
      seen.add(t.id);
      const role = await az.role(t);
      const kind = role >= 2 ? 'draft' : 'published';
      const has = await one<{ x: number }>(az.db, 'SELECT 1 AS x FROM links WHERE from_node = ? AND kind = ? LIMIT 1', t.id, kind);
      if (!has) continue;
      const canon = (await canonicalPaths(az, [t])).get(t.id);
      nested.push(canon ? canon.split('/').slice(2).join('/') : t.name);
    }
    base.nestedRefs = nested;
  }
  return lint(base, content);
}

/** Splits warnings into active and dismissed using the node's stored dismissals. */
export async function partitionWarnings(db: D1Database, nodeId: string, warnings: Warning[]): Promise<{ warnings: Warning[]; dismissed: Warning[] }> {
  if (warnings.length === 0) return { warnings: [], dismissed: [] };
  const keys = new Set((await all<{ key: string }>(db, 'SELECT key FROM lint_dismissals WHERE node_id = ?', nodeId)).map((r) => r.key));
  return { warnings: warnings.filter((w) => !keys.has(w.key)), dismissed: warnings.filter((w) => keys.has(w.key)) };
}

/** Active (not dismissed) warnings for a node and content. */
export async function activeWarnings(az: Authz, tree: DbTree, node: NodeRow, content: string): Promise<Warning[]> {
  return (await partitionWarnings(az.db, node.id, await lintNode(az, tree, node, content))).warnings;
}

// ---------- skill folders ----------

export const SkillFileOut = z.object({
  id: z.string(),
  path: z.string().describe('Path inside the skill folder, e.g. scripts/smoke-test.sh'),
  kind: z.enum(['markdown', 'file', 'skill']).describe('skill = a nested sub-skill folder'),
  format: z.string().nullable(),
  published_version: z.number().nullable(),
  head_version: z.number().nullable().describe('Editors and above only'),
});
export type SkillFileOutT = z.infer<typeof SkillFileOut>;

export interface SkillMember {
  node: NodeRow;
  rel: string;
  sub: boolean;
  /** Organisational folders between the skill folder and this entry. */
  via: string[];
}

/** Every document of a skill folder (SKILL.md first), not descending into sub-skills, which are listed as entries. No access check. */
export async function skillMembers(db: D1Database, folder: NodeRow): Promise<SkillMember[]> {
  const rows = await all<NodeRow>(
    db,
    'SELECT * FROM nodes WHERE path > ? AND path < ? AND deleted_at IS NULL LIMIT 5000',
    folder.path,
    folder.path.slice(0, -1) + '0',
  );
  const kids = new Map<string, NodeRow[]>();
  const skills = new Set<string>();
  for (const r of rows) {
    if (!r.parent_id) continue;
    kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r]);
    if (r.kind === 'doc' && r.name === SKILL_MD) skills.add(r.parent_id);
  }
  const out: SkillMember[] = [];
  const walk = (id: string, pre: string, via: string[]): void => {
    for (const c of kids.get(id) ?? []) {
      if (c.kind === 'folder') {
        if (skills.has(c.id)) out.push({ node: c, rel: pre + c.name, sub: true, via });
        else walk(c.id, pre + c.name + '/', [...via, c.id]);
      } else out.push({ node: c, rel: pre + c.name, sub: false, via });
    }
  };
  walk(folder.id, '', []);
  return out.sort(
    (a, b) =>
      (a.node.name === SKILL_MD && a.rel === SKILL_MD ? -1 : b.node.name === SKILL_MD && b.rel === SKILL_MD ? 1 : 0) ||
      (a.sub ? 1 : 0) - (b.sub ? 1 : 0) ||
      a.rel.localeCompare(b.rel),
  );
}

/** The skill members the caller can read, as output rows. */
export async function skillFiles(az: Authz, folder: NodeRow): Promise<SkillFileOutT[]> {
  const members = await skillMembers(az.db, folder);
  const via = [...new Set(members.flatMap((m) => m.via))];
  const viaRows = via.length ? await new DbTree(az.db).getMany(via) : new Map<string, NodeRow>();
  const roles = await az.roles([...members.map((m) => m.node), ...viaRows.values()]);
  const out: SkillFileOutT[] = [];
  for (const m of members) {
    const role = roles.get(m.node.id) ?? 0;
    if (role === 0 || m.via.some((id) => (roles.get(id) ?? 0) === 0)) continue;
    const n = m.node;
    out.push({
      id: n.id,
      path: m.rel,
      kind: m.sub ? 'skill' : isFileFormat(n.format) ? 'file' : 'markdown',
      format: n.kind === 'doc' ? n.format : null,
      published_version: n.kind === 'doc' ? n.published_version : null,
      head_version: n.kind === 'doc' && role >= 2 ? n.head_version : null,
    });
  }
  return out;
}
