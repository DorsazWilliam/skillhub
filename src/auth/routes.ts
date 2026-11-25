import { Hono } from 'hono';
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { one, stmt } from '../db/d1';
import { auditStmt } from '../db/audit';
import { AppError } from '../lib/errors';
import { randomToken, safeEqual, sha256B64Url, sha256Hex } from '../lib/crypto';
import { mcpMaxScopes, DEFAULT_CONSENT, SCOPES, isScope, type Scope } from '../authz/scopes';
import { resolveActor, type AppEnv, type Ctx } from '../http/context';
import type { UserRow } from '../db/d1';
import { enabledProviders, emailIdentity, identityFromCode, invitesEnabled, providerAuthorizeUrl, providerLabel, type ProviderKey } from './providers';
import { signIn, type InvitationRow } from './signin';
import { emailConfigured, sendMail, signInMail } from './email';
import { passkeysEnabled } from './passkeys';
import { cookie, createSession, readCookie } from './session';
import { confirmPage, consentPage, errorPage, type ConsentScope } from './consent';

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

const EMAIL_LINK_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign-in error code for the login page: not_allowed, invite_used, invite_mismatch, suspended, invalid. */
function failCode(e: unknown): string {
  const reason = e instanceof AppError ? e.message : 'error';
  console.log(JSON.stringify({ level: 'warn', msg: 'login rejected', reason }));
  if (!(e instanceof AppError) || e.code !== 'forbidden') return 'invalid';
  if (reason === 'invite_used' || reason === 'invite_mismatch') return reason;
  return /suspended/i.test(reason) ? 'suspended' : 'not_allowed';
}

async function startSession(c: Ctx, user: UserRow, returnTo: string, detail: Record<string, unknown>, extraCookies: string[] = []): Promise<Response> {
  const session = await createSession(c.env.DB, user.id);
  await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'login', nodeId: null, version: null, ok: true, detail }).run();
  const headers = new Headers({ location: safeReturn(returnTo), 'cache-control': 'no-store' });
  headers.append('set-cookie', session.setCookie);
  for (const k of extraCookies) headers.append('set-cookie', k);
  return new Response(null, { status: 302, headers });
}

function allowedConsentScopes(c: Ctx, isOwner: boolean): Set<Scope> {
  const max = mcpMaxScopes(c.env);
  if (!isOwner) max.delete('admin');
  return max;
}

