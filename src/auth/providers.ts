import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { csv, type Env } from '../env';
import { AppError } from '../lib/errors';
import { authorizeUrl as entraAuthorizeUrl, exchangeCode as entraExchange, validateIdToken as entraValidate } from './entra';

/**
 * Sign-in providers. Every provider turns a sign-in into an Identity: a stable key (tid = namespace, oid = subject),
 * a verified email when there is one, and `member`: whether the provider alone makes this person part of the organization.
 * Non-members get in only with an invitation (see signin.ts).
 */

export type ProviderKey = 'microsoft' | 'google' | 'oidc' | 'email';
export const PROVIDER_KEYS: readonly ProviderKey[] = ['microsoft', 'google', 'oidc', 'email'];

export interface Identity {
  tid: string;
  oid: string;
  email: string | null;
  name: string | null;
  member: boolean;
}

export function enabledProviders(env: Env): ProviderKey[] {
  const list = csv(env.AUTH_PROVIDERS ?? 'microsoft').map((p) => p.toLowerCase());
  return PROVIDER_KEYS.filter((k) => list.includes(k));
}

export function invitesEnabled(env: Env): boolean {
  return (env.ALLOW_INVITES ?? 'true').toLowerCase() !== 'false';
}

const domainOf = (email: string | null): string => email?.split('@')[1]?.toLowerCase() ?? '';

/** ALLOWED_EMAIL_DOMAINS, if set, restricts members of every provider. */
function domainAllowed(env: Env, email: string | null): boolean {
  const domains = csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase());
  return domains.length === 0 || domains.includes(domainOf(email));
}

export function providerLabel(env: Env, k: ProviderKey): string {
  return k === 'microsoft' ? 'Microsoft' : k === 'google' ? 'Google' : k === 'oidc' ? (env.OIDC_NAME || 'Single sign-on') : 'Email';
}

// ---------- OpenID Connect discovery (Google and your own server) ----------

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveries = new Map<string, Promise<Discovery>>();
const jwks = new Map<string, JWTVerifyGetKey>();

async function discover(issuer: string): Promise<Discovery> {
  const key = issuer.replace(/\/+$/, '');
  let d = discoveries.get(key);
  if (!d) {
    d = fetch(key + '/.well-known/openid-configuration').then(async (r) => {
      if (!r.ok) throw new AppError('internal', `OpenID discovery failed for ${key}: ${r.status}`);
      return (await r.json()) as Discovery;
    });
    d.catch(() => discoveries.delete(key));
    discoveries.set(key, d);
  }
  return d;
}

function keysFor(uri: string): JWTVerifyGetKey {
  let k = jwks.get(uri);
  if (!k) {
    k = createRemoteJWKSet(new URL(uri), { cacheMaxAge: 24 * 3600 * 1000 });
    jwks.set(uri, k);
  }
  return k;
}

