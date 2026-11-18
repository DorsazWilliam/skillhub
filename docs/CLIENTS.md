# Connecting chat clients

Connector URL: `https://<your-host>/mcp` (Streamable HTTP, OAuth 2.1). The server supports dynamic client registration (`/register`) and Client ID Metadata Documents, so no client id or secret has to be pasted anywhere.

On first use the client opens a browser window: sign in with Microsoft, then choose scopes on the consent page. `read` and `write` are preselected. Tick `publish` or `manage` only for agents you trust to change what everyone reads.

Status legend: **tested** = connected and called tools against a deployed instance. **untested** = steps follow the vendor's current docs but have not been run against SkillHub yet. Update this file when you test.

## Claude (claude.ai, Claude Desktop, Claude Code)

Status: **untested** (protocol path covered by the automated MCP SDK client test in `test/mcp.test.ts`).

- claude.ai / Desktop: **Settings > Connectors > Add custom connector**. Name it, paste the connector URL, **Add**, then **Connect** and complete sign-in.
- Claude Code:

```powershell
claude mcp add --transport http skillhub https://<your-host>/mcp
```

Then run `/mcp` in Claude Code and authenticate.

## ChatGPT

Status: **untested**.

ChatGPT supports DCR and CIMD. In **Settings > Apps & Connectors > Advanced**, enable developer mode if your workspace requires it, then **Create** a connector: paste the connector URL, authentication **OAuth**, save, and connect. Workspace admins may need to approve custom connectors first.

## Microsoft Copilot Studio

Status: **untested**. Whether Copilot Studio completes the OAuth flow against this server is the open question from SPEC 22.

In your agent: **Tools > Add a tool > New tool > Model Context Protocol**. Server URL = connector URL, authentication **OAuth 2.0**, type **Dynamic discovery** if offered. If Copilot Studio requires a manual client, register one with DCR first:

```powershell
curl -X POST https://<your-host>/register -H "content-type: application/json" -d '{"client_name":"Copilot Studio","redirect_uris":["<redirect URI shown by Copilot Studio>"],"token_endpoint_auth_method":"client_secret_post"}'
```

and use the returned `client_id` and `client_secret` with authorization URL `https://<your-host>/authorize`, token URL `https://<your-host>/token`, scopes `read write`.

## What agents see

- `tools/list` only contains tools for the scopes the connection holds (about 10 for read-only).
- `find_skills` carries a live catalog of up to 25 skills the user can read in its description, so the model knows what exists without a call.
- Errors are structured: `forbidden`, `not_found`, `conflict` (with the current etag), `scope_required` (names the scope), `invalid`.
