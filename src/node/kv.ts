import type { SqlD1 } from './sql';

/**
 * A Workers KV namespace stored in the app's own database (table _kv): what the OAuth provider and the catalog cache need.
 * get/put/delete/list and getWithMetadata, with expiry.
 */
export class SqlKV {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SqlD1) {}

  private ensure(): Promise<void> {
    this.ready ??= this.db
      .exec('CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expires_at BIGINT)')
      .then(() => undefined);
    return this.ready;
  }

  private async row(key: string): Promise<{ value: string; metadata: string | null } | null> {
    await this.ensure();
    const r = await this.db.prepare('SELECT value, metadata, expires_at FROM _kv WHERE key = ?').bind(key).first<{ value: string; metadata: string | null; expires_at: number | null }>();
    if (!r) return null;
    if (r.expires_at !== null && r.expires_at <= Date.now()) {
      await this.db.prepare('DELETE FROM _kv WHERE key = ?').bind(key).run();
      return null;
    }
    return r;
  }

  private static decode(value: string, type: unknown): unknown {
    const t = typeof type === 'string' ? type : ((type as { type?: string } | undefined)?.type ?? 'text');
    if (t === 'json') return JSON.parse(value);
    if (t === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
    if (t === 'stream') return new Response(value).body;
    return value;
  }

  async get(key: string, type?: unknown): Promise<unknown> {
    const r = await this.row(key);
    return r ? SqlKV.decode(r.value, type) : null;
  }

  async getWithMetadata(key: string, type?: unknown): Promise<{ value: unknown; metadata: unknown; cacheStatus: null }> {
    const r = await this.row(key);
    return { value: r ? SqlKV.decode(r.value, type) : null, metadata: r?.metadata ? JSON.parse(r.metadata) : null, cacheStatus: null };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}): Promise<void> {
    await this.ensure();
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer);
    const exp = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : null;
    await this.db
      .prepare(
        'INSERT INTO _kv (key, value, metadata, expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at',
      )
      .bind(key, text, opts.metadata === undefined ? null : JSON.stringify(opts.metadata), exp)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.ensure();
    await this.db.prepare('DELETE FROM _kv WHERE key = ?').bind(key).run();
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string | null } = {}): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
    cacheStatus: null;
  }> {
    await this.ensure();
    const limit = Math.min(1000, opts.limit ?? 1000);
    const prefix = opts.prefix ?? '';
    const rows = (
      await this.db
        .prepare('SELECT key, metadata, expires_at FROM _kv WHERE key > ? AND substr(key, 1, ?) = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?')
        .bind(opts.cursor ?? '', prefix.length, prefix, Date.now(), limit + 1)
        .all<{ key: string; metadata: string | null; expires_at: number | null }>()
    ).results;
    const page = rows.slice(0, limit);
    const done = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
        ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
      })),
      list_complete: done,
      ...(done ? {} : { cursor: page[page.length - 1]!.key }),
      cacheStatus: null,
    };
  }
}
