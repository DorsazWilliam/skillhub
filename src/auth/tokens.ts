import { one, stmt, type UserRow } from '../db/d1';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { ulid } from '../lib/ulid';
import { parseScopes, type Scope } from '../authz/scopes';

export const PAT_PREFIX = 'shp_';

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export async function mintToken(db: D1Database, userId: string, name: string, scopes: Scope[], expiresInDays: number | null): Promise<{ id: string; token: string; expires_at: number | null }> {
  const token = PAT_PREFIX + randomToken(32);
  const id = ulid();
  const now = Date.now();
  const expires = expiresInDays ? now + expiresInDays * 86400 * 1000 : null;
  await stmt(
    db,
    'INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
    id,
    userId,
    name,
    await sha256Hex(token),
    scopes.join(','),
    expires,
    now,
  ).run();
  return { id, token, expires_at: expires };
}

export async function verifyToken(db: D1Database, token: string): Promise<{ user: UserRow; scopes: Set<Scope>; name: string } | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const row = await one<TokenRow>(db, 'SELECT * FROM api_tokens WHERE token_hash = ?', hash);
  if (!row || !safeEqual(row.token_hash, hash)) return null;
  const now = Date.now();
  if (row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
  const user = await one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    await stmt(db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.id).run();
  }
  return { user, scopes: parseScopes(row.scopes), name: row.name };
}

export async function revokeToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const res = await stmt(db, 'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Date.now(), id, userId).run();
  return (res.meta.changes ?? 0) > 0;
}
