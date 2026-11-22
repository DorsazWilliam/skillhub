import { Hono } from 'hono';
import { one, type NodeRow } from '../db/d1';
import { Authz } from '../authz/authorize';
import { ROLE } from '../authz/roles';
import { getUser } from '../auth/users';
import { verifyPreview, webContentType } from '../lib/preview';
import { getNodeById } from '../registry/shared';
import { protoFileAt, protoOf } from '../registry/prototypes';
import type { AppEnv } from './context';

/**
 * /p/<token>/<path>: a prototype's files, from a signed link minted by get_prototype or render_prototype.
 * The response carries a sandbox CSP: the page runs in an opaque origin, so its scripts never act with
 * the viewer's session, even when the link is opened directly. External scripts, styles and fonts are allowed.
 * /r/<token>: a PNG rendered by render_prototype.
 * Both re-check, on every request, that the user who minted the link is active and still has access.
 */

const PROTO_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "frame-ancestors 'self'",
].join('; ');

function gone(status = 404, text = 'Not found or link expired'): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' },
  });
}

async function actorFor(db: D1Database, userId: string): Promise<Authz | null> {
  const user = await getUser(db, userId);
  if (!user || user.status !== 'active') return null;
  return new Authz(db, { user, scopes: new Set(['read']), via: 'ui', client: 'preview' });
}

export function prototypeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/p/:token/*', async (c) => {
    const claims = await verifyPreview(c.env.SESSION_SECRET, c.req.param('token'));
    if (!claims || claims.t !== 'p') return gone();
    const az = await actorFor(c.env.DB, claims.u);
    if (!az) return gone();
    const proto = await getNodeById(c.env.DB, claims.id);
    if (!proto || (await protoOf(c.env.DB, proto))?.id !== proto.id) return gone();

    const prefix = `/p/${c.req.param('token')}/`;
    const url = new URL(c.req.url);
    // Without the trailing slash, relative URLs in index.html would resolve outside the prototype.
    if (url.pathname === prefix.slice(0, -1)) return c.redirect(prefix + url.search, 301);
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return gone(400, 'Bad path');
    }
    const file = await protoFileAt(c.env.DB, proto, rel);
    if (!file) return gone();
    const role = await az.role(file);
    const working = claims.m === 'working';
    if (role < (working ? ROLE.editor : ROLE.viewer)) return gone();

    let content: string | null = null;
    if (working) {
      content =
        (await one<{ content: string }>(c.env.DB, 'SELECT content FROM drafts WHERE doc_id = ?', file.id))?.content ??
        (file.head_version ? ((await one<{ content: string }>(c.env.DB, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', file.id, file.head_version))?.content ?? null) : null);
    } else if (file.published_version) {
      content = (await one<{ content: string }>(c.env.DB, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', file.id, file.published_version))?.content ?? null;
    }
    if (content === null) return gone();
    return new Response(content, {
      headers: {
        'content-type': webContentType(file.name),
        'content-security-policy': PROTO_CSP,
        'x-frame-options': 'SAMEORIGIN',
        // The token is in the URL: never send it to the CDNs a prototype loads.
        'referrer-policy': 'no-referrer',
        'cache-control': working ? 'no-store' : 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.get('/r/:token', async (c) => {
    const claims = await verifyPreview(c.env.SESSION_SECRET, c.req.param('token'));
    if (!claims || claims.t !== 'r') return gone();
    const az = await actorFor(c.env.DB, claims.u);
    if (!az) return gone();
    const obj = await c.env.BUCKET.get(`renders/${claims.id}.png`);
    if (!obj) return gone();
    const protoId = obj.customMetadata?.['proto'];
    const proto: NodeRow | null = protoId ? await getNodeById(c.env.DB, protoId) : null;
    if (!proto) return gone();
    const need = obj.customMetadata?.['mode'] === 'working' ? ROLE.editor : ROLE.viewer;
    if ((await az.role(proto)) < need) return gone();
    return new Response(obj.body, {
      headers: {
        'content-type': 'image/png',
        'content-disposition': 'inline; filename="prototype.png"',
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
      },
    });
  });

  return app;
}
