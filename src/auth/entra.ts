import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { csv, flag, type Env } from '../env';
import { AppError } from '../lib/errors';

export interface EntraIdentity {
  tid: string;
  oid: string;
  email: string | null;
  name: string | null;
  guest: boolean;
}

type EntraEnv = Pick<Env, 'ENTRA_TENANT_ID' | 'ENTRA_ALLOWED_TENANTS' | 'ENTRA_CLIENT_ID' | 'ALLOWED_EMAIL_DOMAINS' | 'ALLOW_GUESTS'>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function allowedTenants(env: EntraEnv): string[] {
  const multi = csv(env.ENTRA_ALLOWED_TENANTS).map((t) => t.toLowerCase());
  return multi.length ? multi : [env.ENTRA_TENANT_ID.toLowerCase()];
}

export function isMultiTenant(env: EntraEnv): boolean {
  return csv(env.ENTRA_ALLOWED_TENANTS).length > 0;
}

/** Authority segment: the tenant in single-tenant mode, "organizations" in multi-tenant mode. */
export function authority(env: EntraEnv): string {
  return isMultiTenant(env) ? 'organizations' : env.ENTRA_TENANT_ID;
}

export function authorizeUrl(env: EntraEnv & { BASE_URL: string }, p: { state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(`https://login.microsoftonline.com/${authority(env)}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', env.ENTRA_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', `${env.BASE_URL}/auth/callback`);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/** Exchanges the authorization code for an id_token (confidential client + PKCE). */
export async function exchangeCode(env: Env, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    client_secret: env.ENTRA_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${env.BASE_URL}/auth/callback`,
    code_verifier: verifier,
    scope: 'openid profile email',
  });
  const res = await fetch(`https://login.microsoftonline.com/${authority(env)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !json.id_token) throw new AppError('unauthenticated', `Sign-in failed${json.error ? `: ${json.error}` : ''}`);
  return json.id_token;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Tenant JWKS, cached per isolate. jose also caches keys and refetches on unknown kid. */
export function remoteKeys(tid: string): JWTVerifyGetKey {
  let k = jwksCache.get(tid);
  if (!k) {
    k = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`), { cacheMaxAge: 24 * 3600 * 1000 });
    jwksCache.set(tid, k);
  }
  return k;
}

export interface ValidateOptions {
  nonce: string;
  keys?: (tid: string) => JWTVerifyGetKey;
  currentDate?: Date;
}

/** SPEC 5.2: every check is mandatory. */
export async function validateIdToken(env: EntraEnv, token: string, opts: ValidateOptions): Promise<EntraIdentity> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(token);
  } catch {
    throw new AppError('unauthenticated', 'Malformed token');
  }
  const tid = typeof unverified['tid'] === 'string' ? unverified['tid'].toLowerCase() : '';
  if (!GUID.test(tid)) throw new AppError('unauthenticated', 'Token has no tenant');
  if (!allowedTenants(env).includes(tid)) throw new AppError('unauthenticated', 'Tenant not allowed');

  const issuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, (opts.keys ?? remoteKeys)(tid), {
      issuer,
      audience: env.ENTRA_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: 120,
      requiredClaims: ['exp', 'iat', 'nonce'],
      ...(opts.currentDate ? { currentDate: opts.currentDate } : {}),
    }));
  } catch (e) {
    throw new AppError('unauthenticated', 'Token validation failed', { reason: e instanceof Error ? e.name : 'error' });
  }
  if (String(payload['tid'] ?? '').toLowerCase() !== tid) throw new AppError('unauthenticated', 'Tenant mismatch');
  if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== opts.nonce) throw new AppError('unauthenticated', 'Nonce mismatch');
  const oid = typeof payload['oid'] === 'string' ? payload['oid'].toLowerCase() : '';
  if (!GUID.test(oid)) throw new AppError('unauthenticated', 'Token has no object id');

  const idp = typeof payload['idp'] === 'string' ? payload['idp'] : null;
  const guest = idp !== null && idp !== payload.iss;
  if (guest && !flag(env.ALLOW_GUESTS)) throw new AppError('forbidden', 'Guest accounts are not allowed');

  const emailClaim = payload['email'] ?? payload['preferred_username'];
  const email = typeof emailClaim === 'string' && emailClaim.includes('@') ? emailClaim.toLowerCase() : null;
  const domains = csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase());
  if (domains.length) {
    const domain = email?.split('@')[1] ?? '';
    if (!domains.includes(domain)) throw new AppError('forbidden', 'Email domain not allowed');
  }
  const name = typeof payload['name'] === 'string' ? payload['name'] : null;
  return { tid, oid, email, name, guest };
}
