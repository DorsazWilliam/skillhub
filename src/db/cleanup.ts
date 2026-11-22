import type { Env } from '../env';
import { all, stmt } from './d1';
import { auditStmt } from './audit';
import { archiveAudit } from './archive';
import { pruneUsageStmt } from './usage';

const DAY = 86400 * 1000;

/**
 * Cron (twice a day):
 * - assets not referenced by any version or draft for 7 days are deleted from R2 and D1
 * - audit rows older than 7 days are archived to R2 (audit/YYYY/MM/DD/*.ndjson.gz) and deleted from D1
 * - expired sessions and login attempts are swept, usage older than 90 days is dropped
 * - prototype renders older than a day (their links expire after 24 hours) are deleted from R2
 */
export async function cleanup(env: Env, now: number = Date.now()): Promise<{ assets: number; audit: number; files: string[] }> {
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
  await env.DB.batch([
    stmt(env.DB, 'DELETE FROM sessions WHERE expires_at < ?', now),
    stmt(env.DB, 'DELETE FROM login_attempts WHERE expires_at < ?', now),
    pruneUsageStmt(env.DB, now),
  ]);
  const renders = await sweepRenders(env, now);
  const archived = await archiveAudit(env, now);
  await auditStmt(env.DB, { actorId: null, via: 'system', client: 'cron', op: 'cleanup', nodeId: null, version: null, ok: true, detail: { assets: candidates.length, renders, audit_archived: archived.rows, files: archived.files.length } }).run();
  return { assets: candidates.length, audit: archived.rows, files: archived.files };
}

/** Deletes rendered prototype screenshots older than a day, up to 1000 per run. */
async function sweepRenders(env: Env, now: number): Promise<number> {
  const old: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5 && old.length < 1000; i++) {
    const page = await env.BUCKET.list({ prefix: 'renders/', limit: 1000, cursor });
    for (const o of page.objects) if (o.uploaded.getTime() < now - DAY) old.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  if (old.length) await env.BUCKET.delete(old.slice(0, 1000));
  return Math.min(old.length, 1000);
}
