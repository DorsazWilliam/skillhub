import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { AREA, BASE, fetchSelf, makeUser, rootFolder, sessionClient } from './helpers';
import { validateOidcToken, emailIdentity } from '../src/auth/providers';
import { signIn } from '../src/auth/signin';
import type { Env } from '../src/env';

const uid = (): string => Math.random().toString(36).slice(2, 8);
const E = env as unknown as Env;

/** The newest email sent to `to` (EMAIL_TRANSPORT=memory keeps them in KV). */
async function lastMailTo(to: string): Promise<{ subject: string; text: string } | null> {
  const list = await E.OAUTH_KV.list({ prefix: 'mail:' });
  const mails: { to: string; subject: string; text: string }[] = [];
  for (const k of list.keys) {
    const m = (await E.OAUTH_KV.get(k.name, 'json')) as { to: string; subject: string; text: string } | null;
    if (m) mails.push(m);
  }
  return mails.filter((m) => m.to === to).pop() ?? null;
}

const linkIn = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  if (!m) throw new Error('no link in ' + text);
  return m[1]!;
};

async function anon(path: string, init: RequestInit = {}): Promise<Response> {
  return fetchSelf(path, { redirect: 'manual', ...init, headers: { origin: BASE, 'x-skillhub-csrf': '1', ...(init.headers as Record<string, string>) } });
}
const sessionFrom = (r: Response): string => (r.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('sign-in providers', () => {
  it('the sign-in page lists the enabled methods', async () => {
    const r = await anon('/auth/providers');
    const j = (await r.json()) as { providers: { key: string }[]; email: boolean; passkeys: boolean; invites: boolean };
    expect(j.providers.map((p) => p.key)).toEqual(['microsoft']);
    expect(j.email).toBe(true);
    expect(j.passkeys).toBe(true);
    expect(j.invites).toBe(true);
  });

  it('a provider that is not enabled is refused', async () => {
    const r = await anon('/auth/login?provider=google');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login?error=invalid');
  });

  it('Google: members are the Workspace domains, unverified emails are dropped', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] });
    const cfg = { ...E, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_DOMAINS: 'acme.test' } as Env;
    const tok = (claims: Record<string, unknown>): Promise<string> =>
      new SignJWT({ nonce: 'n', email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://accounts.google.com').setAudience('gid').setSubject('g-123').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const member = await validateOidcToken(cfg, 'google', await tok({ email: 'ann@acme.test', hd: 'acme.test' }), { nonce: 'n', keys });
    expect(member).toMatchObject({ tid: 'google', oid: 'g-123', email: 'ann@acme.test', member: true });
    const outsider = await validateOidcToken(cfg, 'google', await tok({ email: 'bob@gmail.com' }), { nonce: 'n', keys });
    expect(outsider.member).toBe(false);
    const unverified = await validateOidcToken(cfg, 'google', await tok({ email: 'eve@acme.test', hd: 'acme.test', email_verified: false }), { nonce: 'n', keys });
    expect(unverified.email).toBeNull();
    await expect(validateOidcToken(cfg, 'google', await tok({ nonce: 'other' }), { nonce: 'n', keys })).rejects.toThrow();
  });

  it('your own OIDC server: its users are members, the issuer must match', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] });
    const cfg = { ...E, OIDC_ISSUER: 'https://id.acme.test/realms/acme', OIDC_CLIENT_ID: 'skillhub' } as Env;
    const tok = (iss: string): Promise<string> =>
      new SignJWT({ nonce: 'n', email: 'ann@acme.test', email_verified: true }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience('skillhub').setSubject('u1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const id = await validateOidcToken(cfg, 'oidc', await tok('https://id.acme.test/realms/acme'), { nonce: 'n', keys });
    expect(id).toMatchObject({ tid: 'oidc:https://id.acme.test/realms/acme', oid: 'u1', member: true });
    await expect(validateOidcToken(cfg, 'oidc', await tok('https://evil.test'), { nonce: 'n', keys })).rejects.toThrow();
  });

  it('email links: a member domain signs in; anyone else needs an invitation', async () => {
    const domainEnv = { ...E, ALLOWED_EMAIL_DOMAINS: 'acme.test' } as Env;
    const ok = await signIn(domainEnv, emailIdentity(domainEnv, `m-${uid()}@acme.test`));
    expect(ok.is_external).toBe(0);
    await expect(signIn(E, emailIdentity(E, `x-${uid()}@other.test`))).rejects.toThrow('not_allowed');
  });

  it('an email sign-in link signs in once, through a confirmation page', async () => {
    const email = `link-${uid()}@other.test`;
    // A known external user (invited earlier), so the link is allowed to sign in.
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const f = (await rootFolder(owner, { name: 'f-' + uid() })).json.id;
    await owner.call('POST', '/invitations', { email, access: [{ folder: f, role: 'viewer' }] });
    const sent = await anon('/auth/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    expect(sent.status).toBe(200);
    const mail = await lastMailTo(email);
    expect(mail?.subject).toContain('Sign in');
    const token = linkIn(mail!.text, /token=([A-Za-z0-9_-]+)/);
    const page = await anon('/auth/email/verify?token=' + token);
    expect(await page.text()).toContain('method="post"');
    const body = new URLSearchParams({ token });
    const r = await anon('/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    const me = await fetchSelf('/api/v1/me', { headers: { cookie: sessionFrom(r) } });
    expect(((await me.json()) as { user: { email: string; external: boolean } }).user).toMatchObject({ email, external: true });
    const again = await anon('/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(again.headers.get('location')).toBe('/login?error=expired');
  });
});

describe('invitations', () => {
  it('invite by email: the person gets the access, as an external user who cannot become owner', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const f = (await rootFolder(owner, { name: 'f-' + uid() })).json.id;
    const email = `guest-${uid()}@partner.test`;
    const inv = await owner.call('POST', '/invitations', { email, access: [{ folder: f, role: 'editor' }] });
    expect(inv.status).toBe(200);
    expect(inv.json.emailed).toBe(true);
    const token = linkIn(inv.json.link, /invite=([A-Za-z0-9_-]+)/);
    expect((await lastMailTo(email))?.text).toContain(inv.json.link);

    const info = (await (await anon('/auth/invite/' + token)).json()) as { valid: boolean; email: string; accept_by_link: boolean };
    expect(info).toMatchObject({ valid: true, email, accept_by_link: true });
    const r = await anon(`/auth/invite/${token}/accept`, { method: 'POST' });
    expect(r.headers.get('location')).toBe('/');
    const cookie = sessionFrom(r);
    const node = await fetchSelf(`/api/v1/nodes/${f}`, { headers: { cookie } });
    expect(((await node.json()) as { access: string }).access).toBe('editor');
    const me = (await (await fetchSelf('/api/v1/me', { headers: { cookie } })).json()) as { user: { id: string; external: boolean } };
    expect(me.user.external).toBe(true);

    expect((await owner.call('PUT', `/users/${me.user.id}/role`, { role: 'owner' })).status).toBe(400);
    const list = await owner.call('GET', '/invitations');
    expect(list.json.items.find((i: { id: string }) => i.id === inv.json.id).status).toBe('accepted');
    // The link works once.
    expect((await anon(`/auth/invite/${token}/accept`, { method: 'POST' })).headers.get('location')).toBe('/login?error=invite_used');
  });

  it('only managers of a folder can invite to it; revoked invitations stop working', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const member = await sessionClient(await makeUser());
    const f = (await rootFolder(owner, { name: 'f-' + uid() })).json.id;
    expect((await member.call('POST', '/invitations', { email: `a-${uid()}@x.test`, access: [{ folder: f, role: 'viewer' }] })).status).not.toBe(200);
    const inv = await owner.call('POST', '/invitations', { email: `b-${uid()}@x.test`, access: [{ folder: f, role: 'viewer' }], send: false });
    expect(inv.json.emailed).toBe(false);
    expect((await owner.call('DELETE', `/invitations/${inv.json.id}`)).json.revoked).toBe(true);
    const token = linkIn(inv.json.link, /invite=([A-Za-z0-9_-]+)/);
    expect((await anon(`/auth/invite/${token}/accept`, { method: 'POST' })).headers.get('location')).toBe('/login?error=invite_used');
  });

  it('a pending invitation lets an outsider in with any method; ALLOW_INVITES=false ignores it', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const f = (await rootFolder(owner, { name: 'f-' + uid() })).json.id;
    const email = `g-${uid()}@gmail.test`;
    await owner.call('POST', '/invitations', { email, access: [{ folder: f, role: 'viewer' }], send: false });
    const google = { tid: 'google', oid: 'g-' + uid(), email, name: 'Gail', member: false };
    await expect(signIn({ ...E, ALLOW_INVITES: 'false' } as Env, google)).rejects.toThrow('not_allowed');
    const user = await signIn(E, google);
    expect(user.is_external).toBe(1);
    expect(user.org_role).toBe('member');
  });
});

describe('passkeys', () => {
  it('sign-in options come with a challenge bound to the browser; a bogus answer is refused', async () => {
    const o = await anon('/auth/passkey/options', { method: 'POST' });
    expect(o.status).toBe(200);
    expect(((await o.json()) as { challenge: string }).challenge).toBeTruthy();
    const cookie = sessionFrom(o);
    expect(cookie).toContain('__Host-skillhub_wa=');
    const bad = await anon('/auth/passkey/verify', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {} } }) });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('a signed-in user can start registering a passkey and list theirs', async () => {
    const user = await sessionClient(await makeUser());
    const opts = await user.raw('/auth/passkeys/options', { method: 'POST' });
    expect(opts.status).toBe(200);
    expect(((await opts.json()) as { rp: { id: string } }).rp.id).toBe('skills.test');
    const list = await user.raw('/auth/passkeys');
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

void AREA;
