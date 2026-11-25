import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  OAUTH_KV: KVNamespace;
  ASSETS?: Fetcher;
  RATE_LIMITER?: RateLimit;
  /** Browser Run binding, used by render_prototype. Optional: without it, rendering answers that it is not configured. */
  BROWSER?: Fetcher;
  /** Node runtime: opens a Puppeteer browser (a Chromium container). Used by render_prototype instead of BROWSER. */
  LAUNCH_BROWSER?: () => Promise<unknown>;
  OAUTH_PROVIDER: OAuthHelpers;

  BASE_URL: string;
  ENTRA_TENANT_ID: string;
  ENTRA_ALLOWED_TENANTS?: string;
  ENTRA_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOW_GUESTS?: string;
  OWNER_EMAILS?: string;
  MCP_MAX_SCOPES?: string;
  CATALOG_IN_TOOL_DESC?: string;
  /** Local development only: enables /auth/dev-login when BASE_URL is localhost. Never set in wrangler.jsonc. */
  DEV_LOGIN?: string;

  ENTRA_CLIENT_SECRET: string;

  /** Sign-in methods, comma separated: microsoft, google, oidc, email. Default: microsoft. */
  AUTH_PROVIDERS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google Workspace domains whose users are members (the hd claim). */
  GOOGLE_DOMAINS?: string;
  /** Your own OpenID Connect identity server (Keycloak, Okta, Authentik, ADFS...). */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_NAME?: string;
  OIDC_SCOPES?: string;
  /** Invitations for people outside the organization. On unless 'false'. */
  ALLOW_INVITES?: string;
  /** Email sending: 'smtp' (Node, SMTP_URL), 'resend' (RESEND_API_KEY), 'log' or 'memory' (tests). */
  EMAIL_TRANSPORT?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** Node runtime: sends a message through SMTP_URL. */
  SEND_MAIL?: (m: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;
  SESSION_SECRET: string;
}

export function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function flag(value: string | undefined): boolean {
  return (value ?? '').toLowerCase() === 'true';
}