export function authApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- What the sign-in page offers ----
  app.get('/auth/providers', (c) => {
    const list = enabledProviders(c.env);
    return c.json(
      {
        providers: list.filter((p) => p !== 'email').map((p) => ({ key: p, label: providerLabel(c.env, p) })),
        email: list.includes('email') && emailConfigured(c.env),
        passkeys: passkeysEnabled(c.env),
        invites: invitesEnabled(c.env),
      },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  // ---- Redirect sign-in: Microsoft, Google, your own OIDC server (UI-only op "login") ----
  app.get('/auth/login', async (c) => {
    const enabled = enabledProviders(c.env).filter((p) => p !== 'email');
    const provider = (c.req.query('provider') ?? enabled[0] ?? 'microsoft') as ProviderKey;
    if (!(enabled as ProviderKey[]).includes(provider)) return c.redirect('/login?error=invalid', 302);
    const invite = c.req.query('invite');
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(48);
    const binding = randomToken(32);
    await stmt(
      c.env.DB,
      'INSERT INTO login_attempts (state_hash, binding_hash, nonce, verifier, return_to, expires_at, provider, invite_hash) VALUES (?,?,?,?,?,?,?,?)',
      await sha256Hex(state),
      await sha256Hex(binding),
      nonce,
      verifier,
      safeReturn(c.req.query('return_to')),
      Date.now() + LOGIN_TTL_MS,
      provider,
      invite ? await sha256Hex(invite) : null,
    ).run();
    const url = await providerAuthorizeUrl(c.env, provider, { state, nonce, codeChallenge: await sha256B64Url(verifier) });
    return new Response(null, { status: 302, headers: { location: url, 'set-cookie': cookie(LOGIN_COOKIE, binding, LOGIN_TTL_MS / 1000), 'cache-control': 'no-store' } });
  });

  app.get('/auth/callback', async (c) => {
    const fail = (code: string): Response =>
      new Response(null, { status: 302, headers: { location: `/login?error=${encodeURIComponent(code)}`, 'set-cookie': cookie(LOGIN_COOKIE, '', 0) } });
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (c.req.query('error') || !state || !code) return fail('cancelled');
    const stateHash = await sha256Hex(state);
    const attempt = await one<{ binding_hash: string; nonce: string; verifier: string; return_to: string; expires_at: number; provider: string; invite_hash: string | null }>(
      c.env.DB,
      'SELECT * FROM login_attempts WHERE state_hash = ?',
      stateHash,
    );
    await stmt(c.env.DB, 'DELETE FROM login_attempts WHERE state_hash = ?', stateHash).run();
    const binding = readCookie(c.req.header('cookie') ?? null, LOGIN_COOKIE);
    if (!attempt || attempt.expires_at < Date.now() || !binding || !safeEqual(await sha256Hex(binding), attempt.binding_hash)) return fail('expired');
    try {
      const identity = await identityFromCode(c.env, (attempt.provider || 'microsoft') as ProviderKey, code, attempt.verifier, attempt.nonce);
      const user = await signIn(c.env, identity, { inviteHash: attempt.invite_hash });
      return await startSession(c, user, attempt.return_to, { method: attempt.provider }, [cookie(LOGIN_COOKIE, '', 0)]);
    } catch (e) {
      return fail(failCode(e));
    }
  });

  // ---- Email sign-in links ----
  app.post('/auth/email', async (c) => {
    if (!enabledProviders(c.env).includes('email') || !emailConfigured(c.env)) return c.json({ error: { code: 'not_found', message: 'Email sign-in is not enabled' } }, 404);
    if (c.req.header('x-skillhub-csrf') !== '1') return c.json({ error: { code: 'forbidden', message: 'Missing CSRF header' } }, 403);
    const body = (await c.req.json().catch(() => null)) as { email?: string; return_to?: string } | null;
    const email = (body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: { code: 'invalid', message: 'Enter an email address' } }, 400);
    // Same answer whether or not the address can sign in: no account discovery. At most 5 links per hour per address.
    const recent = await one<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM email_links WHERE email = ? AND created_at > ?', email, Date.now() - 3600_000);
    if ((recent?.n ?? 0) < 5) {
      const token = randomToken(32);
      await stmt(c.env.DB, 'DELETE FROM email_links WHERE expires_at < ?', Date.now()).run();
      await stmt(
        c.env.DB,
        'INSERT INTO email_links (token_hash, email, return_to, created_at, expires_at) VALUES (?,?,?,?,?)',
        await sha256Hex(token),
        email,
        safeReturn(body?.return_to),
        Date.now(),
        Date.now() + EMAIL_LINK_TTL_MS,
      ).run();
      await sendMail(c.env, signInMail(email, `${c.env.BASE_URL}/auth/email/verify?token=${token}`)).catch((e: unknown) =>
        console.error(JSON.stringify({ level: 'error', msg: 'sign-in email failed', err: String(e) })),
      );
    }
    return c.json({ sent: true });
  });

  // A page with a button, not an immediate sign-in: mail scanners open links, and must not use them up.
  app.get('/auth/email/verify', (c) => {
    const nonce = randomToken(16);
    const token = c.req.query('token') ?? '';
    return html(c, confirmPage({ title: 'Sign in', text: 'Continue to sign in on this device.', action: '/auth/email/verify', token, button: 'Sign in', nonce }), 200, nonce);
  });

  app.post('/auth/email/verify', async (c) => {
    const fail = (code: string): Response => c.redirect(`/login?error=${encodeURIComponent(code)}`, 302);
    if (!enabledProviders(c.env).includes('email')) return fail('invalid');
    const form = await c.req.formData().catch(() => null);
    const token = String(form?.get('token') ?? '');
    if (!token) return fail('expired');
    const h = await sha256Hex(token);
    const link = await one<{ email: string; return_to: string; expires_at: number }>(c.env.DB, 'SELECT * FROM email_links WHERE token_hash = ?', h);
    await stmt(c.env.DB, 'DELETE FROM email_links WHERE token_hash = ?', h).run();
    if (!link || link.expires_at < Date.now()) return fail('expired');
    try {
      const user = await signIn(c.env, emailIdentity(c.env, link.email));
      return await startSession(c, user, link.return_to, { method: 'email' });
    } catch (e) {
      return fail(failCode(e));
    }
  });

  // ---- Invitation links: /auth/invite/<token> describes it; accepting signs in by email (the link was emailed) ----
  app.get('/auth/invite/:token', async (c) => {
    const inv = await one<InvitationRow & { inviter: string | null }>(
      c.env.DB,
      'SELECT i.*, u.name AS inviter FROM invitations i LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?',
      await sha256Hex(c.req.param('token')),
    );
    const valid = !!inv && !inv.accepted_at && !inv.revoked_at && inv.expires_at > Date.now() && invitesEnabled(c.env);
    if (!inv) return c.json({ valid: false }, 404, { 'cache-control': 'no-store' });
    return c.json(
      { valid, email: inv.email, inviter: inv.inviter ?? 'Someone', expires_at: inv.expires_at, accept_by_link: valid && enabledProviders(c.env).includes('email') },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  app.post('/auth/invite/:token/accept', async (c) => {
    const fail = (code: string): Response => c.redirect(`/login?error=${encodeURIComponent(code)}`, 302);
    if (!enabledProviders(c.env).includes('email') || !invitesEnabled(c.env)) return fail('invalid');
    const h = await sha256Hex(c.req.param('token'));
    const inv = await one<InvitationRow>(c.env.DB, 'SELECT * FROM invitations WHERE token_hash = ?', h);
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < Date.now()) return fail('invite_used');
    try {
      const user = await signIn(c.env, emailIdentity(c.env, inv.email), { inviteHash: h });
      return await startSession(c, user, '/', { method: 'invite' });
    } catch (e) {
      return fail(failCode(e));
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
