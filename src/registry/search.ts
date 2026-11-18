import { z } from 'zod';
import { all, type NodeRow } from '../db/d1';
import { ftsQuery } from '../db/fts';
import type { Authz } from '../authz/authorize';
import { defineOp } from './types';
import { NodeOut, displayPaths, getNodesByIds, nodeOuts } from './shared';

export const SkillHit = z.object({ id: z.string(), path: z.string(), name: z.string(), description: z.string(), version: z.number() });
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

async function filterHits(az: Authz, rows: FtsRow[], limit: number): Promise<SkillHitT[]> {
  const nodes = (await getNodesByIds(az.db, rows.map((r) => r.doc_id))).filter((n) => n.deleted_at === null && n.published_version !== null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roles = await az.roles(nodes);
  const keep = rows.filter((r) => (roles.get(r.doc_id) ?? 0) > 0).slice(0, limit);
  const keptNodes = keep.map((r) => byId.get(r.doc_id)!).filter(Boolean);
  const paths = await displayPaths(az, keptNodes);
  return keep
    .filter((r) => byId.has(r.doc_id))
    .map((r) => ({
      id: r.doc_id,
      path: paths.get(r.doc_id)?.path ?? '',
      name: r.name,
      description: r.description,
      version: byId.get(r.doc_id)!.published_version!,
    }));
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
  summary: 'Find published skills relevant to a task. Returns ranked skills you can read; then call get_skill.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ task: z.string().max(500).describe('What you are trying to do, in a few words'), limit: z.number().int().min(1).max(25).default(8) }),
  output: z.object({ skills: z.array(SkillHit) }),
  rest: { method: 'GET', path: '/skills' },
  mcp: { tool: 'find_skills', readOnly: true },
  handler: async (ctx, input) => {
    ctx.audit.detail = { q: input.task.slice(0, 100) };
    return { skills: await findSkills(ctx.az, input.task, input.limit) };
  },
});

export const search = defineOp({
  name: 'search',
  summary: 'Search folder and document names, and published skill content.',
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
    const fts = q
      ? await all<FtsRow>(
          ctx.db,
          "SELECT doc_id, name, description, bm25(skill_fts, 0, 10.0, 5.0, 1.0) AS score, snippet(skill_fts, 3, '', '', ' ... ', 16) AS snip FROM skill_fts WHERE skill_fts MATCH ? ORDER BY score LIMIT 100",
          q,
        )
      : [];
    const ftsNodes = await getNodesByIds(ctx.db, fts.map((f) => f.doc_id).filter((id) => !byName.some((n) => n.id === id)));
    const candidates = [...byName, ...ftsNodes.filter((n) => n.deleted_at === null && n.published_version !== null)];
    const roles = await ctx.az.roles(candidates);
    const readable = candidates.filter((n) => (roles.get(n.id) ?? 0) > 0).slice(0, input.limit);
    const outs = await nodeOuts(ctx.az, readable, roles);
    const snip = new Map(fts.map((f) => [f.doc_id, f.snip ?? null]));
    const nameIds = new Set(byName.map((n) => n.id));
    return {
      items: outs.map((o) => ({ node: o, match: nameIds.has(o.id) ? ('name' as const) : ('content' as const), snippet: nameIds.has(o.id) ? null : (snip.get(o.id) ?? null) })),
    };
  },
});
