import { z } from 'zod';
import type { Env } from '../env';
import { Authz, type Actor, type Requirement } from '../authz/authorize';
import { auditStmt } from '../db/audit';
import { usageStmts } from '../db/usage';
import type { NodeRow } from '../db/d1';
import { AppError } from '../lib/errors';
import type { AnyOp, OpContext } from './types';
import { resolveRef } from './shared';

export interface RunEnv {
  env: Env;
  actor: Actor;
  az?: Authz;
  waitUntil: (p: Promise<unknown>) => void;
}

function requirement(op: AnyOp): Requirement {
  const t = op.target;
  switch (t.kind) {
    case 'node':
      return { scope: op.scope, kind: 'node', minRole: t.minRole };
    case 'org':
      return { scope: op.scope, kind: 'org', orgRole: 'owner' };
    case 'team':
      return { scope: op.scope, kind: 'team', allowMaintainer: t.allowMaintainer };
    case 'user':
      return { scope: op.scope, kind: 'user' };
  }
}

export function zodIssues(e: z.ZodError): Record<string, unknown> {
  return { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
}

/**
 * Runs one registry operation: validate input, resolve target, authorize, handle, validate output, audit.
 * Every call writes exactly one audit row, success or failure. Successful MCP calls also record usage.
 */
export async function runOp(op: AnyOp, raw: unknown, rt: RunEnv): Promise<unknown> {
  const az = rt.az ?? new Authz(rt.env.DB, rt.actor);
  const ctx: OpContext = {
    env: rt.env,
    db: rt.env.DB,
    az,
    actor: rt.actor,
    node: null,
    role: 0,
    audit: {},
    usage: {},
    waitUntil: rt.waitUntil,
  };
  let ok = false;
  let errCode: string | null = null;
  try {
    const parsed = op.input.safeParse(raw ?? {});
    if (!parsed.success) throw new AppError('invalid', 'Invalid input', zodIssues(parsed.error));
    const input = parsed.data as Record<string, unknown>;

    let node: NodeRow | null = null;
    let teamId: string | null = null;
    const t = op.target;
    if (t.kind === 'node') {
      const ref = input[t.field];
      if (ref === undefined || ref === null || ref === '' || ref === '/') {
        if (!t.nullable) throw new AppError('invalid', `"${t.field}" is required`);
      } else {
        node = await resolveRef(az, String(ref), t.deleted ? { deleted: true } : {});
        if (!node) throw new AppError('not_found', 'Not found');
        ctx.audit.nodeId = node.id;
      }
    } else if (t.kind === 'team') {
      teamId = typeof input[t.field] === 'string' ? (input[t.field] as string) : null;
    }

    const req = t.kind === 'node' && !node && t.nullable === 'any' ? ({ scope: op.scope, kind: 'user' } as const) : requirement(op);
    ctx.role = await az.authorize(req, { node, teamId });
    if (t.kind === 'node' && node && t.nodeKind && node.kind !== t.nodeKind) {
      throw new AppError('invalid', `Expected a ${t.nodeKind}`);
    }
    ctx.node = node;

    const result = await op.handler(ctx, input);
    const out = op.output.parse(result);
    ok = true;
    return out;
  } catch (e) {
    if (e instanceof AppError) {
      errCode = e.code;
      throw e;
    }
    if (e instanceof z.ZodError) {
      errCode = 'internal';
      console.error(JSON.stringify({ level: 'error', op: op.name, msg: 'output validation failed', issues: e.issues.length }));
      throw new AppError('internal', 'Output validation failed');
    }
    errCode = 'internal';
    console.error(JSON.stringify({ level: 'error', op: op.name, msg: e instanceof Error ? e.message : String(e) }));
    throw new AppError('internal', 'Internal error');
  } finally {
    const detail = { ...(ctx.audit.detail ?? {}), ...(errCode ? { error: errCode } : {}) };
    const write = auditStmt(rt.env.DB, {
      actorId: rt.actor.user.id,
      via: rt.actor.via,
      client: rt.actor.client,
      op: op.name,
      nodeId: ctx.audit.nodeId ?? null,
      version: ctx.audit.version ?? null,
      ok,
      detail: Object.keys(detail).length ? detail : null,
    });
    const usage = ok && rt.actor.via === 'mcp' ? usageStmts(rt.env.DB, rt.actor.user.id, ctx.usage) : [];
    const done = usage.length ? rt.env.DB.batch([write, ...usage]) : write.run();
    await done.catch((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', err: String(err) })));
  }
}
