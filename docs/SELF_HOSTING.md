# Self-hosting

SkillHub runs on Cloudflare (see DEPLOY.md), as one Docker image anywhere (a VM, Docker Compose, Kubernetes, a managed container platform), on Azure with one command, or as a single executable without Docker. All of them run the same application code; only the platform pieces change.

| Need | Cloudflare | Docker image |
| --- | --- | --- |
| Database | D1 | SQLite file on a volume, or Postgres 14+ |
| Files (images, renders, audit archive) | R2 | A directory on a volume, any S3-compatible bucket, or Azure Blob Storage |
| OAuth and cache state | KV | A table in the same database |
| Scheduled cleanup | Cron trigger | Built in (03:17 and 15:17 UTC), one replica at a time on Postgres |
| Prototype screenshots | Browser Run | Optional headless Chromium (`BROWSER_URL`) |

## Pick a setup

- **SQLite + volume**: one container, nothing else. One replica. Back it up by snapshotting the volume, or stream it to S3 with Litestream (the Helm chart has a switch).
- **Postgres + S3**: your database server and your bucket. Several replicas, rolling updates, your usual database backups.
- **Bundled**: Compose or the Helm chart also run Postgres and an S3 store (SeaweedFS) for you.

SQLite needs block storage (a normal disk or a ReadWriteOnce volume). Never put it on NFS, SMB or Azure Files: file locking there is unreliable.

## Releases

Every version tag publishes everything, so nobody needs to clone or build:

