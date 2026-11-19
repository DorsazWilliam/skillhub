# Decisions and deviations

SPEC.md is the source of truth. Every deviation or interpretation is recorded here with its reason.

## Verified before coding (SPEC 22), November 2026

| Item | Finding | Consequence |
| --- | --- | --- |
| `@cloudflare/workers-oauth-provider` | 1.2.4. `OAuthProvider` (combined AS + resource) still supported. Helpers on `env.OAUTH_PROVIDER`: `parseAuthRequest`, `describeConsent`, `beginConsent`, `approveConsent`, `denyConsent`, `completeAuthorization`, `listUserGrants`, `revokeGrant`, `lookupClient`. `clientIdMetadataDocumentEnabled` supported (needs `global_fetch_strictly_public`). Handler receives `ctx.props` and `ctx.auth.scope`. | Used as designed. Consent page is ours, CSRF and framing protection come from `beginConsent`. |
| `createMcpHandler` / MCP SDK | `agents` 0.33 pulls a large peer set. `@modelcontextprotocol/sdk` 1.32.2 ships `WebStandardStreamableHTTPServerTransport` (stateless when `sessionIdGenerator` is undefined) and a Workers-safe `CfWorkerJsonSchemaValidator`. | We use the SDK's low-level `Server` + web-standard transport directly, one server per request. Same stateless shape as `createMcpHandler`, no Durable Objects, smaller bundle, and per-request tool lists are trivial. |
| Vitest Workers pool | `@cloudflare/vitest-pool-workers` is deprecated and renamed `@cloudflare/vitest-plugin` (1.8.x, `cloudflareTest()` Vite plugin, vitest 4/5). | Used the new package. |
| TypeScript | 7.0 is current. | Pinned 5.9.3 for tooling compatibility (vitest plugin, tsx). Revisit later. |
| D1 FTS5 `porter unicode61`, partial and expression indexes | Work in workerd/miniflare; exercised by the test suite (seeded skills searchable, sibling-name unique index enforced). | DDL unchanged. |
| D1 `LIKE` | D1 limits LIKE patterns to 50 bytes; `path LIKE '/id/id/%'` fails past one level. | Subtree queries use an index range: `path >= p AND path < p'` where `p'` is `p` with its trailing `/` replaced by `0`. |
| Wrangler auto-provisioning | Wrangler 4.164 shows D1/KV/R2 bindings without ids in `deploy --dry-run`. Not verified against a live account from here. | `scripts/setup.mjs` deploys once to provision, and falls back to explicit `d1 create`, `r2 bucket create`, `kv namespace create`. |
| Milkdown Crepe, licenses | Deferred to the real SPA milestone (the UI is prototyped first, at the user's request). | See "UI" below. |
| Client registration per chat client | Not verifiable from here. | `docs/CLIENTS.md` marks each client untested. Both DCR (`/register`) and CIMD are enabled. |

## Interpretations

1. **Directory reads are `read` scope.** `list_users`, `list_teams`, `list_team_members`, `list_team_access` are listed under ADMIN in SPEC 10.2, but a folder manager who is not an owner must pick people and teams in the Share dialog, and an MCP agent following `hub-access` must resolve a user. They require any active user and the `read` scope. Non-owners see only id, name and email of active users; owners also see role, status, teams and last login. `list_team_access` only lists folders the caller can read. All writes stay owner-only (`admin` scope), with team membership also open to that team's maintainers.
2. **Two extra read operations: `list_api_tokens`, `list_mcp_connections`.** The Settings pages need them and SPEC 10.3 forbids UI-only reads. Listing your own token metadata and connections is harmless, so they are ordinary `read` ops on every surface. Minting and revoking stay UI-only.
3. **Sign in, then consent.** SPEC 11.1 orders consent before the Entra redirect. Consent must show the user, which we only know after sign-in, so `/authorize` first ensures a browser session (redirecting through `/auth/login` if needed) and then shows our consent page. The confused-deputy protections are unchanged: per-client consent, browser-bound handle, no framing, `state` single use.
4. **Unpublished documents do not exist for viewers.** `Authz.role()` returns 0 for a document with no published version when the caller is below editor. Lists, search, `get_node` and path resolution therefore never mention it.
5. **"Shared with me" and paths.** List responses only contain readable nodes. Display paths start at the caller's highest readable ancestor (their "shared with me" root), so no unreadable folder name ever appears. Path NodeRefs resolve from those roots. A boundary child folder you have no grant on is hidden from its parent listing; folders granted deeper show up at the top level instead (Drive behaviour).
6. **Unreadable means not_found, before scope.** `authorize()` checks existence first, so a token lacking a scope cannot use `scope_required` versus `not_found` to probe whether a node exists.
7. **Breaking inheritance keeps the manager in.** `set_inherit(false)` by a non-owner adds a direct manager grant for that user if they would otherwise lose access.
8. **Top level is owner-only** for create and move into, since there is no folder to hold a grant.
9. **`_hub` is seeded by migration** (`0002_seed_hub.sql`, generated by `scripts/gen-seed.mjs` from `src/seed/*.md`) with `inherit = 0` and an `everyone: viewer` grant, so only owners can edit it.
10. **The `everyone` team** is a row in `teams` (id `everyone`) so it can be granted and listed; membership is implicit for every active user and cannot be edited.
11. **OpenAPI** is generated with zod 4's `z.toJSONSchema` from the registry instead of `@hono/zod-openapi`, which keeps one source of truth without wrapping every route.
12. **Login attempts** (state hash, nonce, PKCE verifier) live in a D1 table `login_attempts` with a browser-binding cookie, swept by cron. KV stays OAuth-provider state plus the 60 s catalog cache.
13. **Audit writes are awaited**, one row per registry call, success or failure (`ok = 0` with the error code). UI-only ops, login, MCP consent and cron also write rows. Keys that can carry bodies (`content`, `markdown`, `patch`, `data_base64`, `zip_base64`, `token`) are stripped before insert.
14. **`export_tree`** returns the zip as base64 JSON so the same op works on REST, MCP and UI. Capped at 50 MB.
15. **Rate limiting** keys on client IP and path prefix, and is skipped when there is no `cf-connecting-ip` (local tests).
16. **Assets** are served with `Content-Security-Policy: sandbox` in addition to SPEC 9 headers.
17. **Etags** are random per write, not content hashes, so two identical saves still detect interleaving.
18. **Audit archiving.** D1 keeps 7 days of audit rows. The cron runs twice a day (03:17 and 15:17 UTC) and moves older rows to R2 as gzipped NDJSON, oldest first, 5,000 rows per file and at most 100,000 rows per run, under `audit/YYYY/MM/DD/<first-id>_<last-id>.ndjson.gz`. Each file is written before its rows are deleted, and a retry overwrites the same key, so a failed run neither loses nor duplicates rows. This replaces the SPEC's 365-day delete. `list_audit` and the Audit page show the last 7 days; older history is read from R2. Retention of the archive is an R2 lifecycle rule on the `audit/` prefix, set per instance.

## UI

At the user's request the UI is first delivered as a clickable prototype (`prototype/index.html`, published as an artifact) for review before the React SPA is coded. Until then `web/public` holds a minimal shell (sign-in button, MCP URL) so the Worker serves something real. The generated client (`web/src/api/client.ts`) is already in place and parity-checked. Still to do with the SPA: Milkdown Crepe + CodeMirror editor (license check of every package), hostile-markdown sanitizer test, Playwright smoke.
