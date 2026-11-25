import { one, type UserRow } from '../db/d1';
import type { Env } from '../env';
import type { EntraIdentity } from './entra';
import { signIn } from './signin';

/**
 * Signs in an Entra identity (kept for callers and tests that predate sign-in providers): see signIn in signin.ts.
 * Keyed by (tid, oid). Email and name are refreshed, never used as identity.
 */
export async function upsertUser(env: Pick<Env, 'DB' | 'OWNER_EMAILS'> & Partial<Env>, id: Omit<EntraIdentity, 'member'> & { member?: boolean }): Promise<UserRow> {
  return signIn(env as Env, { tid: id.tid, oid: id.oid, email: id.email, name: id.name, member: id.member ?? true });
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
}
