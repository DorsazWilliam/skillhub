import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { AwsClient } from 'aws4fetch';

/**
 * The R2 bucket surface the app uses (put, get, head, delete, list with prefix and cursor), on local disk or any
 * S3-compatible store (AWS S3, MinIO, Ceph, R2's S3 API, Azure through an S3 gateway).
 */

export interface PutOpts {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface Meta {
  size: number;
  uploaded: number;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

type Body = string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null;

async function bytesOf(v: Body): Promise<Uint8Array> {
  if (v === null) return new Uint8Array();
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  return new Uint8Array(await new Response(v).arrayBuffer());
}

function objectBody(key: string, bytes: Uint8Array, m: Meta): Record<string, unknown> {
  return {
    key,
    size: m.size,
    uploaded: new Date(m.uploaded),
    httpMetadata: m.httpMetadata,
    customMetadata: m.customMetadata,
    get body() {
      return new Response(bytes).body;
    },
    bodyUsed: false,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    blob: async () => new Blob([bytes]),
  };
}

/** Files under a directory; metadata in a sidecar under .meta/. Keys are paths: '..' and absolute keys are refused. */
export class DiskBucket {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string, meta = false): string {
    const p = resolve(this.root, meta ? '.meta' : '', meta ? key + '.json' : key);
    if (!p.startsWith(this.root + sep) || key.split('/').includes('..')) throw new Error('Invalid key');
    return p;
  }

  async put(key: string, value: Body, opts: PutOpts = {}): Promise<Record<string, unknown>> {
    const bytes = await bytesOf(value);
    const m: Meta = { size: bytes.length, uploaded: Date.now(), httpMetadata: opts.httpMetadata ?? {}, customMetadata: opts.customMetadata ?? {} };
    for (const [p, data] of [
      [this.path(key), bytes],
      [this.path(key, true), JSON.stringify(m)],
    ] as const) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    }
    return { key, size: m.size, uploaded: new Date(m.uploaded), httpMetadata: m.httpMetadata, customMetadata: m.customMetadata };
  }

  private async meta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.path(key, true), 'utf8')) as Meta;
    } catch {
      try {
        const s = await stat(this.path(key));
        return { size: s.size, uploaded: s.mtimeMs, httpMetadata: {}, customMetadata: {} };
      } catch {
        return null;
      }
    }
  }

  async get(key: string): Promise<Record<string, unknown> | null> {
    const m = await this.meta(key);
    if (!m) return null;
    try {
      return objectBody(key, new Uint8Array(await readFile(this.path(key))), m);
    } catch {
      return null;
    }
  }

  async head(key: string): Promise<Record<string, unknown> | null> {
    const m = await this.meta(key);
    return m ? { key, size: m.size, uploaded: new Date(m.uploaded), httpMetadata: m.httpMetadata, customMetadata: m.customMetadata } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      await rm(this.path(k), { force: true });
      await rm(this.path(k, true), { force: true });
    }
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== join(this.root, '.meta')) await this.walk(p, out);
      } else out.push(relative(this.root, p).split(sep).join('/'));
    }
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    const all: string[] = [];
    await this.walk(this.root, all);
    const prefix = opts.prefix ?? '';
    const keys = all.filter((k) => k.startsWith(prefix) && (!opts.cursor || k > opts.cursor)).sort();
    const limit = opts.limit ?? 1000;
    const page = keys.slice(0, limit);
    const objects = [];
    for (const k of page) objects.push(await this.head(k));
    const truncated = keys.length > limit;
    return { objects, truncated, ...(truncated ? { cursor: page[page.length - 1] } : {}), delimitedPrefixes: [] };
  }
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (endpoint/bucket/key): MinIO, Ceph, R2. AWS S3 uses virtual-hosted (bucket.endpoint/key). */
  pathStyle: boolean;
}

/** An S3-compatible bucket, signed with SigV4. Custom metadata travels as x-amz-meta-* headers. */
export class S3Bucket {
  private readonly aws: AwsClient;

