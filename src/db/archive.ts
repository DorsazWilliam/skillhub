import type { Env } from '../env';
import { all, stmt } from './d1';

const DAY = 86400 * 1000;
export const AUDIT_HOT_DAYS = 7;
const BATCH = 5000;
const MAX_BATCHES = 20;

interface AuditRow {
  id: string;
  ts: number;
  actor_id: string | null;
  via: string;
  client: string | null;
  op: string;
  node_id: string | null;
  version: number | null;
  ok: number;
  detail: string | null;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** R2 key for one batch: dated by its first row, named by its id range so a retried batch overwrites itself. */
export function archiveKey(first: AuditRow, last: AuditRow): string {
  const d = new Date(first.ts).toISOString();
  return `audit/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${first.id}_${last.id}.ndjson.gz`;
}

/**
 * Moves audit rows older than AUDIT_HOT_DAYS from D1 to R2 as gzipped NDJSON, oldest first,
 * in batches of BATCH rows. Each batch is uploaded before its rows are deleted, so a failure
 * leaves rows in D1 and the next run rewrites the same object.
 */
export async function archiveAudit(env: Env, now: number = Date.now()): Promise<{ rows: number; files: string[] }> {
  const cutoff = now - AUDIT_HOT_DAYS * DAY;
  const files: string[] = [];
  let rows = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await all<AuditRow>(
      env.DB,
      'SELECT id, ts, actor_id, via, client, op, node_id, version, ok, detail FROM audit_log WHERE ts < ? ORDER BY ts, id LIMIT ?',
      cutoff,
      BATCH,
    );
    if (!batch.length) break;
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    const body = batch.map((r) => JSON.stringify({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })).join('\n') + '\n';
    const key = archiveKey(first, last);
    await env.BUCKET.put(key, await gzip(body), {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      customMetadata: { rows: String(batch.length), from: String(first.ts), to: String(last.ts) },
    });
    await stmt(env.DB, 'DELETE FROM audit_log WHERE ts < ? AND (ts < ? OR (ts = ? AND id <= ?))', cutoff, last.ts, last.ts, last.id).run();
    files.push(key);
    rows += batch.length;
    if (batch.length < BATCH) break;
  }
  return { rows, files };
}
