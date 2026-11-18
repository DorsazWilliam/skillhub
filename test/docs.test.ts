import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { makeUser, sessionClient, tokenClient, type Client } from './helpers';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

const skill = (body: string, name = 'sql-review'): string => `---\nname: ${name}\ndescription: Use when reviewing SQL changes.\nlicense: internal\n---\n${body}\n`;

async function setup(): Promise<{ owner: Client; editor: Client; viewer: Client; folder: string; doc: string }> {
  const owner = await sessionClient(await makeUser({ role: 'owner' }));
  const folder = (await owner.call('POST', '/folders', { name: `Eng-${crypto.randomUUID().slice(0, 8)}` })).json.id;
  const editorUser = await makeUser();
  const viewerUser = await makeUser();
  await owner.call('POST', `/folders/${folder}/grants`, { principal_type: 'user', principal: editorUser.email, role: 'editor' });
  await owner.call('POST', `/folders/${folder}/grants`, { principal_type: 'user', principal: viewerUser.email, role: 'viewer' });
  const editor = await sessionClient(editorUser);
  const viewer = await sessionClient(viewerUser);
  const doc = (await editor.call('POST', '/docs', { parent: folder, name: 'sql-review' })).json.node.id;
  return { owner, editor, viewer, folder, doc };
}

