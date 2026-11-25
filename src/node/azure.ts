import { fromBase64, toBase64 } from '../lib/crypto';
import type { PutOpts } from './blob';

/**
 * Azure Blob Storage with the R2 bucket surface the app uses. Authenticates with the account key (Shared Key) or,
 * without one, the app's managed identity (Azure Container Apps, App Service, AKS workload identity via IMDS).
 */

export interface AzureConfig {
  account: string;
  container: string;
  /** Default https://<account>.blob.core.windows.net. Azurite: http://127.0.0.1:10000/devstoreaccount1 */
  endpoint?: string;
  /** Account key (base64). Omit to use the managed identity. */
  key?: string;
  /** User-assigned managed identity client id. */
  clientId?: string;
}

const VERSION = '2021-08-06';
const enc = new TextEncoder();

type Body = string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null;

async function bytesOf(v: Body): Promise<Uint8Array> {
  if (v === null) return new Uint8Array();
  if (typeof v === 'string') return enc.encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  return new Uint8Array(await new Response(v).arrayBuffer());
}

export class AzureBlobBucket {
  private readonly base: string;
  private token: { value: string; until: number } | null = null;

  constructor(private readonly c: AzureConfig) {
    this.base = (c.endpoint ?? `https://${c.account}.blob.core.windows.net`).replace(/\/+$/, '');
  }

  private url(key?: string, query?: Record<string, string>): URL {
    const u = new URL(this.base + '/' + this.c.container + (key !== undefined ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''));
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u;
  }

  /** Managed identity token for storage (IDENTITY_ENDPOINT on Container Apps and App Service, else IMDS). */
  private async bearer(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 300_000) return this.token.value;
    const resource = 'https://storage.azure.com/';
    let res: Response;
    const ep = process.env['IDENTITY_ENDPOINT'];
    if (ep) {
      const u = new URL(ep);
      u.searchParams.set('resource', resource);
      u.searchParams.set('api-version', '2019-08-01');
      if (this.c.clientId) u.searchParams.set('client_id', this.c.clientId);
      res = await fetch(u, { headers: { 'X-IDENTITY-HEADER': process.env['IDENTITY_HEADER'] ?? '' } });
    } else {
      const u = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
      u.searchParams.set('resource', resource);
      u.searchParams.set('api-version', '2018-02-01');
      if (this.c.clientId) u.searchParams.set('client_id', this.c.clientId);
      res = await fetch(u, { headers: { Metadata: 'true' } });
    }
    if (!res.ok) throw new Error(`Managed identity token: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; expires_on: string | number };
    this.token = { value: j.access_token, until: Number(j.expires_on) * 1000 };
    return j.access_token;
  }

  /** Shared Key: HMAC-SHA256 over the canonical request (Blob service, version 2009-09-19+ format). */
  private async sign(method: string, u: URL, headers: Headers, length: number): Promise<string> {
    const xms = [...headers.entries()]
      .filter(([k]) => k.startsWith('x-ms-'))
      .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${v}\n`)
      .join('');
    const params = [...new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))].sort();
    const resource =
      `/${this.c.account}${u.pathname}` + params.map((k) => `\n${k}:${u.searchParams.getAll(k).join(',')}`).join('');
    const h = (n: string): string => headers.get(n) ?? '';
    const toSign = [method, h('content-encoding'), h('content-language'), length ? String(length) : '', h('content-md5'), h('content-type'), '', '', '', '', '', h('range')].join('\n') + '\n' + xms + resource;
    const key = await crypto.subtle.importKey('raw', fromBase64(this.c.key!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(toSign))));
  }

  private async req(method: string, u: URL, init: { headers?: Record<string, string>; body?: Uint8Array } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-ms-date', new Date().toUTCString());
    headers.set('x-ms-version', VERSION);
    const length = init.body?.length ?? 0;
    if (this.c.key) headers.set('authorization', `SharedKey ${this.c.account}:${await this.sign(method, u, headers, length)}`);
    else headers.set('authorization', `Bearer ${await this.bearer()}`);
    return fetch(u, { method, headers, body: init.body as BodyInit | undefined });
  }

  private static meta(h: Headers): { httpMetadata: { contentType?: string }; customMetadata: Record<string, string> } {
    const customMetadata: Record<string, string> = {};
    h.forEach((v, k) => {
      if (k.startsWith('x-ms-meta-')) customMetadata[k.slice(10)] = v;
    });
    return { httpMetadata: { contentType: h.get('content-type') ?? undefined }, customMetadata };
  }

  async ensureContainer(): Promise<void> {
    const r = await this.req('PUT', this.url(undefined, { restype: 'container' }));
    if (!r.ok && r.status !== 409) throw new Error(`Azure create container: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async put(key: string, value: Body, opts: PutOpts = {}): Promise<Record<string, unknown>> {
    const body = await bytesOf(value);
    const headers: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob', 'content-type': opts.httpMetadata?.contentType ?? 'application/octet-stream' };
    for (const [k, v] of Object.entries(opts.customMetadata ?? {})) headers['x-ms-meta-' + k.toLowerCase()] = v;
    const r = await this.req('PUT', this.url(key), { headers, body });
    if (!r.ok) throw new Error(`Azure put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { key, size: body.length, uploaded: new Date(), httpMetadata: { contentType: headers['content-type'] }, customMetadata: opts.customMetadata ?? {} };
  }

  async get(key: string): Promise<Record<string, unknown> | null> {
    const r = await this.req('GET', this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Azure get ${key}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const m = AzureBlobBucket.meta(r.headers);
    return {
      key,
      size: bytes.length,
      uploaded: new Date(r.headers.get('last-modified') ?? Date.now()),
      ...m,
      get body() {
        return new Response(bytes).body;
      },
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }

  async head(key: string): Promise<Record<string, unknown> | null> {
    const r = await this.req('HEAD', this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Azure head ${key}: ${r.status}`);
    return { key, size: Number(r.headers.get('content-length') ?? 0), uploaded: new Date(r.headers.get('last-modified') ?? Date.now()), ...AzureBlobBucket.meta(r.headers) };
  }

  async delete(keys: string | string[]): Promise<void> {
    await Promise.all(
      (Array.isArray(keys) ? keys : [keys]).map(async (k) => {
        const r = await this.req('DELETE', this.url(k));
        if (!r.ok && r.status !== 404) throw new Error(`Azure delete ${k}: ${r.status}`);
      }),
    );
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    const q: Record<string, string> = { restype: 'container', comp: 'list', maxresults: String(opts.limit ?? 1000) };
    if (opts.prefix) q['prefix'] = opts.prefix;
    if (opts.cursor) q['marker'] = opts.cursor;
    const r = await this.req('GET', this.url(undefined, q));
    if (!r.ok) throw new Error(`Azure list: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const xml = await r.text();
    const tag = (s: string, t: string): string | undefined => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1];
    const unxml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const objects = [...xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)].map((m) => ({
      key: unxml(tag(m[1]!, 'Name') ?? ''),
      size: Number(tag(m[1]!, 'Content-Length') ?? 0),
      uploaded: new Date(tag(m[1]!, 'Last-Modified') ?? Date.now()),
      httpMetadata: {},
      customMetadata: {},
    }));
    const next = tag(xml, 'NextMarker');
    return { objects, truncated: !!next, ...(next ? { cursor: unxml(next) } : {}), delimitedPrefixes: [] };
  }
}
