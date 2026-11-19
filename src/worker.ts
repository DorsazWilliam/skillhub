import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { buildApp } from './app';
import { mcpHandler } from './mcp/server';
import { SCOPES } from './authz/scopes';
import { cleanup } from './db/cleanup';
import { devLoginEnabled } from './auth/dev';

const app = buildApp();

const providers = new Map<string, OAuthProvider<Env>>();

export function providerOptions(env: Env): OAuthProviderOptions<Env> {
  const base = env.BASE_URL.replace(/\/+$/, '');
  return {
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler: { fetch: (req, e, ctx) => app.fetch(req, e, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: [...SCOPES],
    requiredScopes: ['read'],
    resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    refreshTokenIdleTTL: 30 * 24 * 3600,
    clientIdMetadataDocumentEnabled: true,
  };
}

/** The provider needs absolute URLs, which come from BASE_URL at runtime, so it is built lazily per base URL. */
function provider(env: Env): OAuthProvider<Env> {
  let p = providers.get(env.BASE_URL);
  if (!p) {
    p = new OAuthProvider<Env>(providerOptions(env));
    providers.set(env.BASE_URL, p);
  }
  return p;
}

const RATE_LIMITED = /^\/(mcp|api\/|auth\/|authorize|token|register)/;

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

function secure(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  if (!out.headers.has('content-security-policy')) {
    const type = out.headers.get('content-type') ?? '';
    out.headers.set(
      'content-security-policy',
      type.includes('text/html')
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    );
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip');
    // The local dev stack (DEV_LOGIN on localhost) is not rate limited: seeding and the e2e suite make bursts of calls.
    if (env.RATE_LIMITER && ip && RATE_LIMITED.test(url.pathname) && !devLoginEnabled(env)) {
      const { success } = await env.RATE_LIMITER.limit({ key: `${ip}:${url.pathname.split('/')[1] ?? ''}` });
      if (!success) return secure(Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '60' } }));
    }
    return secure(await provider(env).fetch(request, env, ctx));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
