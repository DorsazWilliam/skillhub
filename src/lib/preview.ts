import { fromBase64, safeEqual, toBase64Url } from './crypto';

/**
 * Signed, short-lived capability links for prototype previews (/p/<token>/...) and rendered images (/r/<token>).
 * A token names what it opens, who minted it and when it expires; it is checked again on every request
 * (the user must still be active and still have access). Signed with SESSION_SECRET (HMAC-SHA256).
 */

export type PreviewMode = 'published' | 'working';

export interface PreviewClaims {
  /** 'p' = a prototype folder, 'r' = a rendered image in R2. */
  t: 'p' | 'r';
  /** Prototype folder id, or the render id. */
  id: string;
  /** Prototype previews: which content to serve. */
  m?: PreviewMode;
  /** User who minted the link. */
  u: string;
  /** Expiry, unix seconds. */
  e: number;
}

export const PREVIEW_TTL_S = 60 * 60;
export const RENDER_TTL_S = 24 * 60 * 60;

const enc = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode('skillhub-preview\u0000' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sig(secret: string, body: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body))));
}

function fromB64Url(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b + '='.repeat((4 - (b.length % 4)) % 4));
}

export async function signPreview(secret: string, claims: PreviewClaims): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(claims)));
  return body + '.' + (await sig(secret, body));
}

/** The claims of a valid, unexpired token, or null. */
export async function verifyPreview(secret: string, token: string, now = Date.now()): Promise<PreviewClaims | null> {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined || token.length > 1024) return null;
  if (!safeEqual(mac, await sig(secret, body))) return null;
  let c: unknown;
  try {
    c = JSON.parse(new TextDecoder().decode(fromB64Url(body)));
  } catch {
    return null;
  }
  if (typeof c !== 'object' || c === null) return null;
  const v = c as Partial<PreviewClaims>;
  if ((v.t !== 'p' && v.t !== 'r') || typeof v.id !== 'string' || typeof v.u !== 'string' || typeof v.e !== 'number') return null;
  if (v.t === 'p' && v.m !== 'published' && v.m !== 'working') return null;
  if (v.e * 1000 < now) return null;
  return v as PreviewClaims;
}

/** Content types for prototype files, by extension. Unknown text is served as plain text. */
export function webContentType(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml; charset=utf-8',
    md: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
  };
  return map[ext] ?? 'text/plain; charset=utf-8';
}
