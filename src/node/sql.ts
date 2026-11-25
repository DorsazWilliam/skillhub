/**
 * A D1-compatible database over SQLite (node:sqlite) or Postgres (pg, or PGlite in tests).
 * The app talks to the D1 API (prepare/bind/first/all/run/batch); this file is the only place that knows the engine.
 * Postgres gets SQLite-dialect SQL translated by `translatePg` (placeholders and a few functions).
 */

export type Dialect = 'sqlite' | 'postgres';

export interface QueryResult {
  rows: Record<string, unknown>[];
  changes: number;
}

/** What an engine provides. `batch` runs statements in one transaction, all or nothing. */
export interface Engine {
  dialect: Dialect;
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  batch(items: { sql: string; params: unknown[] }[]): Promise<QueryResult[]>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** Postgres: run fn while holding an advisory lock, so replicas take turns (migrations). */
  withLock?<T>(key: number, fn: () => Promise<T>): Promise<T>;
}

function meta(changes: number): Record<string, unknown> {
  return { changes, duration: 0, last_row_id: 0, rows_read: 0, rows_written: changes, changed_db: changes > 0, size_after: 0 };
}

const norm = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Statement {
  constructor(
    private readonly db: SqlD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params.map(norm));
  }

  async first<T>(col?: string): Promise<T | null> {
    const r = await this.db.engine.query(this.sql, this.params);
    const row = r.rows[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const r = await this.db.engine.query(this.sql, this.params);
    return { results: r.rows as T[], success: true, meta: meta(r.changes) };
  }

  async run(): Promise<{ results: unknown[]; success: true; meta: Record<string, unknown> }> {
    const r = await this.db.engine.query(this.sql, this.params);
    return { results: r.rows, success: true, meta: meta(r.changes) };
  }

  async raw<T>(): Promise<T[]> {
    const r = await this.db.engine.query(this.sql, this.params);
    return r.rows.map((row) => Object.values(row)) as T[];
  }
}

/** The D1Database surface the app uses. `dialect` lets the few engine-specific queries choose their SQL. */
export class SqlD1 {
  constructor(readonly engine: Engine) {}

  get dialect(): Dialect {
    return this.engine.dialect;
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  async batch(stmts: Statement[]): Promise<{ results: unknown[]; success: true; meta: Record<string, unknown> }[]> {
    const out = await this.engine.batch(stmts.map((s) => ({ sql: s.sql, params: s.params })));
    return out.map((r) => ({ results: r.rows, success: true as const, meta: meta(r.changes) }));
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    await this.engine.exec(sql);
    return { count: 1, duration: 0 };
  }

  withSession(): SqlD1 {
    return this;
  }
}

/** The dialect of a D1-like database: Cloudflare's D1 and node:sqlite are 'sqlite'. */
export function dialectOf(db: unknown): Dialect {
  return (db as { dialect?: Dialect }).dialect === 'postgres' ? 'postgres' : 'sqlite';
}

// ---------- SQLite dialect -> Postgres ----------

const cache = new Map<string, string>();

/** Replaces each `?` outside quotes with $1, $2, ... */
function placeholders(sql: string): string {
  let out = '';
  let n = 0;
  let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (q) {
      out += c;
      if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      q = c;
      out += c;
    } else if (c === '?') out += '$' + ++n;
    else out += c;
  }
  return out;
}

/** Runtime queries: placeholders, instr -> strpos, byte length. */
export function translatePg(sql: string): string {
  let t = cache.get(sql);
  if (t) return t;
  t = placeholders(sql)
    .replace(/\binstr\(/gi, 'strpos(')
    .replace(/length\(CAST\(([^()]+?) AS BLOB\)\)/gi, 'octet_length($1)')
    .replace(/\s+COLLATE NOCASE/gi, '');
  if (cache.size > 2000) cache.clear();
  cache.set(sql, t);
  return t;
}

const FTS_WEIGHT: Record<string, string> = { name: 'A', description: 'B', body: 'C' };

/**
 * Migrations: SQLite DDL -> Postgres DDL. INTEGER becomes BIGINT (timestamps are milliseconds), FTS5 tables become
 * tables with a generated, weighted tsvector and a GIN index, and NOCASE uniqueness becomes a unique index on lower().
 */
export function translateMigrationPg(sql: string): string {
  let out = sql.replace(/\bINTEGER\b/g, 'BIGINT');
  out = out.replace(/CREATE VIRTUAL TABLE (\w+) USING fts5\(([\s\S]*?)\);/g, (_m, table: string, cols: string) => {
    const names = cols
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c && !/^tokenize\s*=/.test(c))
      .map((c) => c.split(/\s+/)[0]!);
    const indexed = names.filter((c) => c !== 'doc_id');
    const tsv = indexed.map((c) => `setweight(to_tsvector('english', coalesce(${c}, '')), '${FTS_WEIGHT[c] ?? 'D'}')`).join(' || ');
    return (
      `CREATE TABLE ${table} (${names.map((c) => `${c} TEXT`).join(', ')}, tsv tsvector GENERATED ALWAYS AS (${tsv}) STORED);\n` +
      `CREATE INDEX ${table}_doc ON ${table} (doc_id);\nCREATE INDEX ${table}_tsv ON ${table} USING gin (tsv);`
    );
  });
  const nocase: string[] = [];
  out = out.replace(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g, (m, table: string, body: string) => {
    const re = /^\s*(\w+) TEXT NOT NULL COLLATE NOCASE UNIQUE/m;
    const hit = re.exec(body);
    if (!hit) return m;
    nocase.push(`CREATE UNIQUE INDEX ${table}_${hit[1]}_nocase ON ${table} (lower(${hit[1]}));`);
    return m.replace(re, (s) => s.replace(' COLLATE NOCASE UNIQUE', ''));
  });
  return nocase.length ? out + '\n' + nocase.join('\n') + '\n' : out;
}

/** A full-text query (from ftsQuery's quoted, OR-ed tokens with a trailing prefix *) as a Postgres tsquery string. */
export function tsqueryFromFts(expr: string): string {
  const parts = expr.split(/\s+OR\s+/).map((p) => p.trim());
  return parts
    .map((p) => {
      const prefix = p.endsWith('*');
      const tok = p.replace(/\*$/, '').replace(/^"|"$/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
      return tok ? tok + (prefix ? ':*' : '') : '';
    })
    .filter(Boolean)
    .join(' | ');
}
