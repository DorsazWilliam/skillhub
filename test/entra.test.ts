import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from 'jose';
import { validateIdToken } from '../src/auth/entra';
import { upsertUser } from '../src/auth/users';
import { AppError } from '../src/lib/errors';
import { makeUser, sessionClient } from './helpers';

const TID = '11111111-1111-1111-1111-111111111111';
const OTHER_TID = '99999999-9999-9999-9999-999999999999';
const AUD = '22222222-2222-2222-2222-222222222222';
const cfg = { ENTRA_TENANT_ID: TID, ENTRA_ALLOWED_TENANTS: '', ENTRA_CLIENT_ID: AUD, ALLOWED_EMAIL_DOMAINS: '', ALLOW_GUESTS: 'false' };

let privateKey: CryptoKey;
let keys: (tid: string) => JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const set = createLocalJWKSet({ keys: [jwk] });
  keys = () => set;
});

async function token(claims: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; exp?: number } = {}): Promise<string> {
  const tid = (claims['tid'] as string | undefined) ?? TID;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tid, oid: '33333333-3333-3333-3333-333333333333', nonce: 'n1', email: 'alice@contoso.test', name: 'Alice', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${tid}/v2.0`)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(now - 10)
    .setExpirationTime(opts.exp ?? now + 600)
    .sign(privateKey);
}

async function rejects(p: Promise<unknown>, code?: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    if (code) expect((e as AppError).code).toBe(code);
    return;
  }
  throw new Error('expected rejection');
}

describe('Entra id_token validation (SPEC 5.2)', () => {
  it('accepts a valid token', async () => {
    const id = await validateIdToken(cfg, await token(), { nonce: 'n1', keys });
    expect(id).toMatchObject({ tid: TID, oid: '33333333-3333-3333-3333-333333333333', email: 'alice@contoso.test', guest: false });
  });

  it('rejects a token from another tenant', async () => {
    await rejects(validateIdToken(cfg, await token({ tid: OTHER_TID }), { nonce: 'n1', keys }), 'unauthenticated');
  });

  it('rejects an issuer that does not match the token tid', async () => {
    await rejects(validateIdToken(cfg, await token({}, { iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` }), { nonce: 'n1', keys }));
  });

  it('rejects the wrong audience', async () => {
    await rejects(validateIdToken(cfg, await token({}, { aud: 'someone-else' }), { nonce: 'n1', keys }));
  });

  it('rejects a bad nonce', async () => {
    await rejects(validateIdToken(cfg, await token({ nonce: 'other' }), { nonce: 'n1', keys }));
  });

  it('rejects an expired token', async () => {
    await rejects(validateIdToken(cfg, await token({}, { exp: Math.floor(Date.now() / 1000) - 3600 }), { nonce: 'n1', keys }));
  });

  it('rejects guests by default and allows them when configured', async () => {
    const guest = await token({ idp: 'https://sts.windows.net/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/' });
    await rejects(validateIdToken(cfg, guest, { nonce: 'n1', keys }), 'forbidden');
    const id = await validateIdToken({ ...cfg, ALLOW_GUESTS: 'true' }, guest, { nonce: 'n1', keys });
    expect(id.guest).toBe(true);
  });

  it('email domain filter only restricts', async () => {
    await rejects(validateIdToken({ ...cfg, ALLOWED_EMAIL_DOMAINS: 'fabrikam.test' }, await token(), { nonce: 'n1', keys }), 'forbidden');
    await expect(validateIdToken({ ...cfg, ALLOWED_EMAIL_DOMAINS: 'contoso.test' }, await token(), { nonce: 'n1', keys })).resolves.toBeTruthy();
  });

  it('multi-tenant mode validates issuer per token tid against the allowlist', async () => {
    const multi = { ...cfg, ENTRA_ALLOWED_TENANTS: `${TID},${OTHER_TID}` };
    const id = await validateIdToken(multi, await token({ tid: OTHER_TID }), { nonce: 'n1', keys });
    expect(id.tid).toBe(OTHER_TID);
    await rejects(validateIdToken(multi, await token({ tid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), { nonce: 'n1', keys }));
  });
});

describe('users', () => {
  it('keys on (tid, oid): a changed email maps to the same user', async () => {
    const oid = crypto.randomUUID();
    const a = await upsertUser(env, { tid: TID, oid, email: 'old@contoso.test', name: 'Bob', guest: false });
    const b = await upsertUser(env, { tid: TID, oid, email: 'new@contoso.test', name: 'Bob B', guest: false });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe('new@contoso.test');
  });

  it('a different oid with the same email is a different user', async () => {
    const a = await upsertUser(env, { tid: TID, oid: crypto.randomUUID(), email: 'same@contoso.test', name: 'X', guest: false });
    const b = await upsertUser(env, { tid: TID, oid: crypto.randomUUID(), email: 'same@contoso.test', name: 'Y', guest: false });
    expect(a.id).not.toBe(b.id);
  });

  it('bootstraps OWNER_EMAILS as owner on first login only', async () => {
    const u = await upsertUser(env, { tid: TID, oid: crypto.randomUUID(), email: 'owner@contoso.test', name: 'O', guest: false });
    expect(u.org_role).toBe('owner');
    const m = await upsertUser(env, { tid: TID, oid: crypto.randomUUID(), email: 'member@contoso.test', name: 'M', guest: false });
    expect(m.org_role).toBe('member');
  });

  it('suspended users cannot log in and are locked out on the next request', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const victim = await makeUser();
    const vc = await sessionClient(victim);
    expect((await vc.call('GET', '/me')).status).toBe(200);
    const r = await owner.call('PUT', `/users/${victim.id}/status`, { status: 'suspended' });
    expect(r.status).toBe(200);
    expect((await vc.call('GET', '/me')).status).toBe(401);
    await rejects(upsertUser(env, { tid: victim.tid, oid: victim.oid, email: victim.email, name: victim.name, guest: false }), 'forbidden');
  });

  it('a suspended user with a PAT is rejected', async () => {
    const { tokenClient } = await import('./helpers');
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const u = await makeUser();
    const tc = await tokenClient(u, ['read']);
    expect((await tc.call('GET', '/me')).status).toBe(200);
    await owner.call('PUT', `/users/${u.id}/status`, { status: 'suspended' });
    expect((await tc.call('GET', '/me')).status).toBe(401);
  });
});

describe('login flow', () => {
  it('redirects to Entra with PKCE, nonce and state', async () => {
    const { fetchSelf } = await import('./helpers');
    const res = await fetchSelf('/auth/login?return_to=/d/abc', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('login.microsoftonline.com');
    expect(loc.pathname).toContain(TID);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('__Host-skillhub_login=');
  });

  it('rejects a callback without the browser binding cookie', async () => {
    const { fetchSelf } = await import('./helpers');
    const res = await fetchSelf('/auth/callback?state=x&code=y', { redirect: 'manual' });
    expect(res.headers.get('location')).toContain('/login?error=');
  });

  it('CSRF: cookie-authenticated mutations need the header and same origin', async () => {
    const u = await makeUser({ role: 'owner' });
    const c = await sessionClient(u);
    const bad = await c.raw('/api/v1/folders', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json', origin: 'https://evil.test' } });
    expect(bad.status).toBe(403);
  });
});
