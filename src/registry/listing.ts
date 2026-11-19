import { z } from 'zod';
import { all, qs, type NodeRow } from '../db/d1';
import { DbTree } from '../db/tree';
import type { Authz } from '../authz/authorize';
import { ROLE } from '../authz/roles';
import { SKILL_MD } from '../lib/areas';
import { splitFrontmatter } from '../lib/frontmatter';
import { NodeOut, type NodeOutT } from './shared';
import { skillMembers } from './content';

/**
 * Extras that list_children adds to each item so a folder listing can show what the prototype shows
 * (skill description, file count, aggregate publish state, last author, link count, child count)
 * without one read per row. Role-aware: viewers only ever see published data.
 */
export const SkillSummary = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  version: z.number().nullable().describe('Editors: head version of SKILL.md. Viewers: published version'),
  files: z.number().describe('Entries of the skill you can read: its files plus one per direct sub-skill'),
  state: z.enum(['published', 'pending', 'draft', 'unpublished']).nullable().describe('Editors only: draft in progress, never published, files waiting to publish, or up to date'),
  pending: z.number().describe('Files whose newest version is not published (editors only)'),
});

export const ListItemOut = NodeOut.extend({
  skill: SkillSummary.nullable().optional().describe('Skill folders only'),
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable().optional().describe('Documents: who wrote the content you see last'),
  links: z.number().optional().describe('Documents: distinct outgoing [[links]]'),
  children: z.number().optional().describe('Plain folders: readable children'),
});
export type ListItemOutT = z.infer<typeof ListItemOut>;

