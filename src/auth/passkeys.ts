import { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import brand from '../../brand.json';
import { all, one, stmt, type UserRow } from '../db/d1';
import { auditStmt } from '../db/audit';
import { AppError } from '../lib/errors';
import { fromBase64, randomToken, sha256Hex, toBase64Url } from '../lib/crypto';
import { checkCsrf, errorResponse, resolveActor, type AppEnv, type Ctx } from '../http/context';
import { enabledProviders } from './providers';
import { cookie, createSession, readCookie } from './session';
import { safeReturn } from './routes';

/**
 * Passkeys (WebAuthn), with self-serve sign-in (the email provider): a signed-in user adds passkeys from their account,
 * then signs in with one tap. Discoverable credentials, so the sign-in page needs no email first.
 * Off when email sign-in is off, so an organization that signs in only through its identity provider keeps it that way.
 */

const WA_COOKIE = '__Host-skillhub_wa';
const TTL_MS = 5 * 60 * 1000;

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
}

const rp = (c: Ctx): { id: string; origin: string } => {
  const u = new URL(c.env.BASE_URL);
  return { id: u.hostname, origin: u.origin };
};

function fromB64Url(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b + '='.repeat((4 - (b.length % 4)) % 4));
}

async function saveChallenge(c: Ctx, challenge: string, userId: string | null): Promise<string> {
  const id = randomToken(24);
  await stmt(c.env.DB, 'DELETE FROM webauthn_challenges WHERE expires_at < ?', Date.now()).run();
  await stmt(c.env.DB, 'INSERT INTO webauthn_challenges (id_hash, challenge, user_id, expires_at) VALUES (?,?,?,?)', await sha256Hex(id), challenge, userId, Date.now() + TTL_MS).run();
  return cookie(WA_COOKIE, id, TTL_MS / 1000, 'Strict');
}

/** The pending challenge bound to this browser, used once. */
async function takeChallenge(c: Ctx): Promise<{ challenge: string; user_id: string | null } | null> {
  const id = readCookie(c.req.header('cookie') ?? null, WA_COOKIE);
  if (!id) return null;
  const h = await sha256Hex(id);
  const row = await one<{ challenge: string; user_id: string | null; expires_at: number }>(c.env.DB, 'SELECT * FROM webauthn_challenges WHERE id_hash = ?', h);
  await stmt(c.env.DB, 'DELETE FROM webauthn_challenges WHERE id_hash = ?', h).run();
  return row && row.expires_at > Date.now() ? row : null;
}

export function passkeysEnabled(env: AppEnv['Bindings']): boolean {
  return enabledProviders(env).includes('email');
}

async function sessionUser(c: Ctx): Promise<UserRow> {
  const actor = await resolveActor(c);
  if (!actor || actor.via !== 'ui') throw new AppError('unauthenticated', 'Sign in first');
  checkCsrf(c, actor);
  return actor.user;
}

function requireCsrfHeader(c: Ctx): void {
  if (c.req.header('x-skillhub-csrf') !== '1') throw new AppError('forbidden', 'Missing CSRF header');
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.env.BASE_URL).origin) throw new AppError('forbidden', 'Cross-origin request blocked');
}

