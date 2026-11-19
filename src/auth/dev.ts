import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { one, stmt, type UserRow } from '../db/d1';
import { auditStmt } from '../db/audit';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ulid';
import { errorResponse, type AppEnv } from '../http/context';
import { createSession } from './session';

/**
 * DEV-ONLY sign-in for the local stack, where Entra cannot run without a tenant.
 * Enabled only when DEV_LOGIN is "true" (set in .dev.vars, never in wrangler.jsonc) AND BASE_URL points at
 * localhost or 127.0.0.1. Anywhere else every route answers 404, exactly as if it did not exist.
 */
export const DEV_TID = 'dev-local';

export const DEV_USERS = {
  owner: { name: 'Alice Chen', email: 'alice.chen@acme.com', oid: 'dev-owner', role: 'owner' },
  publisher: { name: 'Marcus Webb', email: 'marcus.webb@acme.com', oid: 'dev-publisher', role: 'member' },
  viewer: { name: 'Tom Becker', email: 'tom.becker@acme.com', oid: 'dev-viewer', role: 'member' },
} as const;
export type DevKey = keyof typeof DEV_USERS;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function devLoginEnabled(env: Pick<Env, 'DEV_LOGIN' | 'BASE_URL'>): boolean {
  if (env.DEV_LOGIN !== 'true') return false;
  try {
    return LOCAL_HOSTS.has(new URL(env.BASE_URL).hostname);
  } catch {
    return false;
  }
}

const Input = z.object({ as: z.enum(['owner', 'publisher', 'viewer']) });

async function devUser(db: D1Database, key: DevKey): Promise<UserRow> {
  const d = DEV_USERS[key];
  const now = Date.now();
  const existing = await one<UserRow>(db, 'SELECT * FROM users WHERE tid = ? AND oid = ?', DEV_TID, d.oid);
  if (existing) {
    if (existing.status !== 'active') throw new AppError('forbidden', 'This account is suspended');
    await stmt(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', now, existing.id).run();
    return { ...existing, last_login_at: now };
  }
  await stmt(
    db,
    'INSERT INTO users (id, tid, oid, email, name, org_role, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tid, oid) DO NOTHING',
    ulid(),
    DEV_TID,
    d.oid,
    d.email,
    d.name,
    d.role,
    'active',
    now,
    now,
  ).run();
  const row = await one<UserRow>(db, 'SELECT * FROM users WHERE tid = ? AND oid = ?', DEV_TID, d.oid);
  if (!row) throw new AppError('internal', 'Could not create the dev user');
  return row;
}

export function devApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const off = (): Response => Response.json({ error: { code: 'not_found', message: 'No such endpoint' } }, { status: 404 });

  app.get('/auth/dev-login', (c) => {
    if (!devLoginEnabled(c.env)) return off();
    const users = (Object.keys(DEV_USERS) as DevKey[]).map((key) => ({ key, name: DEV_USERS[key].name, email: DEV_USERS[key].email, role: key }));
    return c.json({ enabled: true, users }, 200, { 'cache-control': 'no-store' });
  });

  app.post('/auth/dev-login', async (c) => {
    if (!devLoginEnabled(c.env)) return off();
    try {
      if (c.req.header('x-skillhub-csrf') !== '1') throw new AppError('forbidden', 'Missing CSRF header');
      if (c.req.header('origin') !== new URL(c.env.BASE_URL).origin) throw new AppError('forbidden', 'Cross-origin request blocked');
      const parsed = Input.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('invalid', 'Pick owner, publisher or viewer');
      const user = await devUser(c.env.DB, parsed.data.as);
      const session = await createSession(c.env.DB, user.id);
      await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'login', nodeId: null, version: null, ok: true, detail: { dev: true } }).run();
      return c.json({ ok: true }, 200, { 'set-cookie': session.setCookie, 'cache-control': 'no-store' });
    } catch (e) {
      return errorResponse(e);
    }
  });

  return app;
}
