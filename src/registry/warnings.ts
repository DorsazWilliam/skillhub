import { z } from 'zod';
import { one, run, type NodeRow } from '../db/d1';
import { DbTree } from '../db/tree';
import { ROLE } from '../authz/roles';
import { notFound } from '../lib/errors';
import type { OpContext } from './types';
import { defineOp } from './types';
import { NodeRef } from './shared';
import { WarningOut, lintNode, partitionWarnings, versionContent, workingContent } from './content';

/** Authoring warnings are for editors only: readers never see them (get_skill and reads carry none). */

const Which = z.union([z.number().int().positive(), z.enum(['latest', 'draft', 'published'])]);

const WarningsOut = z.object({
  node: z.string(),
  version: z.union([z.number(), z.literal('draft')]).nullable().describe('What was checked: a version, the draft, or null for a folder or an empty document'),
  warnings: z.array(WarningOut).describe('Active warnings'),
  dismissed: z.array(WarningOut).describe('Warnings that apply but were dismissed'),
});

async function check(ctx: OpContext, node: NodeRow, which: z.infer<typeof Which>): Promise<z.infer<typeof WarningsOut>> {
  let content = '';
  let version: number | 'draft' | null = null;
  if (node.kind === 'doc') {
    if (which === 'latest') {
      const d = await one<{ content: string }>(ctx.db, 'SELECT content FROM drafts WHERE doc_id = ?', node.id);
      if (d) {
        content = d.content;
        version = 'draft';
      } else {
        content = (await workingContent(ctx.db, node)) ?? '';
        version = node.head_version || null;
      }
    } else if (which === 'draft') {
      const d = await one<{ content: string }>(ctx.db, 'SELECT content FROM drafts WHERE doc_id = ?', node.id);
      if (!d) throw notFound('No draft');
      content = d.content;
      version = 'draft';
    } else {
      const n = which === 'published' ? node.published_version : which;
      const c = await versionContent(ctx.db, node.id, n);
      if (c === null) throw notFound('Version not found');
      content = c;
      version = n;
    }
  }
  const all = await lintNode(ctx.az, new DbTree(ctx.db), node, content);
  return { node: node.id, version, ...(await partitionWarnings(ctx.db, node.id, all)) };
}

export const getWarnings = defineOp({
  name: 'get_warnings',
  summary: 'Authoring warnings for a document (or the rules area) against the guidelines, with the ones that were dismissed. Warnings never block a save.',
  scope: 'write',
  target: { kind: 'node', field: 'node', minRole: ROLE.editor },
  input: z.object({ node: NodeRef, version: Which.default('latest').describe('"latest" = the draft if any, else the newest version') }),
  output: WarningsOut,
  rest: { method: 'GET', path: '/nodes/{node}/warnings' },
  mcp: { tool: 'get_warnings', readOnly: true },
  handler: async (ctx, input) => check(ctx, ctx.node!, input.version),
});

export const dismissWarning = defineOp({
  name: 'dismiss_warning',
  summary: 'Dismiss one warning on a node by its key. It stays dismissed across new versions until the flagged text changes. Creates no version.',
  scope: 'write',
  target: { kind: 'node', field: 'node', minRole: ROLE.editor },
  input: z.object({ node: NodeRef, key: z.string().min(3).max(2000).describe('The warning key, as returned') }),
  output: WarningsOut,
  rest: { method: 'POST', path: '/nodes/{node}/warnings/dismiss' },
  mcp: { tool: 'dismiss_warning' },
  handler: async (ctx, input) => {
    await run(
      ctx.db,
      'INSERT INTO lint_dismissals (node_id, key, dismissed_by, dismissed_at) VALUES (?,?,?,?) ON CONFLICT(node_id, key) DO UPDATE SET dismissed_by = excluded.dismissed_by, dismissed_at = excluded.dismissed_at',
      ctx.node!.id,
      input.key,
      ctx.actor.user.id,
      Date.now(),
    );
    ctx.audit.detail = { code: input.key.split('|')[0] };
    return check(ctx, ctx.node!, 'latest');
  },
});

export const restoreWarnings = defineOp({
  name: 'restore_warnings',
  summary: 'Bring back every dismissed warning on a node.',
  scope: 'write',
  target: { kind: 'node', field: 'node', minRole: ROLE.editor },
  input: z.object({ node: NodeRef }),
  output: WarningsOut.extend({ restored: z.number() }),
  rest: { method: 'POST', path: '/nodes/{node}/warnings/restore' },
  mcp: { tool: 'restore_warnings' },
  handler: async (ctx) => {
    const res = await run(ctx.db, 'DELETE FROM lint_dismissals WHERE node_id = ?', ctx.node!.id);
    const restored = res.meta.changes ?? 0;
    ctx.audit.detail = { restored };
    return { ...(await check(ctx, ctx.node!, 'latest')), restored };
  },
});
