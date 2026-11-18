# Deploying

SkillHub runs as one Worker on a hostname in a zone you already have on Cloudflare (for example `skills.contoso.com` under `contoso.com`). The route in `wrangler.jsonc` is a Custom Domain, so Cloudflare creates the DNS record and certificate on deploy.

## First deploy

```powershell
npm ci
npm run setup
```

`setup` asks for the hostname, tenant id, client id, owner email and client secret, writes `wrangler.jsonc`, provisions D1, R2 and KV (automatic, with an explicit fallback), sets secrets, applies migrations, deploys, and prints the Entra redirect URI and the MCP connector URL.

## Manual equivalent

1. Edit `wrangler.jsonc`: `routes[0].pattern`, `BASE_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `OWNER_EMAILS`.
2. `npx wrangler deploy` (provisions bindings without ids).
3. `npx wrangler secret put ENTRA_CLIENT_SECRET` and `npx wrangler secret put SESSION_SECRET`.
4. `npx wrangler d1 migrations apply DB --remote`.

## CI

Both `.github/workflows/deploy.yml` and `bitbucket-pipelines.yml` run typecheck, parity, tests, then on `main` apply migrations and deploy. Set `CLOUDFLARE_API_TOKEN` (Workers, D1, R2, KV edit permissions on the account, plus Zone DNS edit for the custom domain) and `CLOUDFLARE_ACCOUNT_ID` as secrets.

Migrations must be backward compatible with the version still running: add columns and tables, backfill, and remove only in a later release.

## Local development

```powershell
copy .dev.vars.example .dev.vars
npm run migrate:local
npm run dev
```

Add `http://localhost:8787/auth/callback` as a second redirect URI on a dev app registration.
