import { z } from 'zod';
import { all, type NodeRow } from '../db/d1';
import { dayKeys } from '../db/usage';
import { AREA_IDS, SKILL_MD, areaOfPath } from '../lib/areas';
import { defineOp } from './types';
import { canonicalPaths, displayPaths } from './shared';

const UsageItem = z.object({
  id: z.string().describe('The skill folder or the document'),
  kind: z.enum(['skill', 'doc']),
  name: z.string(),
  path: z.string(),
  canonical_path: z.string().nullable(),
  loads: z.number().describe('get_skill calls by agents on the published version'),
  shown: z.number().describe('Times it came back from find_skills or search'),
  people: z.number().describe('Distinct people whose agents loaded it'),
  last_load_at: z.number().nullable(),
  daily: z.array(z.number()).describe('Loads per UTC day, oldest first, one entry per day of the range'),
  links_in: z.number().describe('Published documents outside it that link to it'),
});

/**
 * Published skills and documentation pages with what agents did with them: loads, times shown in results,
 * people, and incoming links. Rules are left out: every agent receives them on connect.
 */
export const getUsage = defineOp({
  name: 'get_usage',
  summary:
    'How agents use the library over the last N days: per published skill and documentation page, loads, times shown in find_skills or search results, distinct people and incoming links. Rules are not listed (every agent gets them on connect).',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ days: z.number().int().min(1).max(90).default(30).describe('Range in days, ending today (UTC)') }),
  output: z.object({
    days: z.array(z.string()).describe('The UTC days of the range, oldest first'),
    totals: z.object({ loads: z.number(), shown: z.number(), people: z.number() }),
    items: z.array(UsageItem),
  }),
  rest: { method: 'GET', path: '/usage' },
  mcp: { tool: 'get_usage', readOnly: true },
  handler: async (ctx, input) => {
    const days = dayKeys(input.days);
    const index = new Map(days.map((d, i) => [d, i]));

    // Candidates: skill folders with a published SKILL.md, and published documentation pages.
    const folders = await all<NodeRow>(
      ctx.db,
      `SELECT f.* FROM nodes f JOIN nodes m ON m.parent_id = f.id AND m.name = ? AND m.kind = 'doc' AND m.deleted_at IS NULL AND m.published_version IS NOT NULL
       WHERE f.kind = 'folder' AND f.deleted_at IS NULL`,
      SKILL_MD,
    );
    const docs = await all<NodeRow>(
      ctx.db,
      "SELECT * FROM nodes WHERE kind = 'doc' AND deleted_at IS NULL AND published_version IS NOT NULL AND path LIKE ?",
      `/${AREA_IDS.documentation}/%`,
    );
    const nodes = [...folders.filter((f) => areaOfPath(f.path) !== 'rules'), ...docs];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    type Acc = { loads: number; shown: number; people: Set<string>; last: number | null; daily: number[] };
    const acc = new Map<string, Acc>(nodes.map((n) => [n.id, { loads: 0, shown: 0, people: new Set(), last: null, daily: days.map(() => 0) }]));
    const rows = await all<{ day: string; node_id: string; actor_id: string; loads: number; shown: number; last_load_at: number | null }>(
      ctx.db,
      'SELECT day, node_id, actor_id, loads, shown, last_load_at FROM usage_daily WHERE day >= ?',
      days[0],
    );
    const everyone = new Set<string>();
    let loads = 0;
    let shown = 0;
    for (const r of rows) {
      const a = acc.get(r.node_id);
      const i = index.get(r.day);
      if (!a || i === undefined) continue;
      a.loads += r.loads;
      a.shown += r.shown;
      a.daily[i]! += r.loads;
      if (r.loads > 0) {
        a.people.add(r.actor_id);
        everyone.add(r.actor_id);
      }
      if (r.last_load_at !== null && (a.last === null || r.last_load_at > a.last)) a.last = r.last_load_at;
      loads += r.loads;
      shown += r.shown;
    }

    // Incoming published links from outside the node itself (a skill's own files do not count).
    const links = await all<{ to_node: string; from_path: string }>(
      ctx.db,
      `SELECT DISTINCT l.to_node, f.path AS from_path FROM links l JOIN nodes f ON f.id = l.from_node
       WHERE l.kind = 'published' AND l.to_node IS NOT NULL AND f.deleted_at IS NULL AND f.published_version IS NOT NULL`,
    );
    const linksIn = new Map<string, number>();
    for (const l of links) {
      const target = byId.get(l.to_node);
      if (!target || l.from_path === target.path || l.from_path.startsWith(target.path + '/')) continue;
      linksIn.set(target.id, (linksIn.get(target.id) ?? 0) + 1);
    }

    const paths = await displayPaths(ctx.az, nodes);
    const canon = await canonicalPaths(ctx.az, nodes);
    return {
      days,
      totals: { loads, shown, people: everyone.size },
      items: nodes.map((n) => {
        const a = acc.get(n.id)!;
        return {
          id: n.id,
          kind: n.kind === 'folder' ? ('skill' as const) : ('doc' as const),
          name: n.name,
          path: paths.get(n.id)?.path ?? '/' + n.name,
          canonical_path: canon.get(n.id) ?? null,
          loads: a.loads,
          shown: a.shown,
          people: a.people.size,
          last_load_at: a.last,
          daily: a.daily,
          links_in: linksIn.get(n.id) ?? 0,
        };
      }),
    };
  },
});
