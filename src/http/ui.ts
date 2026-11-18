import { Hono } from 'hono';
import { z } from 'zod';
import { auditStmt } from '../db/audit';
import { AppError } from '../lib/errors';
import { SCOPES } from '../authz/scopes';
import { mintToken, revokeToken } from '../auth/tokens';
import { destroySession, readCookie, SESSION_COOKIE, cookie } from '../auth/session';
import { checkCsrf, errorResponse, resolveActor, type AppEnv, type Ctx } from './context';
import type { Actor } from '../authz/authorize';

/**
 * The UI-only operations (SPEC 10.3): login, logout, mint_api_token, revoke_api_token, revoke_mcp_connection.
 * They require a browser session; bearer tokens are refused so a token can never mint or revoke tokens.
 * login lives in src/auth/routes.ts (it is a redirect flow).
 */

async function sessionActor(c: Ctx): Promise<Actor> {
  if (c.req.header('authorization')) throw new AppError('forbidden', 'This action is only available in the web app');
  const actor = await resolveActor(c);
  if (!actor || actor.via !== 'ui') throw new AppError('unauthenticated', 'Sign in required');
  checkCsrf(c, actor);
  return actor;
}

async function audit(c: Ctx, actor: Actor, op: string, ok: boolean, detail: Record<string, unknown> | null): Promise<void> {
  await auditStmt(c.env.DB, { actorId: actor.user.id, via: 'ui', client: null, op, nodeId: null, version: null, ok, detail }).run();
}

const MintInput = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expires_in_days: z.number().int().min(1).max(365).nullable().default(90),
});

export function uiApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/logout', async (c) => {
    try {
      const actor = await sessionActor(c);
      const token = readCookie(c.req.header('cookie') ?? null, SESSION_COOKIE);
      if (token) await destroySession(c.env.DB, token);
      await audit(c, actor, 'logout', true, null);
      return c.json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.post('/tokens', async (c) => {
    try {
      const actor = await sessionActor(c);
      const parsed = MintInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('invalid', 'Invalid input');
      const { name, scopes, expires_in_days } = parsed.data;
      if (scopes.includes('admin') && actor.user.org_role !== 'owner') throw new AppError('forbidden', 'Only owners can create admin tokens');
      const t = await mintToken(c.env.DB, actor.user.id, name, [...new Set(scopes)], expires_in_days);
      await audit(c, actor, 'mint_api_token', true, { token_id: t.id, scopes });
      return c.json({ id: t.id, token: t.token, name, scopes, expires_at: t.expires_at }, 200, { 'cache-control': 'no-store' });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.delete('/tokens/:id', async (c) => {
    try {
      const actor = await sessionActor(c);
      const ok = await revokeToken(c.env.DB, actor.user.id, c.req.param('id'));
      await audit(c, actor, 'revoke_api_token', ok, { token_id: c.req.param('id') });
      if (!ok) throw new AppError('not_found', 'Token not found');
      return c.json({ revoked: true });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.delete('/connections/:id', async (c) => {
    try {
      const actor = await sessionActor(c);
      const id = c.req.param('id');
      const grants = await c.env.OAUTH_PROVIDER.listUserGrants(actor.user.id, { limit: 1000 });
      if (!grants.items.some((g) => g.id === id)) throw new AppError('not_found', 'Connection not found');
      await c.env.OAUTH_PROVIDER.revokeGrant(id, actor.user.id);
      await audit(c, actor, 'revoke_mcp_connection', true, { grant_id: id });
      return c.json({ revoked: true });
    } catch (e) {
      return errorResponse(e);
    }
  });

  return app;
}
