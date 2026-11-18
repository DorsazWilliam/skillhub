import { one, stmt, type UserRow } from '../db/d1';
import { randomToken, sha256Hex } from '../lib/crypto';

export const SESSION_COOKIE = '__Host-skillhub_session';
export const SLIDING_MS = 8 * 3600 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSec: number, sameSite: 'Lax' | 'Strict' = 'Lax'): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export async function createSession(db: D1Database, userId: string): Promise<{ token: string; setCookie: string }> {
  const token = randomToken(32);
  const now = Date.now();
  await stmt(db, 'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)', await sha256Hex(token), userId, now, now + SLIDING_MS, now).run();
  return { token, setCookie: cookie(SESSION_COOKIE, token, ABSOLUTE_MS / 1000) };
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

/** Returns the session user. The caller must still check user.status (done in the auth middleware). */
export async function lookupSession(db: D1Database, token: string): Promise<UserRow | null> {
  const hash = await sha256Hex(token);
  const row = await one<SessionRow & { u: string }>(db, 'SELECT *, user_id AS u FROM sessions WHERE id_hash = ?', hash);
  const now = Date.now();
  if (!row) return null;
  if (row.expires_at <= now || row.created_at + ABSOLUTE_MS <= now) {
    await stmt(db, 'DELETE FROM sessions WHERE id_hash = ?', hash).run();
    return null;
  }
  if (now - row.last_seen_at > TOUCH_EVERY_MS) {
    await stmt(db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', now, Math.min(now + SLIDING_MS, row.created_at + ABSOLUTE_MS), hash).run();
  }
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id);
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await stmt(db, 'DELETE FROM sessions WHERE id_hash = ?', await sha256Hex(token)).run();
}