export function passkeyApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('/auth/passkey*', async (c, next) => {
    if (!passkeysEnabled(c.env)) return c.json({ error: { code: 'not_found', message: 'Passkeys are not enabled' } }, 404);
    await next();
  });

  // ---- a signed-in user's passkeys ----
  app.get('/auth/passkeys', async (c) => {
    try {
      const user = await sessionUser(c);
      const rows = await all<PasskeyRow>(c.env.DB, 'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', user.id);
      return c.json({ items: rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at, last_used_at: r.last_used_at })) });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.post('/auth/passkeys/options', async (c) => {
    try {
      const user = await sessionUser(c);
      const existing = await all<PasskeyRow>(c.env.DB, 'SELECT * FROM passkeys WHERE user_id = ?', user.id);
      const options = await generateRegistrationOptions({
        rpName: brand.name,
        rpID: rp(c).id,
        userName: user.email ?? user.id,
        userDisplayName: user.name ?? user.email ?? '',
        userID: Uint8Array.from(new TextEncoder().encode(user.id)),
        attestationType: 'none',
        excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      });
      const setCookie = await saveChallenge(c, options.challenge, user.id);
      return c.json(options, 200, { 'set-cookie': setCookie });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.post('/auth/passkeys', async (c) => {
    try {
      const user = await sessionUser(c);
      const body = (await c.req.json().catch(() => null)) as { response?: RegistrationResponseJSON; name?: string } | null;
      const ch = await takeChallenge(c);
      if (!body?.response || !ch || ch.user_id !== user.id) throw new AppError('invalid', 'The passkey request expired, try again');
      const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp(c).origin, expectedRPID: rp(c).id, requireUserVerification: false });
      if (!v.verified || !v.registrationInfo) throw new AppError('invalid', 'The passkey could not be verified');
      const cred = v.registrationInfo.credential;
      const name = (body.name ?? '').trim().slice(0, 60) || 'Passkey';
      await stmt(
        c.env.DB,
        'INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?,?,?,?,?,?,?)',
        cred.id,
        user.id,
        toBase64Url(cred.publicKey),
        cred.counter,
        cred.transports ? JSON.stringify(cred.transports) : null,
        name,
        Date.now(),
      ).run();
      await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'add_passkey', nodeId: null, version: null, ok: true, detail: { name } }).run();
      return c.json({ id: cred.id, name });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.delete('/auth/passkeys/:id', async (c) => {
    try {
      const user = await sessionUser(c);
      const r = await stmt(c.env.DB, 'DELETE FROM passkeys WHERE id = ? AND user_id = ?', c.req.param('id'), user.id).run();
      if (!(r.meta.changes ?? 0)) throw new AppError('not_found', 'Not found');
      await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'remove_passkey', nodeId: null, version: null, ok: true, detail: null }).run();
      return c.json({ removed: true });
    } catch (e) {
      return errorResponse(e);
    }
  });

  // ---- sign in with a passkey ----
  app.post('/auth/passkey/options', async (c) => {
    try {
      requireCsrfHeader(c);
      const options = await generateAuthenticationOptions({ rpID: rp(c).id, userVerification: 'preferred' });
      const setCookie = await saveChallenge(c, options.challenge, null);
      return c.json(options, 200, { 'set-cookie': setCookie });
    } catch (e) {
      return errorResponse(e);
    }
  });

  app.post('/auth/passkey/verify', async (c) => {
    try {
      requireCsrfHeader(c);
      const body = (await c.req.json().catch(() => null)) as { response?: AuthenticationResponseJSON; return_to?: string } | null;
      const ch = await takeChallenge(c);
      if (!body?.response || !ch) throw new AppError('invalid', 'The sign-in request expired, try again');
      const key = await one<PasskeyRow>(c.env.DB, 'SELECT * FROM passkeys WHERE id = ?', body.response.id);
      if (!key) throw new AppError('unauthenticated', 'Unknown passkey');
      const v = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: rp(c).origin,
        expectedRPID: rp(c).id,
        requireUserVerification: false,
        credential: { id: key.id, publicKey: Uint8Array.from(fromB64Url(key.public_key)), counter: key.counter, transports: key.transports ? (JSON.parse(key.transports) as AuthenticatorTransportFuture[]) : undefined },
      });
      if (!v.verified) throw new AppError('unauthenticated', 'The passkey could not be verified');
      const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', key.user_id);
      if (!user || user.status !== 'active') throw new AppError('forbidden', 'Your account is suspended');
      await stmt(c.env.DB, 'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', v.authenticationInfo.newCounter, Date.now(), key.id).run();
      await stmt(c.env.DB, 'UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id).run();
      const session = await createSession(c.env.DB, user.id);
      await auditStmt(c.env.DB, { actorId: user.id, via: 'ui', client: null, op: 'login', nodeId: null, version: null, ok: true, detail: { method: 'passkey' } }).run();
      return c.json({ ok: true, return_to: safeReturn(body.return_to) }, 200, { 'set-cookie': session.setCookie });
    } catch (e) {
      return errorResponse(e);
    }
  });

  return app;
}
