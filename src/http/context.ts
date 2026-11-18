import type { Context } from 'hono';
import type { Env } from '../env';
import type { Actor } from '../authz/authorize';
import { ALL_SCOPES } from '../authz/scopes';
import { lookupSession, readCookie, SESSION_COOKIE } from '../auth/session';
import { verifyToken } from '../auth/tokens';
import { AppError } from '../lib/errors';

export type AppEnv = { Bindings: Env; Variables: { actor: Actor | null } };
export type Ctx = Context<AppEnv>;

/** Resolves the caller from a PAT bearer token or the session cookie. Suspended users are rejected. */
export async function resolveActor(c: Ctx): Promise<Actor | null> {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const res = await verifyToken(c.env.DB, auth.slice(7).trim());
    if (!res) throw new AppError('unauthenticated', 'Invalid or expired token');
    if (res.user.status !== 'active') throw new AppError('unauthenticated', 'Account suspended');
    return { user: res.user, scopes: res.scopes, via: 'rest', client: res.name };
  }
  const token = readCookie(c.req.header('cookie') ?? null, SESSION_COOKIE);
  if (!token) return null;
  const user = await lookupSession(c.env.DB, token);
  if (!user || user.status !== 'active') return null;
  return { user, scopes: new Set(ALL_SCOPES), via: 'ui', client: null };
}

/** Browser CSRF: mutating cookie-authenticated calls need the custom header and a same-origin Origin. */
export function checkCsrf(c: Ctx, actor: Actor): void {
  if (actor.via !== 'ui') return;
  const m = c.req.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
  if (c.req.header('x-skillhub-csrf') !== '1') throw new AppError('forbidden', 'Missing CSRF header');
  const origin = c.req.header('origin');
  const expected = new URL(c.env.BASE_URL).origin;
  if (!origin || origin !== expected) throw new AppError('forbidden', 'Cross-origin request blocked');
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return Response.json(e.toJSON(), { status: e.status });
  console.error(JSON.stringify({ level: 'error', msg: e instanceof Error ? e.message : String(e) }));
  return Response.json({ error: { code: 'internal', message: 'Internal error' } }, { status: 500 });
}