- the image `ghcr.io/dorsazwilliam/skillhub:<version>` (also `latest` and `<major>.<minor>`), for linux/amd64 and linux/arm64;
- the Helm chart `oci://ghcr.io/dorsazwilliam/charts/skillhub`;
- on the [GitHub release](https://github.com/DorsazWilliam/skillhub/releases): the executables (Linux x64 and arm64, Windows x64), the Compose files and the Azure template with the image pinned to that version, the systemd unit and `SHA256SUMS`.

Replace `0.1.0` below with the version you want. To publish one, set `version` in `package.json`, then push a matching tag (`git tag v0.1.0`, `git push origin v0.1.0`): `.github/workflows/release.yml` tests, builds and publishes. A tag with a suffix (`v0.2.0-rc.1`) is a pre-release and does not move `latest`.

## Docker

```powershell
docker run -d -p 8080:8080 -v skillhub-data:/data --env-file .env ghcr.io/dorsazwilliam/skillhub:0.1.0
```

From source instead: `docker build -t skillhub .`.

## Docker Compose

From the release, download `compose-standalone.yml` (or `compose-bundled.yml`, `compose-external.yml`) and `compose.env.example`, save the latter as `.env` next to it and fill it in, then:

```powershell
docker compose -f compose-standalone.yml up -d
```

`standalone` is SQLite on a volume, `bundled` adds Postgres 17 and SeaweedFS, `external` uses the `DATABASE_URL` and `S3_*` you set. The files in `deploy/compose` are the same with `latest`; set `SKILLHUB_IMAGE` to run another image, such as one you built.

## Kubernetes (Helm)

```powershell
helm install skillhub oci://ghcr.io/dorsazwilliam/charts/skillhub --version 0.1.0 --set baseUrl=https://skills.acme.com --set secrets.sessionSecret=$(openssl rand -hex 32) --set entra.tenantId=... --set entra.clientId=... --set secrets.entraClientSecret=... --set ownerEmails=you@acme.com --set ingress.enabled=true
```

That is SQLite on a 5 Gi volume. For your own Postgres and bucket add:

```powershell
--set database.type=postgres --set database.url=postgres://... --set storage.type=s3 --set storage.s3.endpoint=https://... --set storage.s3.accessKeyId=... --set storage.s3.secretAccessKey=... --set replicaCount=2
```

Or let the chart run them: `--set database.type=postgres --set bundled.postgres.enabled=true --set bundled.postgres.password=... --set storage.type=s3 --set bundled.s3.enabled=true --set bundled.s3.secretKey=...`. Secrets can come from an existing Secret instead (`existingSecret`, same key names as the environment variables). `helm show values oci://ghcr.io/dorsazwilliam/charts/skillhub --version 0.1.0` lists Litestream, the Chromium sidecar, ingress and resources. From a clone, `deploy/helm/skillhub` is the same chart.

## Azure

Download `deploy.ps1` and `main.bicep` from the release into one folder, then:

```powershell
./deploy.ps1 -ResourceGroup skillhub -Location westeurope -OwnerEmails you@acme.com
```

Needs the Azure CLI, signed in with rights to create app registrations. The script creates the Entra app registration and its secret, deploys `main.bicep` (Container Apps, PostgreSQL Flexible Server Burstable B1ms, a Storage account reached through a managed identity with shared keys turned off, Log Analytics), registers the redirect URI and prints the sign-in and MCP URLs. With an existing app registration, deploy `main.bicep` (or `azuredeploy.json`) yourself with `entraTenantId`, `entraClientId`, `entraClientSecret` and `ownerEmails`. Roughly 25 USD a month at list prices, mostly the database.

## Single executable

One file, no Docker, no Node: the web app and the migrations are inside. Download it from the release. SQLite and uploads go to `./data` under the working directory unless you set `DATABASE_URL` and `STORAGE` like the image.

Run it with the same environment variables as the image (at least `BASE_URL`, `SESSION_SECRET` and the sign-in settings). On Linux, `skillhub.service` is a hardened systemd unit. On Windows, run it as a service with a service wrapper such as WinSW or NSSM, or as a scheduled task at startup, and set `NODE_NO_WARNINGS=1` to hide Node's notice about SQLite.

To build one yourself: `npm run build:exe` (for the current system), or `docker build -f Dockerfile.exe --output dist .` for Linux from any machine.

## Environment variables

Sign-in methods, invitations and email sending are in [SIGN_IN.md](SIGN_IN.md). Everything in `wrangler.jsonc` `vars` works the same (`BASE_URL`, `ENTRA_*`, `OWNER_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOW_GUESTS`, `MCP_MAX_SCOPES`, `CATALOG_IN_TOOL_DESC`), plus:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | required | 32+ random bytes |
| `ENTRA_CLIENT_SECRET` | | Entra app secret |
| `DATABASE_URL` | `sqlite:/data/skillhub.db` | `sqlite:<file>` or `postgres://user:pass@host:5432/db` |
| `DATABASE_POOL` | `10` | Postgres connections per replica |
| `STORAGE` | `disk` | `disk`, `s3` or `azure` |
| `STORAGE_DIR` | `/data/files` | With `disk` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | With `s3`. Works with AWS S3, R2, MinIO, Ceph, SeaweedFS, Garage |
| `S3_FORCE_PATH_STYLE` | `true` | `false` for AWS S3 (virtual-hosted URLs) |
| `S3_CREATE_BUCKET` | `false` | Create the bucket at start if missing |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER` | `skillhub` container | With `STORAGE=azure` |
| `AZURE_STORAGE_KEY` | | Account key; without it the managed identity is used (`AZURE_CLIENT_ID` for a user-assigned one) |
| `AZURE_STORAGE_ENDPOINT`, `AZURE_CREATE_CONTAINER` | | A different endpoint (Azurite), create the container at start |
| `BROWSER_URL` / `BROWSER_WS_URL` | | A Chromium DevTools endpoint for `render_prototype` |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `RATE_LIMIT` | `300` | Requests per minute per client IP and path group, per replica |

Put TLS in front (ingress, reverse proxy). Requests are served as `BASE_URL`, whatever host the proxy forwards. `/healthz` checks the app, `/livez` only the process.

## Differences from Cloudflare

- Client ID metadata documents (CIMD) are off: they need an outbound fetch that refuses private network addresses, which Cloudflare provides. MCP clients use dynamic client registration instead, which Claude, ChatGPT and Copilot support.
- The rate limiter counts per replica.
- Migrations run at start (one replica at a time on Postgres). `SKIP_MIGRATIONS=true` turns that off.

## Tests

The whole suite runs on each target: `npm test` (Cloudflare), `npm run test:node` (Node + SQLite), `npm run test:pg` (Node + Postgres, in WebAssembly through PGlite). `node scripts/selfhost-smoke.mjs <url>` checks a running instance started with `DEV_LOGIN=true` on localhost.
