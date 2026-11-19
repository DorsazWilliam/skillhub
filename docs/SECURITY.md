# Security

## Model

- **Identity**: Entra ID only. ID tokens are validated per SPEC 5.2: signature against the tenant JWKS, issuer built from the token's own `tid`, `tid` in the allowlist, audience, expiry with 2 minutes skew, nonce, guest rejection, optional domain filter. Users are keyed on `(tid, oid)`, never email.
- **Sessions**: random 256-bit id in `__Host-skillhub_session` (`HttpOnly; Secure; SameSite=Lax`), stored as SHA-256 in D1. 8 hour sliding, 7 day absolute. User status is checked on every request.
- **CSRF**: cookie-authenticated mutations require `X-SkillHub-CSRF: 1` and an `Origin` equal to `BASE_URL`. The MCP consent form is protected by the OAuth library's browser-bound handle.
- **Authorization**: one function, `Authz.authorize()`. Default deny. Unreadable nodes answer `not_found`. Effective permission for tokens is user role AND token scope. MCP scopes are capped by `MCP_MAX_SCOPES`; `admin` is never granted by default.
- **Tokens**: personal access tokens are `shp_` + 256 random bits, stored as SHA-256, compared in constant time. Only a browser session can mint or revoke tokens or MCP connections, so a stolen token cannot create more tokens.
- **MCP**: OAuth 2.1 with PKCE via `@cloudflare/workers-oauth-provider`. Access tokens 1 hour, refresh 30 days sliding, bound to `<BASE_URL>/mcp`. Our own consent page shows client name, verified domain (CIMD) or "unverified", redirect host, a loopback warning, the user and scope checkboxes. Revoking a connection invalidates its tokens immediately.

## Skill content is an injection surface

Skills are instructions that other agents will follow. A malicious or careless edit can steer every agent in the organization. Mitigations built into the design:

- Viewers, and therefore most agents, only ever receive **published** versions. Drafts and history need editor.
- Publishing needs the **publisher** role, and over MCP the `publish` scope, which is unchecked by default at consent.
- Every publish is a pointer move to an immutable version, **diffed** in the publish dialog and **audited** with actor, client and version. Rollback is one publish of the previous version.
- The built-in `hub-promote` skill tells agents never to publish without showing the diff to a human.
- Reads of `get_skill` are audited, so you can see which agents consumed a bad version.

Review publisher grants like you review production deploy rights.

## Web hardening

- Strict CSP: `script-src 'self'`, no inline script, `frame-ancestors 'none'`, `object-src 'none'`. HSTS, `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`.
- Markdown is never rendered as raw HTML; the SPA sanitizes and blocks `javascript:` URLs.
- Uploads: type sniffed from magic bytes (png, jpeg, webp, gif only). SVG rejected. 5 MB cap (1 MB over MCP). Served from `/a/:id` only after authorization, with `nosniff`, `Content-Disposition: inline`, `Content-Security-Policy: sandbox`, private cache. Viewers can only fetch images referenced by the published version.
- Rate limiting on `/mcp`, `/api`, `/auth`, `/authorize`, `/token`, `/register` per client IP.

## Local development sign-in

Entra cannot run locally without a tenant, so the Worker has a DEV-ONLY sign-in at `/auth/dev-login` (owner, publisher, viewer from a fixed list: Alice Chen, Marcus Webb, Tom Becker, with tenant id `dev-local`). It is enabled only when both hold: the variable `DEV_LOGIN` is `true`, and `BASE_URL` has the host `localhost` or `127.0.0.1`. Otherwise both routes answer 404 (unit tested in `test/devlogin.test.ts`). `DEV_LOGIN` lives only in `.dev.vars` (gitignored, see `.dev.vars.example`) and is never set in `wrangler.jsonc`; a deployment on a real hostname cannot turn it on even by mistake, because `BASE_URL` must match its route. The POST requires the CSRF header and the `BASE_URL` origin like every other cookie mutation, and is audited as `login` with `{dev: true}`. With the same two conditions the per-IP rate limiter is skipped, so seeding and the end-to-end suite are not throttled.

## Secrets

Only Wrangler secrets: `ENTRA_CLIENT_SECRET`, `SESSION_SECRET`. Nothing secret in `brand.json`, `wrangler.jsonc` or the repo. Logs are structured JSON without tokens or document bodies. The audit log never stores document content.

Audit retention: 7 days in D1, then gzipped NDJSON in R2 under `audit/` (see DECISIONS 18). To cap how long the archive is kept, add an R2 lifecycle rule:

```powershell
npx wrangler r2 bucket lifecycle add <bucket> audit-retention audit/ --expire-days 365
```

## Personal data and deletion

Stored per user: Entra `tid`, `oid`, display name, email, timestamps. To delete a user (for example a GDPR request), an owner first suspends them in People, then runs:

```powershell
npx wrangler d1 execute DB --remote --command "UPDATE audit_log SET actor_id = NULL, detail = json_set(coalesce(detail,'{}'), '$.anonymized', 1) WHERE actor_id = '<USER_ID>'; DELETE FROM grants WHERE principal_type = 'user' AND principal_id = '<USER_ID>'; DELETE FROM users WHERE id = '<USER_ID>';"
```

This only covers the last 7 days in D1. Archived files under `audit/` in R2 still contain the user id; rewrite or delete the affected files, or rely on the lifecycle rule above.

Sessions, tokens and team memberships cascade. Versions they authored keep the opaque `author_id`, which no longer resolves to a person. Revoke their MCP connections from their account before deleting, or wait for refresh tokens to expire (30 days idle).

## Reporting

Report vulnerabilities privately to the operator of your instance (`brand.json` `supportEmail`).