  constructor(private readonly c: S3Config) {
    this.aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 's3' });
  }

  private base(): string {
    const u = new URL(this.c.endpoint);
    return this.c.pathStyle ? `${u.origin}/${this.c.bucket}` : `${u.protocol}//${this.c.bucket}.${u.host}`;
  }

  private url(key: string): string {
    return this.base() + '/' + key.split('/').map(encodeURIComponent).join('/');
  }

  private static meta(h: Headers): Pick<Meta, 'httpMetadata' | 'customMetadata'> {
    const customMetadata: Record<string, string> = {};
    h.forEach((v, k) => {
      if (k.startsWith('x-amz-meta-')) customMetadata[k.slice(11)] = v;
    });
    return { httpMetadata: { contentType: h.get('content-type') ?? undefined }, customMetadata };
  }

  /** Creates the bucket if it does not exist (S3_CREATE_BUCKET=true, for a bundled store). */
  async ensureBucket(): Promise<void> {
    const r = await this.aws.fetch(this.base() + '/', { method: 'PUT' });
    if (!r.ok && r.status !== 409) throw new Error(`S3 create bucket ${this.c.bucket}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async put(key: string, value: Body, opts: PutOpts = {}): Promise<Record<string, unknown>> {
    const bytes = await bytesOf(value);
    const headers: Record<string, string> = { 'content-type': opts.httpMetadata?.contentType ?? 'application/octet-stream' };
    for (const [k, v] of Object.entries(opts.customMetadata ?? {})) headers['x-amz-meta-' + k.toLowerCase()] = v;
    const r = await this.aws.fetch(this.url(key), { method: 'PUT', body: bytes, headers });
    if (!r.ok) throw new Error(`S3 put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { key, size: bytes.length, uploaded: new Date(), httpMetadata: { contentType: headers['content-type'] }, customMetadata: opts.customMetadata ?? {} };
  }

  async get(key: string): Promise<Record<string, unknown> | null> {
    const r = await this.aws.fetch(this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 get ${key}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const m = S3Bucket.meta(r.headers);
    return objectBody(key, bytes, { size: bytes.length, uploaded: Date.parse(r.headers.get('last-modified') ?? '') || Date.now(), ...m });
  }

  async head(key: string): Promise<Record<string, unknown> | null> {
    const r = await this.aws.fetch(this.url(key), { method: 'HEAD' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 head ${key}: ${r.status}`);
    return { key, size: Number(r.headers.get('content-length') ?? 0), uploaded: new Date(r.headers.get('last-modified') ?? Date.now()), ...S3Bucket.meta(r.headers) };
  }

  async delete(keys: string | string[]): Promise<void> {
    await Promise.all(
      (Array.isArray(keys) ? keys : [keys]).map(async (k) => {
        const r = await this.aws.fetch(this.url(k), { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error(`S3 delete ${k}: ${r.status}`);
      }),
    );
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ 'list-type': '2', 'max-keys': String(opts.limit ?? 1000) });
    if (opts.prefix) q.set('prefix', opts.prefix);
    if (opts.cursor) q.set('continuation-token', opts.cursor);
    const r = await this.aws.fetch(this.base() + '/?' + q.toString());
    if (!r.ok) throw new Error(`S3 list: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const xml = await r.text();
    const tag = (s: string, t: string): string | undefined => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1];
    const unxml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
      key: unxml(tag(m[1]!, 'Key') ?? ''),
      size: Number(tag(m[1]!, 'Size') ?? 0),
      uploaded: new Date(tag(m[1]!, 'LastModified') ?? Date.now()),
      httpMetadata: {},
      customMetadata: {},
    }));
    const truncated = tag(xml, 'IsTruncated') === 'true';
    const next = tag(xml, 'NextContinuationToken');
    return { objects, truncated, ...(truncated && next ? { cursor: unxml(next) } : {}), delimitedPrefixes: [] };
  }
}
