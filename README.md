# SkillHub

A small, forkable hub where a company keeps its AI agent skills: markdown documents in a folder tree, with versions, a publish pointer, per-folder access, and one MCP endpoint that Claude, ChatGPT and Copilot can connect to. Sign-in is Microsoft Entra ID. Runs on one Cloudflare Worker with D1, R2 and KV.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DorsazWilliam/skillhub)

The Deploy button works when the repository is public. For a private repository use `npm run setup`.

## What you get

- **Three areas.** `rules/` holds short rules every agent receives when it connects (sent as the MCP instructions, capped at 8 KB, with a meter in the app). `skills/` holds one folder per skill: a `SKILL.md` plus templates and scripts (text files, versioned, served as text, never executed), with nested sub-skills. `documentation/` holds free-form reference pages.
- **Folders, documents, versions.** One shared draft per document with optimistic concurrency, immutable versions, and a publish pointer. Rollback is publishing an older version. `publish_skill` publishes a whole skill folder in one step.
- **Canonical links.** `[[documentation/engineering/feature-flags]]` style links between areas, checked for direction (rules to skills and documentation, skills to documentation and their own files, documentation to documentation), with backlinks and a graph of everything you can read. A link to something you cannot read shows as locked and is never named.
- **Authoring warnings.** Saves, commits and publishes return guideline warnings (vague names, descriptions that do not say when, long rules, nested references, broken links and more). They never block, and a dismissal sticks until the flagged text changes.
- **Access like Google Drive.** Viewer, Editor, Publisher, Manager on folders, inherited down the tree, with "don't inherit" boundaries. Teams like GitHub orgs. Viewers only ever see published content.
- **One registry, three surfaces.** Every operation is a REST endpoint, an MCP tool and a typed client call, generated from `src/registry`. `node scripts/check-parity.mjs` enforces it.
- **MCP for chat clients.** OAuth 2.1 with our own consent page and scope checkboxes. Tool lists are filtered by scope. `find_skills` carries a live catalog of the caller's skills.
- **Audit.** Every call, including skill reads, is logged without document bodies. The last 7 days stay queryable in the app; older rows are archived to R2 as gzipped NDJSON twice a day.

## Quick start

Prerequisites: Node 22+, a Cloudflare account on the Workers Paid plan, a zone on that account for the hostname, and an Entra app registration ([docs/ENTRA.md](docs/ENTRA.md)).

```powershell
git clone https://github.com/DorsazWilliam/skillhub
```

```powershell
cd skillhub; npm ci
```

```powershell
npm run setup
```

Setup prints two URLs: the Entra redirect URI to paste into the app registration, and the MCP connector URL to paste into Claude, ChatGPT or Copilot Studio ([docs/CLIENTS.md](docs/CLIENTS.md)). Sign in with an `OWNER_EMAILS` address first; that account becomes owner.

## Pricing

Needs the Workers Paid plan at $5 per month. The free plan's 10 ms CPU limit and daily D1 caps are not suitable. Paid includes 25 billion D1 rows read and 50 million rows written per month and 10 GB of R2. A deployment of a few hundred users stays inside the base price.

## Configuration

`brand.json` holds the name, colour and logos. `wrangler.jsonc` vars:

| Var | Meaning |
| --- | --- |
| `BASE_URL` | `https://skills.example.com`, must match the route |
| `ENTRA_TENANT_ID` | Tenant GUID (single-tenant mode) |
| `ENTRA_ALLOWED_TENANTS` | Comma-separated GUIDs; enables multi-tenant mode |
| `ENTRA_CLIENT_ID` | App registration client id |
| `ALLOWED_EMAIL_DOMAINS` | Optional, can only restrict |
| `ALLOW_GUESTS` | `false` by default |
| `OWNER_EMAILS` | Become owner on first sign-in |
| `MCP_MAX_SCOPES` | Cap for MCP grants, default `read,write,publish,manage` |
| `CATALOG_IN_TOOL_DESC` | Append the skill catalog to `find_skills` |

Secrets (Wrangler only): `ENTRA_CLIENT_SECRET`, `SESSION_SECRET`.

## Development

Run the whole stack locally (Worker, local D1, R2 and KV, the React app) with the Acme demo content. Copy the example variables once; `DEV_LOGIN=true` enables a local-only sign-in as owner, publisher or viewer because Entra needs a tenant ([docs/SECURITY.md](docs/SECURITY.md)).

```powershell
copy .dev.vars.example .dev.vars
```

```powershell
npm run migrate:local
```

```powershell
npm run dev
```

In a second terminal, load the demo (local only, once per fresh state):

```powershell
npm run seed:demo
```

Open http://localhost:8787 and pick Owner, Publisher or Viewer under "Local development". `npm run dev` rebuilds the SPA first; after changing `web/`, run `npm run build` and restart `npm run dev`.

Checks:

```powershell
npm run typecheck
```

```powershell
npx vitest run
```

```powershell
npm run e2e
```

```powershell
node scripts/check-parity.mjs
```

`npm run e2e` starts its own stack on port 8790 with a fresh state, seeds it and runs the Playwright smoke suite. `npm run screenshots` regenerates `docs/screenshots/`. If Playwright cannot download its Chromium, it uses an existing `ms-playwright` Chromium or the installed Chrome (set `PW_EXECUTABLE` to choose).

After changing an operation, run `npm run gen` to regenerate `web/src/api/client.ts`. After editing a built-in skill in `src/seed`, run `node scripts/gen-seed.mjs`; it writes a migration that adds the new text as a version and publishes it wherever the published version is still the built-in one (see the script header before changing the seed again). Licenses of every dependency are in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Layout

```
src/registry   every operation (zod in/out, scope, role, REST + MCP binding, handler)
src/authz      authorize(): the only permission decision
src/auth       Entra OIDC, sessions, PATs, MCP consent
src/http       REST routes and OpenAPI generated from the registry, asset proxy, UI-only routes
src/mcp        stateless MCP server, per-scope tools, catalog
web            React SPA (Vite); web/src/api/client.ts is generated
e2e            Playwright smoke suite and screenshots
migrations     D1 schema and the _hub seed
prototype      clickable UI prototype
docs           ENTRA, DEPLOY, CLIENTS, SECURITY, WHITELABEL, DECISIONS
```

## Docs

[Entra setup](docs/ENTRA.md) · [Deploy](docs/DEPLOY.md) · [Connect clients](docs/CLIENTS.md) · [Security](docs/SECURITY.md) · [White-label](docs/WHITELABEL.md) · [Decisions](docs/DECISIONS.md)

## Status

Backend complete for SPEC milestones M0 to M6. The React SPA reproduces the approved prototype (`prototype/index.html`) on desktop and phone. 129 unit and integration tests (`npx vitest run`) and a 13-test Playwright smoke suite (`npm run e2e`).
