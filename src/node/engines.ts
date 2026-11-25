import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Engine, QueryResult } from './sql';
import { translateMigrationPg, translatePg } from './sql';

/** SQLite through Node's built-in node:sqlite. The same SQL dialect as D1. */
export async function sqliteEngine(file: string): Promise<Engine> {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const run = (sql: string, params: unknown[]): QueryResult => {
    const st = db.prepare(sql);
    const p = params as (string | number | null | Uint8Array)[];
    if (st.columns().length > 0) return { rows: st.all(...p) as Record<string, unknown>[], changes: 0 };
    const r = st.run(...p);
    return { rows: [], changes: Number(r.changes) };
  };
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      return run(sql, params);
    },
    // Synchronous inside: no other request can interleave with the transaction.
    async batch(items) {
      db.exec('BEGIN');
      try {
        const out = items.map((i) => run(i.sql, i.params));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}

/** Postgres through node-postgres. Bigints and numerics come back as numbers, like SQLite. */
export async function postgresEngine(url: string): Promise<Engine> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env['DATABASE_POOL'] ?? 10) });
  await pool.query('SELECT 1');
  return {
    dialect: 'postgres',
    /** Runs fn holding a session-level advisory lock (blocking), on one dedicated connection. */
    async withLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [key]);
        return await fn();
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
        c.release();
      }
    },
    async query(sql, params) {
      const r = await pool.query(translatePg(sql), params);
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    },
    async batch(items) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out: QueryResult[] = [];
        for (const i of items) {
          const r = await c.query(translatePg(i.sql), i.params);
          out.push({ rows: r.rows, changes: r.rowCount ?? 0 });
        }
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/** Postgres compiled to WebAssembly, in memory: the test suite and quick local runs, no server needed. */
export async function pgliteEngine(): Promise<Engine> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite({ parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) } });
  return {
    dialect: 'postgres',
    async query(sql, params) {
      const r = await db.query<Record<string, unknown>>(translatePg(sql), params as unknown[]);
      return { rows: r.rows, changes: r.affectedRows ?? 0 };
    },
    async batch(items) {
      return db.transaction(async (tx) => {
        const out: QueryResult[] = [];
        for (const i of items) {
          const r = await tx.query<Record<string, unknown>>(translatePg(i.sql), i.params as unknown[]);
          out.push({ rows: r.rows, changes: r.affectedRows ?? 0 });
        }
        return out;
      });
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

/** Engine from DATABASE_URL: sqlite:<file>, sqlite::memory:, postgres://..., or pglite: (in memory). */
export async function engineFromUrl(url: string): Promise<Engine> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return postgresEngine(url);
  if (url === 'pglite:' || url === 'pglite') return pgliteEngine();
  if (url.startsWith('sqlite:')) return sqliteEngine(url.slice('sqlite:'.length) || ':memory:');
  throw new Error('DATABASE_URL must start with sqlite:, postgres:// or pglite:');
}

/**
 * Applies the SQL files in `dir` (the same migrations D1 uses) that have not run yet, in name order, each in a transaction.
 * Postgres gets them translated. Returns the names applied.
 */
export async function migrate(engine: Engine, dir: string): Promise<string[]> {
  if (engine.dialect !== 'postgres') return migrateUnlocked(engine, dir);
  // Several replicas may start at once: one migrates, the others wait for it, then find nothing left to do.
  return engine.withLock ? engine.withLock(17314, () => migrateUnlocked(engine, dir)) : migrateUnlocked(engine, dir);
}

async function migrateUnlocked(engine: Engine, dir: string): Promise<string[]> {
  await engine.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const done = new Set((await engine.query('SELECT name FROM _migrations', [])).rows.map((r) => String(r['name'])));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    const sql = engine.dialect === 'postgres' ? translateMigrationPg(raw) : raw;
    const name = f.replace(/'/g, "''");
    await engine.exec(`BEGIN;\n${sql}\nINSERT INTO _migrations (name, applied_at) VALUES ('${name}', ${Date.now()});\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}
