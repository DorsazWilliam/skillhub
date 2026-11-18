export async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** Placeholder list for IN (...) clauses. */
export function qs(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: 'folder' | 'doc';
  name: string;
  path: string;
  inherit: number;
  head_version: number;
  published_version: number | null;
  is_skill: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
}

export interface UserRow {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  name: string | null;
  org_role: 'owner' | 'member';
  status: 'active' | 'suspended';
  created_at: number;
  last_login_at: number | null;
}

export function chainIds(path: string): string[] {
  return path.split('/').filter(Boolean);
}
