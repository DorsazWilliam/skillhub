import { env, exports } from 'cloudflare:workers';
import type { UserRow } from '../src/db/d1';
import { createSession } from '../src/auth/session';
import { mintToken } from '../src/auth/tokens';
import { ulid } from '../src/lib/ulid';
import type { Scope } from '../src/authz/scopes';

export const BASE = 'https://skills.test';

let seq = 0;

export async function makeUser(opts: { role?: 'owner' | 'member'; status?: 'active' | 'suspended'; email?: string; name?: string } = {}): Promise<UserRow> {
  seq++;
  const u: UserRow = {
    id: ulid(),
    tid: '11111111-1111-1111-1111-111111111111',
    oid: crypto.randomUUID(),
    email: opts.email ?? `user${seq}-${Math.random().toString(36).slice(2, 7)}@contoso.test`,
    name: opts.name ?? `User ${seq}`,
    org_role: opts.role ?? 'member',
    status: opts.status ?? 'active',
    created_at: Date.now(),
    last_login_at: null,
  };
  await env.DB.prepare('INSERT INTO users (id, tid, oid, email, name, org_role, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(u.id, u.tid, u.oid, u.email, u.name, u.org_role, u.status, u.created_at)
    .run();
  return u;
}

export async function makeTeam(name: string, members: { user: UserRow; role?: 'member' | 'maintainer' }[] = []): Promise<string> {
  const id = ulid();
  await env.DB.prepare('INSERT INTO teams (id, name, created_at) VALUES (?,?,?)').bind(id, name, Date.now()).run();
  for (const m of members) {
    await env.DB.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?,?,?,?)').bind(id, m.user.id, m.role ?? 'member', Date.now()).run();
  }
  return id;
}

export interface Client {
  user: UserRow;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper returns arbitrary JSON
  raw: (path: string, init?: RequestInit) => Promise<Response>;
}

async function fetchSelf(path: string, init: RequestInit = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(BASE + path, init));
}

/** A browser session client (all scopes, CSRF headers set). */
export async function sessionClient(user: UserRow): Promise<Client> {
  const { token } = await createSession(env.DB, user.id);
  const cookie = `__Host-skillhub_session=${token}`;
  const raw = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (!headers.has('origin')) headers.set('origin', BASE);
    headers.set('x-skillhub-csrf', '1');
    return fetchSelf(path, { ...init, headers });
  };
  return { user, raw, call: (m, p, b) => jsonCall(raw, m, p, b) };
}

/** A personal access token client with the given scopes. */
export async function tokenClient(user: UserRow, scopes: Scope[]): Promise<Client> {
  const { token } = await mintToken(env.DB, user.id, 'test', scopes, null);
  const raw = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetchSelf(path, { ...init, headers });
  };
  return { user, raw, call: (m, p, b) => jsonCall(raw, m, p, b) };
}

async function jsonCall(raw: Client['raw'], method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await raw('/api/v1' + path, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export { fetchSelf };

export const enc = encodeURIComponent;