describe('document lifecycle', () => {
  it('draft -> commit -> publish with optimistic concurrency', async () => {
    const { owner, editor, doc } = await setup();
    const d1 = await editor.call('PUT', `/docs/${doc}/draft`, { content: skill('v1 body') });
    expect(d1.status).toBe(200);
    const stale = await editor.call('PUT', `/docs/${doc}/draft`, { content: 'other', etag: 'nope' });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('conflict');
    expect(stale.json.error.details.etag).toBe(d1.json.etag);
    expect(stale.json.error.details.content).toContain('v1 body');
    const noEtag = await editor.call('PUT', `/docs/${doc}/draft`, { content: 'x' });
    expect(noEtag.status).toBe(409);
    const d2 = await editor.call('PUT', `/docs/${doc}/draft`, { content: skill('v1 body!'), etag: d1.json.etag });
    expect(d2.status).toBe(200);
    const c1 = await editor.call('POST', `/docs/${doc}/versions`, { message: 'first' });
    expect(c1.json).toMatchObject({ version: 1, is_skill: true });
    expect((await editor.call('GET', `/docs/${doc}/draft`)).json.draft).toBeNull();
    // Editors cannot publish.
    expect((await editor.call('POST', `/docs/${doc}/publish`, { version: 1 })).status).toBe(403);
    expect((await owner.call('POST', `/docs/${doc}/publish`, { version: 1 })).json.published_version).toBe(1);
  });

  it('rejects invalid frontmatter on commit', async () => {
    const { editor, doc } = await setup();
    await editor.call('PUT', `/docs/${doc}/draft`, { content: '---\nname: Not Valid\ndescription: x\n---\nbody' });
    const r = await editor.call('POST', `/docs/${doc}/versions`, {});
    expect(r.status).toBe(400);
    expect(r.json.error.details.field).toBe('name');
  });

  it('viewers only ever receive the published version (REST, token, asset proxy)', async () => {
    const { owner, editor, viewer, doc } = await setup();
    await editor.call('PUT', `/docs/${doc}/draft`, { content: skill('published body') });
    await editor.call('POST', `/docs/${doc}/versions`, { message: 'v1' });
    await owner.call('POST', `/docs/${doc}/publish`, { version: 1 });

    const up = await editor.call('POST', `/docs/${doc}/assets`, { data_base64: b64(PNG) });
    expect(up.status).toBe(200);
    const assetId = up.json.id;
    const draft = await editor.call('GET', `/docs/${doc}/draft`);
    await editor.call('PUT', `/docs/${doc}/draft`, { content: skill(`secret draft ${up.json.markdown}`), etag: draft.json.draft?.etag ?? null });
    await editor.call('POST', `/docs/${doc}/versions`, { message: 'v2' });
    await editor.call('PUT', `/docs/${doc}/draft`, { content: skill('even newer draft') });

    const read = await viewer.call('GET', `/docs/${doc}`);
    expect(read.json.version).toBe(1);
    expect(read.json.markdown).toContain('published body');
    expect((await viewer.call('GET', `/docs/${doc}?version=2`)).status).toBe(404);
    expect((await viewer.call('GET', `/docs/${doc}?version=draft`)).status).toBe(403);
    expect((await viewer.call('GET', `/docs/${doc}/draft`)).status).toBe(403);
    expect((await viewer.call('GET', `/docs/${doc}/versions`)).status).toBe(403);
    expect((await viewer.call('GET', `/docs/${doc}/versions/2`)).status).toBe(403);
    const dd = await viewer.call('GET', `/docs/${doc}/diff`); expect(dd.status, JSON.stringify(dd.json)).toBe(403);
    // Asset only referenced by an unpublished version.
    expect((await viewer.raw(`/a/${assetId}`)).status).toBe(404);
    expect((await viewer.call('GET', `/assets/${assetId}`)).status).toBe(404);
    expect((await editor.raw(`/a/${assetId}`)).status).toBe(200);
    // Publish v2: now the viewer can see it, and the image.
    await owner.call('POST', `/docs/${doc}/publish`, { version: 2 });
    const res = await viewer.raw(`/a/${assetId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await viewer.call('GET', `/docs/${doc}`)).json.version).toBe(2);
    // Read-only token behaves like a viewer for content.
    const viewerToken = await tokenClient(viewer.user, ['read']);
    expect((await viewerToken.call('GET', `/docs/${doc}?version=draft`)).status).toBe(403);
  });

  it('rolls back by publishing an older version and audits it', async () => {
    const { owner, editor, doc } = await setup();
    for (const v of ['one', 'two']) {
      const cur = await editor.call('GET', `/docs/${doc}/draft`);
      await editor.call('PUT', `/docs/${doc}/draft`, { content: skill(v), etag: cur.json.draft?.etag ?? null });
      await editor.call('POST', `/docs/${doc}/versions`, { message: v });
    }
    await owner.call('POST', `/docs/${doc}/publish`, { version: 2 });
    const back = await owner.call('POST', `/docs/${doc}/publish`, { version: 1 });
    expect(back.json).toMatchObject({ published_version: 1, previous_version: 2 });
    const rows = await env.DB.prepare("SELECT version, ok FROM audit_log WHERE op = 'publish_version' AND node_id = ? ORDER BY ts").bind(doc).all<{ version: number; ok: number }>();
    expect(rows.results.map((r) => r.version)).toEqual([2, 1]);
    const diff = await editor.call('GET', `/docs/${doc}/diff?from=1&to=2`);
    expect(diff.json.patch).toContain('-one');
    expect(diff.json.patch).toContain('+two');
  });

  it('keeps FTS in step with publish and unpublish', async () => {
    const { owner, editor, viewer, doc } = await setup();
    await editor.call('PUT', `/docs/${doc}/draft`, { content: skill('Check indexes and query plans', 'zebra-quokka') });
    await editor.call('POST', `/docs/${doc}/versions`, {});
    expect((await viewer.call('GET', '/skills?task=zebra%20quokka')).json.skills).toHaveLength(0);
    await owner.call('POST', `/docs/${doc}/publish`, { version: 1 });
    expect((await viewer.call('GET', '/skills?task=zebra%20quokka')).json.skills[0].name).toBe('zebra-quokka');
    await owner.call('POST', `/docs/${doc}/unpublish`, {});
    expect((await viewer.call('GET', '/skills?task=zebra%20quokka')).json.skills).toHaveLength(0);
  });

  it('rejects SVG and non-image uploads, sniffing bytes not headers', async () => {
    const { editor, doc } = await setup();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await editor.call('POST', `/docs/${doc}/assets`, { data_base64: b64(svg) })).status).toBe(400);
    const form = new FormData();
    form.set('file', new File([svg], 'x.png', { type: 'image/png' }));
    expect((await editor.raw(`/api/v1/docs/${doc}/assets`, { method: 'POST', body: form })).status).toBe(400);
    const ok = new FormData();
    ok.set('file', new File([PNG], 'x.png', { type: 'application/octet-stream' }));
    const r = await editor.raw(`/api/v1/docs/${doc}/assets`, { method: 'POST', body: ok });
    expect(r.status).toBe(200);
  });

  it('trash: delete hides the subtree, restore brings it back', async () => {
    const { owner, folder, doc, viewer } = await setup();
    await owner.call('PUT', `/docs/${doc}/draft`, { content: skill('x') });
    await owner.call('POST', `/docs/${doc}/versions`, {});
    await owner.call('POST', `/docs/${doc}/publish`, { version: 1 });
    expect((await owner.call('DELETE', `/nodes/${folder}`)).json.deleted).toBe(2);
    expect((await viewer.call('GET', `/docs/${doc}`)).status).toBe(404);
    const trash = await owner.call('GET', '/trash');
    expect(trash.json.items.map((i: { id: string }) => i.id)).toContain(folder);
    expect((await owner.call('POST', `/trash/${folder}/restore`, {})).status).toBe(200);
    expect((await viewer.call('GET', `/docs/${doc}`)).status).toBe(200);
  });
});

describe('audit', () => {
  it('every registry call writes exactly one row, and never a document body', async () => {
    const { editor, doc } = await setup();
    const count = async (): Promise<number> => (await env.DB.prepare('SELECT COUNT(*) AS c FROM audit_log').first<{ c: number }>())!.c;
    const calls: [string, string, unknown?][] = [
      ['PUT', `/docs/${doc}/draft`, { content: skill('TOP-SECRET-BODY') }],
      ['GET', `/docs/${doc}/draft`],
      ['POST', `/docs/${doc}/versions`, { message: 'm' }],
      ['GET', `/docs/${doc}?version=1`],
      ['GET', `/docs/${doc}/versions`],
      ['POST', `/docs/${doc}/publish`, { version: 1 }],
      ['GET', '/nodes/01ZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ];
    for (const [m, p, b] of calls) {
      const before = await count();
      await editor.call(m, p, b);
      expect(await count(), `${m} ${p}`).toBe(before + 1);
    }
    const rows = await env.DB.prepare('SELECT detail FROM audit_log WHERE node_id = ?').bind(doc).all<{ detail: string | null }>();
    expect(JSON.stringify(rows.results)).not.toContain('TOP-SECRET-BODY');
    const failed = await env.DB.prepare("SELECT ok, detail FROM audit_log WHERE op = 'publish_version' AND node_id = ?").bind(doc).first<{ ok: number; detail: string }>();
    expect(failed!.ok).toBe(0);
    expect(failed!.detail).toContain('forbidden');
  });
});
