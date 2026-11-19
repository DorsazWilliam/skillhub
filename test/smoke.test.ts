import { describe, expect, it } from 'vitest';
import { fetchSelf, makeUser, sessionClient } from './helpers';

describe('skeleton', () => {
  it('serves /healthz', async () => {
    const res = await fetchSelf('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the OpenAPI document', async () => {
    const res = await fetchSelf('/api/v1/openapi.json');
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await fetchSelf('/api/v1/me');
    expect(res.status).toBe(401);
  });

  it('whoami works for a session', async () => {
    const c = await sessionClient(await makeUser());
    const r = await c.call('GET', '/me');
    expect(r.status).toBe(200);
    expect(r.json.user.id).toBe(c.user.id);
    expect(r.json.scopes).toContain('admin');
  });

  it('exposes OAuth metadata for MCP clients', async () => {
    const res = await fetchSelf('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint: string; scopes_supported: string[] };
    expect(meta.authorization_endpoint).toBe('https://skills.test/authorize');
    expect(meta.scopes_supported).toContain('publish');
    const mcp = await fetchSelf('/mcp', { method: 'POST', body: '{}' });
    expect(mcp.status).toBe(401);
  });

  it('lists the seeded _hub skills for everyone', async () => {
    const c = await sessionClient(await makeUser());
    const r = await c.call('GET', '/children');
    expect(r.status).toBe(200);
    expect(r.json.items.map((n: { name: string }) => n.name)).toEqual(['rules', 'skills', 'documentation']);
    const hub = await c.call('GET', `/nodes/${encodeURIComponent('/skills/_hub')}`);
    expect(hub.status).toBe(200);
    const s = await c.call('GET', '/skills?task=publish%20a%20version');
    expect(s.json.skills[0].name).toBe('hub-promote');
  });
});
