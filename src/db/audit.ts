import { ulid } from '../lib/ulid';
import { stmt } from './d1';

export type Via = 'ui' | 'rest' | 'mcp' | 'system';

export interface AuditEntry {
  actorId: string | null;
  via: Via;
  client: string | null;
  op: string;
  nodeId: string | null;
  version: number | null;
  ok: boolean;
  detail: Record<string, unknown> | null;
}

/** Keys that must never reach the audit log. */
const BODY_KEYS = new Set(['content', 'markdown', 'body', 'data_base64', 'patch', 'zip_base64', 'token']);

export function scrub(detail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (BODY_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.length > 300) out[k] = v.slice(0, 300);
    else out[k] = v;
  }
  return out;
}

export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  const detail = scrub(e.detail);
  return stmt(
    db,
    'INSERT INTO audit_log (id, ts, actor_id, via, client, op, node_id, version, ok, detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ulid(),
    Date.now(),
    e.actorId,
    e.via,
    e.client,
    e.op,
    e.nodeId,
    e.version,
    e.ok ? 1 : 0,
    detail ? JSON.stringify(detail) : null,
  );
}