interface OidcConf {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

function oidcConf(env: Env, p: 'google' | 'oidc'): OidcConf {
  if (p === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError('internal', 'Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    return { issuer: 'https://accounts.google.com', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, scopes: 'openid email profile' };
  }
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) throw new AppError('internal', 'OIDC sign-in needs OIDC_ISSUER and OIDC_CLIENT_ID');
  return { issuer: env.OIDC_ISSUER.replace(/\/+$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET ?? '', scopes: env.OIDC_SCOPES || 'openid email profile' };
}

export interface AuthParams {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Where to send the browser to sign in with this provider. */
export async function providerAuthorizeUrl(env: Env, p: ProviderKey, a: AuthParams): Promise<string> {
  if (p === 'microsoft') return entraAuthorizeUrl(env, a);
  if (p === 'email') throw new AppError('invalid', 'Email sign-in has no redirect');
  const c = oidcConf(env, p);
  const d = await discover(c.issuer);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', `${env.BASE_URL}/auth/callback`);
  u.searchParams.set('scope', c.scopes);
  u.searchParams.set('state', a.state);
  u.searchParams.set('nonce', a.nonce);
  u.searchParams.set('code_challenge', a.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  const hd = csv(env.GOOGLE_DOMAINS);
  if (p === 'google' && hd.length === 1) u.searchParams.set('hd', hd[0]!);
  return u.toString();
}

export interface ValidateOpts {
  nonce: string;
  /** Tests: verification keys instead of the provider's JWKS. */
  keys?: JWTVerifyGetKey;
}

/** Validates a provider id_token (signature, issuer, audience, expiry, nonce) and maps it to an Identity. */
export async function validateOidcToken(env: Env, p: 'google' | 'oidc', token: string, opts: ValidateOpts): Promise<Identity> {
  const c = oidcConf(env, p);
  const keys = opts.keys ?? keysFor((await discover(c.issuer)).jwks_uri);
  const issuers = p === 'google' ? ['https://accounts.google.com', 'accounts.google.com'] : [c.issuer, c.issuer + '/'];
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, keys, { issuer: issuers, audience: c.clientId, clockTolerance: 120, requiredClaims: ['exp', 'iat', 'sub', 'nonce'] }));
  } catch (e) {
    throw new AppError('unauthenticated', 'Token validation failed', { reason: e instanceof Error ? e.name : 'error' });
  }
  if (payload['nonce'] !== opts.nonce) throw new AppError('unauthenticated', 'Nonce mismatch');
  const sub = String(payload['sub'] ?? '');
  if (!sub) throw new AppError('unauthenticated', 'Token has no subject');
  const verified = payload['email_verified'] === true || payload['email_verified'] === 'true';
  const email = verified && typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : null;
  const name = typeof payload['name'] === 'string' ? payload['name'] : null;
  let member: boolean;
  if (p === 'google') {
    // A Google account is a member when it belongs to one of the organization's Workspace domains.
    const hd = typeof payload['hd'] === 'string' ? payload['hd'].toLowerCase() : '';
    const domains = csv(env.GOOGLE_DOMAINS).map((d) => d.toLowerCase());
    member = domains.length > 0 && domains.includes(hd) && domainAllowed(env, email);
  } else {
    // The organization's own identity server: its users are members.
    member = domainAllowed(env, email);
  }
  return { tid: p === 'google' ? 'google' : 'oidc:' + c.issuer, oid: sub, email, name, member };
}

/** Code exchange for Google and OIDC (confidential client + PKCE). */
async function oidcExchange(env: Env, p: 'google' | 'oidc', code: string, verifier: string): Promise<string> {
  const c = oidcConf(env, p);
  const d = await discover(c.issuer);
  const body = new URLSearchParams({ client_id: c.clientId, grant_type: 'authorization_code', code, redirect_uri: `${env.BASE_URL}/auth/callback`, code_verifier: verifier });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);
  const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !json.id_token) throw new AppError('unauthenticated', `Sign-in failed${json.error ? `: ${json.error}` : ''}`);
  return json.id_token;
}

/** The identity behind an authorization code from this provider. */
export async function identityFromCode(env: Env, p: ProviderKey, code: string, verifier: string, nonce: string): Promise<Identity> {
  if (p === 'microsoft') {
    const token = await entraExchange(env, code, verifier);
    const id = await entraValidate(env, token, { nonce, allowOutsiders: invitesEnabled(env) });
    return { tid: id.tid, oid: id.oid, email: id.email, name: id.name, member: id.member };
  }
  if (p === 'email') throw new AppError('invalid', 'Email sign-in has no code');
  return validateOidcToken(env, p, await oidcExchange(env, p, code, verifier), { nonce });
}

/** Email links: a member when the domain is one of ALLOWED_EMAIL_DOMAINS (required, so email alone never admits everyone). */
export function emailIdentity(env: Env, email: string): Identity {
  const e = email.trim().toLowerCase();
  const domains = csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase());
  return { tid: 'email', oid: e, email: e, name: null, member: domains.length > 0 && domains.includes(domainOf(e)) };
}

