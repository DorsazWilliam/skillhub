import { stmt } from './d1';

const DAY = 86400 * 1000;
/** Days of usage kept in D1. */
export const USAGE_DAYS = 90;
/** At most this many result rows are counted as shown per call. */
const MAX_SHOWN = 25;

/** What one MCP call contributes to usage: a load and/or the nodes it returned. */
export interface UsageInfo {
  load?: string | null;
  shown?: string[];
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The `days` UTC day keys ending today, oldest first. */
export function dayKeys(days: number, now: number = Date.now()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(now - i * DAY));
  return out;
}

export function usageStmts(db: D1Database, actorId: string, u: UsageInfo, now: number = Date.now()): D1PreparedStatement[] {
  const day = dayKey(now);
  const out: D1PreparedStatement[] = [];
  if (u.load) {
    out.push(
      stmt(
        db,
        `INSERT INTO usage_daily (day, node_id, actor_id, loads, shown, last_load_at) VALUES (?,?,?,1,0,?)
         ON CONFLICT (day, node_id, actor_id) DO UPDATE SET loads = usage_daily.loads + 1, last_load_at = excluded.last_load_at`,
        day,
        u.load,
        actorId,
        now,
      ),
    );
  }
  for (const id of [...new Set(u.shown ?? [])].slice(0, MAX_SHOWN)) {
    out.push(
      stmt(
        db,
        `INSERT INTO usage_daily (day, node_id, actor_id, loads, shown) VALUES (?,?,?,0,1)
         ON CONFLICT (day, node_id, actor_id) DO UPDATE SET shown = usage_daily.shown + 1`,
        day,
        id,
        actorId,
      ),
    );
  }
  return out;
}

export function pruneUsageStmt(db: D1Database, now: number = Date.now()): D1PreparedStatement {
  return stmt(db, 'DELETE FROM usage_daily WHERE day < ?', dayKey(now - USAGE_DAYS * DAY));
}
