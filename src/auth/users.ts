import { one, stmt, type UserRow } from '../db/d1';
import { csv, type Env } from '../env';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ulid';
import type { EntraIdentity } from './entra';

/** Upserts the user keyed by (tid, oid). Email and name are refreshed, never used as identity. */
export async function upsertUser(env: Pick<Env, 'DB' | 'OWNER_EMAILS'>, id: EntraIdentity): Promise<UserRow> {
  const now = Date.now();
  const existing = await one<UserRow>(env.DB, 'SELECT * FROM users WHERE tid = ? AND oid = ?', id.tid, id.oid);
  if (existing) {
    if (existing.status !== 'active') throw new AppError('forbidden', 'Your account is suspended');
    await stmt(env.DB, 'UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?', id.email, id.name, now, existing.id).run();
    return { ...existing, email: id.email, name: id.name, last_login_at: now };
  }
  const owners = csv(env.OWNER_EMAILS).map((e) => e.toLowerCase());
  const role = id.email && owners.includes(id.email) ? 'owner' : 'member';
  const user: UserRow = {
    id: ulid(),
    tid: id.tid,
    oid: id.oid,
    email: id.email,
    name: id.name,
    org_role: role,
    status: 'active',
    created_at: now,
    last_login_at: now,
  };
  await stmt(
    env.DB,
    'INSERT INTO users (id, tid, oid, email, name, org_role, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tid, oid) DO NOTHING',
    user.id,
    user.tid,
    user.oid,
    user.email,
    user.name,
    user.org_role,
    user.status,
    user.created_at,
    user.last_login_at,
  ).run();
  return (await one<UserRow>(env.DB, 'SELECT * FROM users WHERE tid = ? AND oid = ?', id.tid, id.oid)) ?? user;
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
}
