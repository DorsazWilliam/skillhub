import { Hono } from 'hono';
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { one, stmt } from '../db/d1';
import { auditStmt } from '../db/audit';
import { AppError } from '../lib/errors';
import { randomToken, safeEqual, sha256B64Url, sha256Hex } from '../lib/crypto';
import { mcpMaxScopes, DEFAULT_CONSENT, SCOPES, isScope, type Scope } from '../authz/scopes';
import { resolveActor, type AppEnv, type Ctx } from '../http/context';
import { authorizeUrl, exchangeCode, validateIdToken } from './entra';
import { upsertUser } from './users';
import { cookie, createSession, readCookie } from './session';
import { consentPage, errorPage, type ConsentScope } from './consent';

const LOGIN_COOKIE = '__Host-skillhub_login';
const LOGIN_TTL_MS = 10 * 60 * 1000;

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturn(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw.slice(0, 4000);
}

function html(c: Ctx, body: string, status: number, nonce: string, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  headers.set('cache-control', 'no-store');
  headers.set('x-frame-options', 'DENY');
  return new Response(body, { status, headers });
}

function allowedConsentScopes(c: Ctx, isOwner: boolean): Set<Scope> {
  const max = mcpMaxScopes(c.env);
  if (!isOwner) max.delete('admin');
  return max;
}

export function authApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- Entra sign-in (UI-only op "login") ----
  app.get('/auth/login', async (c) => {
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(48);
    const binding = randomToken(32);
    await stmt(
      c.env.DB,
      'INSERT INTO login_attempts (state_hash, binding_hash, nonce, verifier, return_to, expires_at) VALUES (?,?,?,?,?,?)',
      await sha256Hex(state),
      await sha256Hex(binding),
      nonce,
      verifier,
      safeReturn(c.req.query('return_to')),
      Date.now() + LOGIN_TTL_MS,
    ).run();
    const url = authorizeUrl(c.env, { state, nonce, codeChallenge: await sha256B64Url(verifier) });
    return new Response(null, { status: 302, headers: { location: url, 'set-cookie': cookie(LOGIN_COOKIE, binding, LOGIN_TTL_MS / 1000), 'cache-control': 'no-store' } });
  });

  app.get('/auth/callback', async (c) => {
    const fail = (code: string): Response =>
      new Response(null, { status: 302, headers: { location: `/login?error=${encodeURIComponent(code)}`, 'set-cookie': cookie(LOGIN_COOKIE, '', 0) } });
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (c.req.query('error') || !state || !code) return fail('cancelled');
    const stateHash = await sha256Hex(state);
    const attempt = await one<{ binding_hash: string; nonce: string; verifier: string; return_to: string; expires_at: number }>(
      c.env.DB,
      'SELECT * FROM login_attempts WHERE state_hash = ?',
      stateHash,
    );
    await stmt(c.env.DB, 'DELETE FROM login_attempts WHERE state_hash = ?', stateHash).run();
    const binding = readCookie(c.req.header('cookie') ?? null, LOGIN_COOKIE);
    if (!attempt || attempt.expires_at < Date.now() || !binding || !safeEqual(await sha256Hex(binding), attempt.binding_hash)) return fail('expired');
    try {
      const idToken = await exchangeCode(c.env, code, attempt.verifier);
      const identity = await validateIdToken(c.env, idToken, { nonce: attempt.nonce });
      const user = await upsertUser(c.env, identity);
      const session = await createSession(c.env.DB, user.id);
      await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'login', nodeId: null, version: null, ok: true, detail: null }).run();
      const headers = new Headers({ location: safeReturn(attempt.return_to), 'cache-control': 'no-store' });
      headers.append('set-cookie', session.setCookie);
      headers.append('set-cookie', cookie(LOGIN_COOKIE, '', 0));
      return new Response(null, { status: 302, headers });
    } catch (e) {
      const reason = e instanceof AppError ? e.message : 'error';
      console.log(JSON.stringify({ level: 'warn', msg: 'login rejected', reason }));
      return fail(e instanceof AppError && e.code === 'forbidden' ? 'not_allowed' : 'invalid');
    }
  });

  // ---- MCP authorization: our consent page (confused-deputy protection) ----
  app.get('/authorize', async (c) => {
    const nonce = randomToken(16);
    const actor = await resolveActor(c).catch(() => null);
    if (!actor || actor.via !== 'ui') {
      const here = new URL(c.req.url);
      return c.redirect(`/auth/login?return_to=${encodeURIComponent(here.pathname + here.search)}`, 302);
    }
    const oauth = c.env.OAUTH_PROVIDER;
    try {
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const allowed = allowedConsentScopes(c, actor.user.org_role === 'owner');
      const requested = new Set(request.scope.filter(isScope));
      const scopes: ConsentScope[] = SCOPES.map((s) => ({
        scope: s,
        checked: allowed.has(s) && (DEFAULT_CONSENT.has(s) || (requested.has(s) && s !== 'admin' && s !== 'manage' && s !== 'publish')),
        disabled: !allowed.has(s),
      }));
      return html(c, consentPage({ details, handle: consent.handle, user: actor.user, scopes, nonce }), 200, nonce, consent.headers);
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        return html(c, errorPage(e instanceof AuthorizationError ? e.description : 'This app could not be verified.', nonce), 400, nonce);
      }
      throw e;
    }
  });

  app.post('/authorize', async (c) => {
    const nonce = randomToken(16);
    const actor = await resolveActor(c).catch(() => null);
    if (!actor || actor.via !== 'ui') return html(c, errorPage('Your session expired. Start connecting again from your app.', nonce), 401, nonce);
    const oauth = c.env.OAUTH_PROVIDER;
    try {
      const form = await c.req.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const allowed = allowedConsentScopes(c, actor.user.org_role === 'owner');
      const picked = [...new Set(form.getAll('scope').map(String))].filter((s): s is Scope => isScope(s) && allowed.has(s));
      if (!picked.includes('read')) picked.unshift('read');
      const approved = await oauth.approveConsent(c.req.raw, handle, { scope: picked });
      const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
      const clientName = (client?.clientName ?? approved.request.clientId).slice(0, 120);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: actor.user.id,
        metadata: { clientName },
        scope: picked,
        props: { userId: actor.user.id, clientName },
      });
      await auditStmt(c.env.DB, { actorId: actor.user.id, via: 'ui', client: clientName, op: 'connect_mcp', nodeId: null, version: null, ok: true, detail: { scopes: picked } }).run();
      approved.headers.set('location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        return html(c, errorPage('This sign-in page expired or was already used. Start connecting again from your app.', nonce), 400, nonce);
      }
      throw e;
    }
  });

  return app;
}
