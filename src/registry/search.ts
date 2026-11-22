import { z } from 'zod';
import { all, type NodeRow } from '../db/d1';
import { ftsQuery } from '../db/fts';
import type { Authz } from '../authz/authorize';
import { defineOp } from './types';
import { NodeOut, canonicalPaths, displayPaths, getNodesByIds, nodeOuts } from './shared';

export const SkillHit = z.object({
  id: z.string().describe('The skill folder. Pass it to get_skill.'),
  path: z.string(),
  canonical_path: z.string().nullable().describe('Path to use in [[links]]'),
  name: z.string(),
  description: z.string(),
  version: z.number().describe('Published version of SKILL.md'),
});
export type SkillHitT = z.infer<typeof SkillHit>;

interface FtsRow {
  doc_id: string;
  name: string;
  description: string;
  score: number;
  snip?: string;
}

/** Readable published skills ranked by BM25. Over-fetches 5x, then trims after authorization. */
export async function findSkills(az: Authz, task: string, limit: number): Promise<SkillHitT[]> {
  const q = ftsQuery(task);
  let rows: FtsRow[];
  if (q) {
    rows = await all<FtsRow>(
      az.db,
      'SELECT doc_id, name, description, bm25(skill_fts, 0, 10.0, 5.0, 1.0) AS score FROM skill_fts WHERE skill_fts MATCH ? ORDER BY score LIMIT ?',
      q,
      limit * 5,
    );
  } else {
    rows = await all<FtsRow>(az.db, 'SELECT doc_id, name, description, 0 AS score FROM skill_fts ORDER BY name LIMIT ?', limit * 5);
  }
  return filterHits(az, rows, limit);
}

/** skill_fts rows are SKILL.md documents; hits are their skill folders, filtered by authorization. */
async function filterHits(az: Authz, rows: FtsRow[], limit: number): Promise<SkillHitT[]> {
  const docs = (await getNodesByIds(az.db, rows.map((r) => r.doc_id))).filter((n) => n.deleted_at === null && n.published_version !== null && n.parent_id);
  const docById = new Map(docs.map((n) => [n.id, n]));
  const folders = (await getNodesByIds(az.db, [...new Set(docs.map((d) => d.parent_id!))])).filter((f) => f.deleted_at === null);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const roles = await az.roles([...docs, ...folders]);
  const keep = rows
    .filter((r) => {
      const d = docById.get(r.doc_id);
      return d && (roles.get(d.id) ?? 0) > 0 && (roles.get(d.parent_id!) ?? 0) > 0 && folderById.has(d.parent_id!);
    })
    .slice(0, limit);
  const keptFolders = keep.map((r) => folderById.get(docById.get(r.doc_id)!.parent_id!)!);
  const paths = await displayPaths(az, keptFolders);
  const canon = await canonicalPaths(az, keptFolders);
  return keep.map((r) => {
    const d = docById.get(r.doc_id)!;
    const f = folderById.get(d.parent_id!)!;
    return {
      id: f.id,
      path: paths.get(f.id)?.path ?? '',
      canonical_path: canon.get(f.id) ?? null,
      name: r.name,
      description: r.description,
      version: d.published_version!,
    };
  });
}

/** Catalog for the dynamic find_skills description: recently updated readable skills. */
export async function catalog(az: Authz, max: number): Promise<SkillHitT[]> {
  const rows = await all<FtsRow>(
    az.db,
    `SELECT f.doc_id, f.name, f.description, 0 AS score FROM skill_fts f JOIN nodes n ON n.id = f.doc_id
     WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 500`,
  );
  return filterHits(az, rows, max);
}

export const findSkillsOp = defineOp({
  name: 'find_skills',
  summary: 'Find published skills relevant to a task. Returns ranked skill folders you can read; then call get_skill with the id.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ task: z.string().max(500).describe('What you are trying to do, in a few words'), limit: z.number().int().min(1).max(25).default(8) }),
  output: z.object({ skills: z.array(SkillHit) }),
  rest: { method: 'GET', path: '/skills' },
  mcp: { tool: 'find_skills', readOnly: true },
  handler: async (ctx, input) => {
    ctx.audit.detail = { q: input.task.slice(0, 100) };
    const skills = await findSkills(ctx.az, input.task, input.limit);
    ctx.usage.shown = skills.map((s) => s.id);
    return { skills };
  },
});

export const search = defineOp({
  name: 'search',
  summary: 'Search folder and document names, published skills, and the content of published documents and files.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ q: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({ items: z.array(z.object({ node: NodeOut, match: z.enum(['name', 'content']), snippet: z.string().nullable() })) }),
  rest: { method: 'GET', path: '/search' },
  mcp: { tool: 'search', readOnly: true },
  handler: async (ctx, input) => {
    ctx.audit.detail = { q: input.q.slice(0, 100) };
    const like = '%' + input.q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const byName = await all<NodeRow>(
      ctx.db,
      "SELECT * FROM nodes WHERE deleted_at IS NULL AND lower(name) LIKE ? ESCAPE '\\' ORDER BY length(name), lower(name) LIMIT 200",
      like,
    );
    const q = ftsQuery(input.q);
    const skillHits = q
      ? await all<FtsRow>(
          ctx.db,
          "SELECT doc_id, name, description, bm25(skill_fts, 0, 10.0, 5.0, 1.0) AS score, snippet(skill_fts, 3, '', '', ' ... ', 16) AS snip FROM skill_fts WHERE skill_fts MATCH ? ORDER BY score LIMIT 100",
          q,
        )
      : [];
    const docHits = q
      ? await all<FtsRow>(
          ctx.db,
          "SELECT doc_id, name, '' AS description, bm25(doc_fts, 0, 5.0, 1.0) AS score, snippet(doc_fts, 2, '', '', ' ... ', 16) AS snip FROM doc_fts WHERE doc_fts MATCH ? ORDER BY score LIMIT 100",
          q,
        )
      : [];
    // A skill hit is shown as its skill folder.
    const skillDocs = await getNodesByIds(ctx.db, skillHits.map((h) => h.doc_id));
    const skillFolderOf = new Map(skillDocs.filter((d) => d.parent_id && d.deleted_at === null && d.published_version !== null).map((d) => [d.id, d.parent_id!]));
    const contentIds: string[] = [];
    const snip = new Map<string, string | null>();
    for (const h of [...skillHits, ...docHits].sort((a, b) => a.score - b.score)) {
      const id = skillFolderOf.get(h.doc_id) ?? (skillHits.includes(h) ? null : h.doc_id);
      if (!id || snip.has(id)) continue;
      contentIds.push(id);
      snip.set(id, h.snip ?? null);
    }
    const nameIds = new Set(byName.map((n) => n.id));
    const contentNodes = (await getNodesByIds(ctx.db, contentIds.filter((id) => !nameIds.has(id)))).filter(
      (n) => n.deleted_at === null && (n.kind === 'folder' || n.published_version !== null),
    );
    const order = new Map(contentIds.map((id, i) => [id, i]));
    contentNodes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const candidates = [...byName, ...contentNodes];
    const roles = await ctx.az.roles(candidates);
    const readable = candidates.filter((n) => (roles.get(n.id) ?? 0) > 0).slice(0, input.limit);
    const outs = await nodeOuts(ctx.az, readable, roles);
    ctx.usage.shown = outs.map((o) => o.id);
    return {
      items: outs.map((o) => ({
        node: o,
        match: nameIds.has(o.id) ? ('name' as const) : ('content' as const),
        snippet: nameIds.has(o.id) ? null : (snip.get(o.id) ?? null),
      })),
    };
  },
});
