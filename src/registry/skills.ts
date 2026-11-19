import { z } from 'zod';
import { all, qs, stmt, type NodeRow } from '../db/d1';
import { DbTree } from '../db/tree';
import type { Authz } from '../authz/authorize';
import { ROLE } from '../authz/roles';
import { AREA_IDS } from '../lib/areas';
import { splitFrontmatter } from '../lib/frontmatter';
import { RULES_CAP } from '../lib/lint';
import { invalid } from '../lib/errors';
import { defineOp } from './types';
import { NodeRef } from './shared';
import { WarningOut, activeWarnings, skillMembers } from './content';
import { publishStmts } from './docs';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

// ---------- publish a skill folder ----------

const FileResult = z.object({
  id: z.string(),
  path: z.string().describe('Path inside the skill folder'),
  status: z.enum(['published', 'unchanged', 'empty', 'forbidden']).describe('empty: no committed version yet. forbidden: you cannot publish this file.'),
  from: z.number().nullable().describe('Published version before'),
  to: z.number().nullable().describe('Published version after'),
  has_draft: z.boolean().describe('Uncommitted changes exist: they are not published'),
  warnings: z.array(WarningOut),
});

export const publishSkill = defineOp({
  name: 'publish_skill',
  summary:
    'Publish a whole skill at once: the latest committed version of every changed file in the skill folder (not nested sub-skills), atomically. Commit drafts first. Returns per-file results.',
  scope: 'publish',
  target: { kind: 'node', field: 'skill', minRole: ROLE.publisher, nodeKind: 'folder' },
  input: z.object({ skill: NodeRef.describe('The skill folder, by id, display path or canonical path like skills/code-review') }),
  output: z.object({ skill: z.string(), published: z.number(), files: z.array(FileResult) }),
  rest: { method: 'POST', path: '/skills/{skill}/publish' },
  mcp: { tool: 'publish_skill' },
  handler: async (ctx) => {
    const folder = ctx.node!;
    const tree = new DbTree(ctx.db);
    if (!(await tree.skillMd(folder.id))) throw invalid('This folder is not a skill (it has no SKILL.md)');
    const members = (await skillMembers(ctx.db, folder)).filter((m) => !m.sub && m.node.kind === 'doc');
    const via = [...new Set(members.flatMap((m) => m.via))];
    const viaRows = [...(await tree.getMany(via)).values()];
    const roles = await ctx.az.roles([...members.map((m) => m.node), ...viaRows]);
    const visible = members.filter((m) => (roles.get(m.node.id) ?? 0) > 0 && m.via.every((id) => (roles.get(id) ?? 0) > 0));

    const ids = visible.map((m) => m.node.id);
    const drafts = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      for (const r of await all<{ doc_id: string }>(ctx.db, `SELECT doc_id FROM drafts WHERE doc_id IN (${qs(part.length)})`, ...part)) drafts.add(r.doc_id);
    }

    type Row = z.infer<typeof FileResult>;
    const results: Row[] = [];
    const todo: { node: NodeRow; row: Row }[] = [];
    for (const m of visible) {
      const n = m.node;
      const row: Row = { id: n.id, path: m.rel, status: 'unchanged', from: n.published_version, to: n.published_version, has_draft: drafts.has(n.id), warnings: [] };
      if ((roles.get(n.id) ?? 0) < ROLE.publisher) row.status = 'forbidden';
      else if (n.head_version === 0) row.status = 'empty';
      else if (n.head_version > (n.published_version ?? 0)) {
        row.status = 'published';
        row.to = n.head_version;
        todo.push({ node: n, row });
      }
      results.push(row);
    }

    const contents = new Map<string, string>();
    for (const t of todo) {
      const v = await all<{ content: string }>(ctx.db, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', t.node.id, t.node.head_version);
      contents.set(t.node.id, v[0]?.content ?? '');
    }
    const stmts: D1PreparedStatement[] = [];
    for (const t of todo) stmts.push(...(await publishStmts(ctx.db, tree, t.node, { n: t.node.head_version, content: contents.get(t.node.id)! })));
    if (stmts.length) {
      // One batch: every file of the skill is published, or none is.
      stmts.push(stmt(ctx.db, 'UPDATE nodes SET updated_at = ? WHERE id = ?', Date.now(), folder.id));
      await ctx.db.batch(stmts);
    }
    ctx.az.reset();
    for (const t of todo) {
      t.row.warnings = await activeWarnings(ctx.az, tree, { ...t.node, published_version: t.node.head_version }, contents.get(t.node.id)!);
    }
    ctx.audit.detail = { files: todo.map((t) => ({ id: t.node.id, from: t.row.from, to: t.row.to })) };
    return { skill: folder.id, published: todo.length, files: results };
  },
});

// ---------- rules ----------

export const MORE_RULES = 'More rules exist than fit here. List them with list_children on rules and read each one with get_skill.';

export interface RulesBundle {
  text: string;
  total_bytes: number;
  sent_bytes: number;
  truncated: boolean;
  rules: { id: string; name: string; bytes: number; included: boolean }[];
}

/**
 * Published rules the caller can read, ordered by name, concatenated for the MCP `instructions`.
 * Whole rules only, capped at 8 KB including the final line that says more rules exist.
 */
export async function rulesBundle(az: Authz): Promise<RulesBundle> {
  const rows = await all<NodeRow & { content: string }>(
    az.db,
    `SELECT n.*, v.content AS content FROM nodes n JOIN doc_versions v ON v.doc_id = n.id AND v.n = n.published_version
     WHERE n.parent_id = ? AND n.kind = 'doc' AND n.deleted_at IS NULL ORDER BY lower(n.name), n.id`,
    AREA_IDS.rules,
  );
  const roles = await az.roles(rows);
  const readable = rows.filter((r) => (roles.get(r.id) ?? 0) > 0);
  const tail = bytes('\n\n' + MORE_RULES);
  let text = '';
  let truncated = false;
  const rules: RulesBundle['rules'] = [];
  for (const r of readable) {
    let body = r.content;
    try {
      body = splitFrontmatter(r.content).body;
    } catch {
      body = r.content;
    }
    body = body.trim();
    const next = text ? text + '\n\n' + body : body;
    const fits = !truncated && body.length > 0 && bytes(next) + tail <= RULES_CAP;
    if (fits) text = next;
    else if (body.length > 0) truncated = true;
    rules.push({ id: r.id, name: r.name, bytes: bytes(r.content), included: fits });
  }
  // Close with the line that tells the agent more rules exist.
  if (truncated) text = text ? text + '\n\n' + MORE_RULES : MORE_RULES;
  return { text, total_bytes: rules.reduce((s, r) => s + r.bytes, 0), sent_bytes: bytes(text), truncated, rules };
}

export const getRulesSize = defineOp({
  name: 'get_rules_size',
  summary: 'Size of the published rules you can read, against the 8 KB that agents receive as instructions when they connect.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({}),
  output: z.object({
    total_bytes: z.number().describe('All published rules you can read'),
    cap_bytes: z.number(),
    sent_bytes: z.number().describe('What is sent to an agent connecting as you'),
    truncated: z.boolean(),
    rules: z.array(z.object({ id: z.string(), name: z.string(), bytes: z.number(), included: z.boolean() })),
  }),
  rest: { method: 'GET', path: '/rules/size' },
  mcp: { tool: 'get_rules_size', readOnly: true },
  handler: async (ctx) => {
    const b = await rulesBundle(ctx.az);
    return { total_bytes: b.total_bytes, cap_bytes: RULES_CAP, sent_bytes: b.sent_bytes, truncated: b.truncated, rules: b.rules };
  },
});
