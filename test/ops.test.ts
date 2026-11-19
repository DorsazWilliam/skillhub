import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { unzipSync, gunzipSync, strFromU8 } from 'fflate';
import { cleanup } from '../src/db/cleanup';
import type { Env } from '../src/env';
import { makeUser, sessionClient, tokenClient, rootFolder } from './helpers';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

describe('export and cron', () => {
  it('exports the published tree with relative asset links', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const root = (await rootFolder(owner, { name: 'Export-Root' })).json.id;
    const sub = (await owner.call('POST', '/folders', { parent: root, name: 'Sub' })).json.id;
    const doc = (await owner.call('POST', '/docs', { parent: sub, name: 'with-image' })).json.node.id;
    const up = await owner.call('POST', `/docs/${doc}/assets`, { data_base64: b64(PNG) });
    await owner.call('PUT', `/docs/${doc}/draft`, { content: `# Hi\n\n${up.json.markdown}\n` });
    await owner.call('POST', `/docs/${doc}/versions`, {});
    await owner.call('POST', `/docs/${doc}/publish`, { version: 1 });
    await owner.call('POST', '/docs', { parent: sub, name: 'draft-only', content: 'never exported' });
    const r = await owner.call('POST', '/export', {});
    expect(r.status).toBe(200);
    const files = unzipSync(Uint8Array.from(atob(r.json.zip_base64), (c) => c.charCodeAt(0)));
    const md = strFromU8(files['documentation/Export-Root/Sub/with-image.md']!);
    expect(md).toContain(`](../../../_assets/${up.json.id}.png)`);
    expect(files[`_assets/${up.json.id}.png`]).toBeTruthy();
    expect(Object.keys(files).some((f) => f.includes('draft-only'))).toBe(false);
    expect(Object.keys(files)).toContain('skills/_hub/hub-promote/SKILL.md');
  });

  it('export and audit need owner and the admin scope', async () => {
    const u = await makeUser();
    expect((await (await sessionClient(u)).call('POST', '/export', {})).status).toBe(403);
    const owner = await makeUser({ role: 'owner' });
    const t = await tokenClient(owner, ['read', 'write', 'publish', 'manage']);
    const r = await t.call('GET', '/audit');
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('scope_required');
  });

  it('cron deletes orphan assets after 7 days and old audit rows', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const root = (await rootFolder(owner, { name: 'Cron-Root' })).json.id;
    const doc = (await owner.call('POST', '/docs', { parent: root, name: 'd' })).json.node.id;
    const used = await owner.call('POST', `/docs/${doc}/assets`, { data_base64: b64(PNG) });
    const orphan = await owner.call('POST', `/docs/${doc}/assets`, { data_base64: b64(PNG) });
    await owner.call('PUT', `/docs/${doc}/draft`, { content: used.json.markdown });
    await env.DB.prepare("INSERT INTO audit_log (id, ts, via, op, ok) VALUES ('OLDAUDIT', 1, 'system', 'x', 1)").run();
    const later = Date.now() + 8 * 86400 * 1000;
    const res = await cleanup(env as unknown as Env, later);
    expect(res.assets).toBeGreaterThanOrEqual(1);
    const rows = await env.DB.prepare('SELECT id, deleted_at FROM assets WHERE id IN (?, ?)').bind(used.json.id, orphan.json.id).all<{ id: string; deleted_at: number | null }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.deleted_at]));
    expect(byId.get(used.json.id)).toBeNull();
    expect(byId.get(orphan.json.id)).not.toBeNull();
    expect(await env.BUCKET.get(`assets/${orphan.json.id}`)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE id = 'OLDAUDIT'").first()).toBeNull();
  });

  it('archives audit rows older than 7 days to R2 as gzipped NDJSON, then deletes them', async () => {
    const now = Date.now();
    const old = now - 8 * 86400 * 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO audit_log (id, ts, via, op, ok, detail) VALUES ('ARCH1', ?, 'mcp', 'get_skill', 1, '{\"q\":\"x\"}')").bind(old),
      env.DB.prepare("INSERT INTO audit_log (id, ts, via, op, ok) VALUES ('ARCH2', ?, 'ui', 'publish_version', 1)").bind(old + 1),
      env.DB.prepare("INSERT INTO audit_log (id, ts, via, op, ok) VALUES ('KEEP1', ?, 'ui', 'get_skill', 1)").bind(now - 86400 * 1000),
    ]);
    const res = await cleanup(env as unknown as Env, now);
    expect(res.audit).toBeGreaterThanOrEqual(2);
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE id IN ('ARCH1','ARCH2')").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE id = 'KEEP1'").first()).not.toBeNull();
    const lines: Record<string, unknown>[] = [];
    for (const key of res.files) {
      expect(key).toMatch(/^audit\/\d{4}\/\d{2}\/\d{2}\/.+\.ndjson\.gz$/);
      const obj = await env.BUCKET.get(key);
      const text = strFromU8(gunzipSync(new Uint8Array(await obj!.arrayBuffer())));
      for (const l of text.trim().split('\n')) lines.push(JSON.parse(l));
    }
    const a1 = lines.find((l) => l.id === 'ARCH1');
    expect(a1).toMatchObject({ op: 'get_skill', via: 'mcp', detail: { q: 'x' } });
    expect(lines.some((l) => l.id === 'ARCH2')).toBe(true);
    expect(lines.some((l) => l.id === 'KEEP1')).toBe(false);
  });
});
