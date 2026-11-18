import type { Env } from '../env';
import { all, stmt } from './d1';
import { auditStmt } from './audit';

const DAY = 86400 * 1000;

/**
 * Daily cron:
 * - assets not referenced by any version or draft for 7 days are deleted from R2 and D1
 * - audit rows older than 365 days are deleted
 * - expired sessions and login attempts are swept
 */
export async function cleanup(env: Env, now: number = Date.now()): Promise<{ assets: number; audit: number }> {
  const candidates = await all<{ id: string; r2_key: string }>(
    env.DB,
    `SELECT a.id, a.r2_key FROM assets a WHERE a.deleted_at IS NULL AND a.created_at < ?
     AND NOT EXISTS (SELECT 1 FROM doc_versions v WHERE v.doc_id = a.doc_id AND instr(v.content, 'asset://' || a.id) > 0)
     AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.doc_id = a.doc_id AND instr(d.content, 'asset://' || a.id) > 0)
     LIMIT 500`,
    now - 7 * DAY,
  );
  if (candidates.length) {
    await env.BUCKET.delete(candidates.map((c) => c.r2_key));
    await env.DB.batch(candidates.map((c) => stmt(env.DB, 'UPDATE assets SET deleted_at = ? WHERE id = ?', now, c.id)));
  }
  const res = await env.DB.batch([
    stmt(env.DB, 'DELETE FROM audit_log WHERE ts < ?', now - 365 * DAY),
    stmt(env.DB, 'DELETE FROM sessions WHERE expires_at < ?', now),
    stmt(env.DB, 'DELETE FROM login_attempts WHERE expires_at < ?', now),
  ]);
  const audit = res[0]?.meta.changes ?? 0;
  await auditStmt(env.DB, { actorId: null, via: 'system', client: 'cron', op: 'cleanup', nodeId: null, version: null, ok: true, detail: { assets: candidates.length, audit } }).run();
  return { assets: candidates.length, audit };
}