function chunks<T>(xs: T[], n = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function draftsOf(db: D1Database, ids: string[]): Promise<Map<string, { updated_by: string; content: string }>> {
  const out = new Map<string, { updated_by: string; content: string }>();
  for (const part of chunks(ids)) {
    for (const r of await all<{ doc_id: string; updated_by: string; content: string }>(db, `SELECT doc_id, updated_by, content FROM drafts WHERE doc_id IN (${qs(part.length)})`, ...part)) {
      out.set(r.doc_id, r);
    }
  }
  return out;
}

function fmOf(content: string | null | undefined): { name: string | null; description: string | null } {
  if (!content) return { name: null, description: null };
  try {
    const fm = splitFrontmatter(content).frontmatter;
    return {
      name: typeof fm?.['name'] === 'string' ? (fm['name'] as string) : null,
      description: typeof fm?.['description'] === 'string' ? (fm['description'] as string) : null,
    };
  } catch {
    return { name: null, description: null };
  }
}

export async function listExtras(az: Authz, rows: NodeRow[], outs: NodeOutT[], roles: Map<string, number>): Promise<ListItemOutT[]> {
  const db = az.db;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: ListItemOutT[] = outs.map((o) => ({ ...o }));
  const at = new Map(result.map((o) => [o.id, o]));

  // ---- documents: author and link count ----
  const docs = rows.filter((r) => r.kind === 'doc');
  if (docs.length) {
    const editorIds = docs.filter((d) => (roles.get(d.id) ?? 0) >= ROLE.editor).map((d) => d.id);
    const drafts = await draftsOf(db, editorIds);
    const want = new Map<string, number>();
    for (const d of docs) {
      const editor = (roles.get(d.id) ?? 0) >= ROLE.editor;
      if (editor && drafts.has(d.id)) continue;
      const n = editor ? d.head_version : d.published_version;
      if (n) want.set(d.id, n);
    }
    const authors = new Map<string, string>();
    for (const part of chunks([...want.keys()])) {
      for (const v of await all<{ doc_id: string; n: number; author_id: string }>(db, `SELECT doc_id, n, author_id FROM doc_versions WHERE doc_id IN (${qs(part.length)})`, ...part)) {
        if (want.get(v.doc_id) === v.n) authors.set(v.doc_id, v.author_id);
      }
    }
    for (const [id, d] of drafts) authors.set(id, d.updated_by);
    const userIds = [...new Set(authors.values())];
    const names = new Map<string, string | null>();
    for (const part of chunks(userIds)) {
      for (const u of await all<{ id: string; name: string | null }>(db, `SELECT id, name FROM users WHERE id IN (${qs(part.length)})`, ...part)) names.set(u.id, u.name);
    }
    const linkCounts = new Map<string, { draft: number; published: number }>();
    const ids = docs.map((d) => d.id);
    for (const part of chunks(ids)) {
      for (const r of await all<{ from_node: string; kind: 'draft' | 'published'; c: number }>(
        db,
        `SELECT from_node, kind, COUNT(*) AS c FROM links WHERE from_node IN (${qs(part.length)}) GROUP BY from_node, kind`,
        ...part,
      )) {
        const e = linkCounts.get(r.from_node) ?? { draft: 0, published: 0 };
        e[r.kind] = r.c;
        linkCounts.set(r.from_node, e);
      }
    }
    for (const d of docs) {
      const o = at.get(d.id);
      if (!o) continue;
      const a = authors.get(d.id);
      o.author = a ? { id: a, name: names.get(a) ?? null } : null;
      const lc = linkCounts.get(d.id);
      o.links = lc ? ((roles.get(d.id) ?? 0) >= ROLE.editor ? lc.draft : lc.published) : 0;
    }
  }

  // ---- folders ----
  const folders = rows.filter((r) => r.kind === 'folder');
  const skillIds = new Set(result.filter((o) => o.kind === 'folder' && o.is_skill).map((o) => o.id));
  const plain = folders.filter((f) => !skillIds.has(f.id));
  if (plain.length) {
    const kids: NodeRow[] = [];
    for (const part of chunks(plain.map((f) => f.id))) {
      kids.push(...(await all<NodeRow>(db, `SELECT * FROM nodes WHERE parent_id IN (${qs(part.length)}) AND deleted_at IS NULL`, ...part)));
    }
    const kr = await az.roles(kids);
    const count = new Map<string, number>();
    for (const k of kids) if ((kr.get(k.id) ?? 0) > 0) count.set(k.parent_id!, (count.get(k.parent_id!) ?? 0) + 1);
    for (const f of plain) {
      const o = at.get(f.id);
      if (o) o.children = count.get(f.id) ?? 0;
    }
  }

  for (const id of skillIds) {
    const f = byId.get(id);
    const o = at.get(id);
    if (!f || !o) continue;
    const members = await skillMembers(db, f);
    const via = [...new Set(members.flatMap((m) => m.via))];
    const viaRows = via.length ? [...(await new DbTree(db).getMany(via)).values()] : [];
    const mr = await az.roles([...members.map((m) => m.node), ...viaRows]);
    const readable = members.filter((m) => (mr.get(m.node.id) ?? 0) > 0 && m.via.every((v) => (mr.get(v) ?? 0) > 0));
    const md = members.find((m) => !m.sub && m.rel === SKILL_MD)?.node ?? null;
    const role = md ? (mr.get(md.id) ?? 0) : (roles.get(id) ?? 0);
    const editor = role >= ROLE.editor;
    const fileDocs = readable.filter((m) => !m.sub && m.node.kind === 'doc').map((m) => m.node);
    const drafts = editor ? await draftsOf(db, fileDocs.map((d) => d.id)) : new Map<string, { updated_by: string; content: string }>();
    let content: string | null = null;
    if (md) {
      if (editor && drafts.has(md.id)) content = drafts.get(md.id)!.content;
      else {
        const n = editor ? md.head_version || null : md.published_version;
        if (n) content = (await all<{ content: string }>(db, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', md.id, n))[0]?.content ?? null;
      }
    }
    const pending = editor ? fileDocs.filter((d) => d.head_version > (d.published_version ?? 0)).length : 0;
    let state: 'published' | 'pending' | 'draft' | 'unpublished' | null = null;
    if (editor) {
      if (fileDocs.some((d) => drafts.has(d.id))) state = 'draft';
      else if (!md?.published_version) state = 'unpublished';
      else if (pending) state = 'pending';
      else state = 'published';
    }
    o.skill = {
      ...fmOf(content),
      version: md ? (editor ? md.head_version || null : md.published_version) : null,
      files: readable.length,
      state,
      pending,
    };
  }
  return result;
}
