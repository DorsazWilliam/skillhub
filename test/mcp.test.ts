import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { providerOptions } from '../src/worker';
import { OPS } from '../src/registry';
import { BASE, fetchSelf, makeUser, sessionClient } from './helpers';
import { sha256B64Url } from '../src/lib/crypto';
import type { UserRow } from '../src/db/d1';
import type { Env } from '../src/env';

const REDIRECT = 'https://client.test/callback';

/** Issues a real access token through the provider: register client, complete authorization, exchange code. */
async function issueToken(user: UserRow, scopes: string[]): Promise<{ token: string; grantId: string }> {
  const oauth = getOAuthApi(providerOptions(env as unknown as Env), env);
  const client = await oauth.createClient({ redirectUris: [REDIRECT], clientName: 'Test Client', tokenEndpointAuthMethod: 'none' });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { redirectTo } = await oauth.completeAuthorization({
    request: {
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: REDIRECT,
      scope: scopes,
      state: 's',
      codeChallenge: await sha256B64Url(verifier),
      codeChallengeMethod: 'S256',
      resource: `${BASE}/mcp`,
    },
    userId: user.id,
    metadata: {},
    scope: scopes,
    props: { userId: user.id, clientName: 'Test Client' },
  });
  const code = new URL(redirectTo).searchParams.get('code')!;
  const res = await fetchSelf('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
  });
  const json = (await res.json()) as { access_token: string };
  expect(res.status).toBe(200);
  const grants = await oauth.listUserGrants(user.id);
  return { token: json.access_token, grantId: grants.items.find((g) => g.clientId === client.clientId)!.id };
}

async function connect(token: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => fetchSelf(new URL(String(input instanceof Request ? input.url : input)).pathname, init),
  });
  const client = new McpClient({ name: 'vitest', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function rawMcp(token: string, method: string, params: unknown = {}): Promise<Response> {
  return fetchSelf('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('MCP', () => {
  it('a read-only token lists only read tools', async () => {
    const u = await makeUser();
    const { token } = await issueToken(u, ['read']);
    const client = await connect(token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = OPS.filter((o) => o.mcp && o.scope === 'read').map((o) => o.mcp!.tool).sort();
    expect(names).toEqual(expected);
    expect(names).not.toContain('publish_version');
    const find = tools.find((t) => t.name === 'find_skills')!;
    expect(find.description).toContain('hub-promote');
    expect(new TextEncoder().encode(find.description).length).toBeLessThanOrEqual(4096 + 200);
    await client.close();
  });

  it('end to end: find_skills then get_skill', async () => {
    const u = await makeUser();
    const { token } = await issueToken(u, ['read', 'write']);
    const client = await connect(token);
    const found = (await client.callTool({ name: 'find_skills', arguments: { task: 'share a folder with a team' } })) as unknown as { structuredContent: { skills: { id: string; name: string }[] } };
    expect(found.structuredContent.skills[0]!.name).toBe('hub-access');
    const got = (await client.callTool({ name: 'get_skill', arguments: { doc: '/_hub/hub-access' } })) as unknown as { structuredContent: { version: number; markdown: string } };
    expect(got.structuredContent.version).toBe(1);
    expect(got.structuredContent.markdown).toContain('effective_access');
    await client.close();
  });

  it('insufficient scope returns scope_required', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const folder = (await owner.call('POST', '/folders', { name: `mcp-${crypto.randomUUID().slice(0, 6)}` })).json.id;
    const u = await makeUser();
    await owner.call('POST', `/folders/${folder}/grants`, { principal_type: 'user', principal: u.id, role: 'manager' });
    const doc = (await owner.call('POST', '/docs', { parent: folder, name: 'd', content: 'x' })).json.node.id;
    await owner.call('POST', `/docs/${doc}/versions`, {});
    const { token } = await issueToken(u, ['read', 'write']);
    const res = await rawMcp(token, 'tools/call', { name: 'publish_version', arguments: { doc, version: 1 } });
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text).error).toMatchObject({ code: 'scope_required', details: { scope: 'publish' } });
  });

  it('a revoked connection fails on the next request', async () => {
    const u = await makeUser();
    const { token, grantId } = await issueToken(u, ['read']);
    expect((await rawMcp(token, 'tools/list')).status).toBe(200);
    const session = await sessionClient(u);
    const list = await session.call('GET', '/connections');
    expect(list.json.items.map((i: { id: string }) => i.id)).toContain(grantId);
    const del = await session.raw(`/api/v1/ui/connections/${grantId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await rawMcp(token, 'tools/list')).status).toBe(401);
  });

  it("a suspended user's token fails on the next request", async () => {
    const u = await makeUser();
    const { token } = await issueToken(u, ['read']);
    expect((await rawMcp(token, 'tools/list')).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    expect((await rawMcp(token, 'tools/list')).status).toBe(403);
  });

  it('a PAT cannot reach UI-only operations', async () => {
    const { tokenClient } = await import('./helpers');
    const u = await makeUser();
    const t = await tokenClient(u, ['read', 'write', 'publish', 'manage', 'admin']);
    const r = await t.raw('/api/v1/ui/tokens', { method: 'POST', body: JSON.stringify({ name: 'x', scopes: ['read'] }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(403);
  });
});
