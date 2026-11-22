import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { AREA, BASE, makeUser, sessionClient, type Client } from './helpers';
import { signPreview, verifyPreview } from '../src/lib/preview';
import { toolResult } from '../src/mcp/server';

const uid = (): string => Math.random().toString(36).slice(2, 8);

async function newProto(owner: Client, name = 'proto-' + uid()): Promise<{ folder: string; files: Record<string, string> }> {
  const r = await owner.call('POST', '/prototypes', { parent: AREA.prototypes, name });
  expect(r.status).toBe(200);
  return { folder: r.json.folder.id, files: Object.fromEntries(r.json.files.map((f: { name: string; id: string }) => [f.name, f.id])) };
}

/** Fetches a preview URL (absolute, on BASE) through the worker with a client's cookies or none. */
async function open(c: Client | null, url: string): Promise<Response> {
  const path = url.slice(BASE.length);
  if (c) return c.raw(path, { redirect: 'manual' });
  const { exports } = await import('cloudflare:workers');
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(url, { redirect: 'manual' }));
}

async function commitAll(owner: Client, files: Record<string, string>): Promise<void> {
  for (const id of Object.values(files)) expect((await owner.call('POST', `/docs/${id}/versions`, { message: 'v1' })).status).toBe(200);
}

describe('prototypes', () => {
  it('create_prototype makes a folder with index.html, styles.css and app.js drafts', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const p = await newProto(owner);
    expect(Object.keys(p.files).sort()).toEqual(['app.js', 'index.html', 'styles.css']);
    const node = await owner.call('GET', `/nodes/${p.folder}`);
    expect(node.json.is_prototype).toBe(true);
    expect(node.json.area).toBe('prototypes');
    expect(node.json.canonical_path).toMatch(/^prototypes\/proto-/);
    const css = await owner.call('GET', `/nodes/${p.files['styles.css']}`);
    expect(css.json.format).toBe('css');
  });

  it('placement: files live inside a folder under prototypes/; web files stay out of documentation/', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    expect((await owner.call('POST', '/docs', { parent: AREA.prototypes, name: 'index.html' })).status).toBe(400);
    const f = (await owner.call('POST', '/folders', { parent: AREA.prototypes, name: 'f-' + uid() })).json.id;
    expect((await owner.call('POST', '/docs', { parent: f, name: 'SKILL.md' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: f, name: 'notes' })).status).toBe(200);
    expect((await owner.call('POST', '/prototypes', { parent: AREA.documentation, name: 'x' + uid() })).status).toBe(400);
    const d = (await owner.call('POST', '/folders', { parent: AREA.documentation, name: 'd-' + uid() })).json.id;
    expect((await owner.call('POST', '/docs', { parent: d, name: 'page.html' })).status).toBe(400);
    const p = await newProto(owner);
    expect((await owner.call('POST', '/prototypes', { parent: p.folder, name: 'nested' })).status).toBe(400);
  });

  it('serves the working copy to editors through a signed link, sandboxed', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const p = await newProto(owner);
    const g = await owner.call('GET', `/prototypes/${p.folder}`);
    expect(g.status).toBe(200);
    expect(g.json.mode).toBe('working');
    expect(g.json.files[0].path).toBe('index.html');
    const page = await open(null, g.json.preview_url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(page.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await page.text()).toContain('<link rel="stylesheet" href="styles.css">');
    const css = await open(null, g.json.preview_url + 'styles.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await open(null, g.json.preview_url + 'missing.js')).status).toBe(404);
    // Without the trailing slash, the link redirects so relative URLs resolve inside the prototype.
    const bare = await open(null, g.json.preview_url.replace(/\/$/, ''));
    expect(bare.status).toBe(301);
  });

  it('viewers get the published version only, after publish_prototype', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const viewer = await sessionClient(await makeUser());
    const p = await newProto(owner);
    expect((await viewer.call('GET', `/prototypes/${p.folder}?version=working`)).status).toBe(403);
    const before = await viewer.call('GET', `/prototypes/${p.folder}`);
    expect(before.json.mode).toBe('published');
    expect(before.json.published).toBe(false);
    expect((await open(null, before.json.preview_url)).status).toBe(404);

    await commitAll(owner, p.files);
    const pub = await owner.call('POST', `/prototypes/${p.folder}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.json.published).toBe(3);

    const after = await viewer.call('GET', `/prototypes/${p.folder}`);
    expect(after.json.published).toBe(true);
    const page = await open(null, after.json.preview_url);
    expect(page.status).toBe(200);
    // A later draft is not visible on the published link.
    const d = await owner.call('GET', `/docs/${p.files['index.html']}/draft`);
    await owner.call('PUT', `/docs/${p.files['index.html']}/draft`, { content: '<p>secret draft</p>', etag: d.json.draft?.etag ?? null });
    expect(await (await open(null, after.json.preview_url)).text()).not.toContain('secret draft');
    const work = await owner.call('GET', `/prototypes/${p.folder}`);
    expect(await (await open(null, work.json.preview_url)).text()).toContain('secret draft');
  });

  it('get_prototype accepts a file inside the prototype or its canonical path', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const name = 'canon-' + uid();
    const p = await newProto(owner, name);
    expect((await owner.call('GET', `/prototypes/${p.files['app.js']}`)).json.id).toBe(p.folder);
    expect((await owner.call('GET', `/prototypes/${encodeURIComponent('prototypes/' + name)}`)).json.id).toBe(p.folder);
    const f = (await owner.call('POST', '/folders', { parent: AREA.prototypes, name: 'plain-' + uid() })).json.id;
    expect((await owner.call('GET', `/prototypes/${f}`)).status).toBe(400);
  });

  it('links stop working when tampered with, expired, or the user is suspended', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const editorUser = await makeUser({ role: 'owner' });
    const editor = await sessionClient(editorUser);
    const p = await newProto(owner);
    const url: string = (await editor.call('GET', `/prototypes/${p.folder}`)).json.preview_url;
    const token = url.split('/p/')[1]!.split('/')[0]!;
    const claims = (await verifyPreview(env.SESSION_SECRET, token))!;
    expect(claims.id).toBe(p.folder);
    const tampered = await signPreview('another-secret', { ...claims });
    expect((await open(null, url.replace(token, tampered))).status).toBe(404);
    const expired = await signPreview(env.SESSION_SECRET, { ...claims, e: Math.floor(Date.now() / 1000) - 5 });
    expect((await open(null, url.replace(token, expired))).status).toBe(404);
    expect((await open(null, url)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(editorUser.id).run();
    expect((await open(null, url)).status).toBe(404);
  });

  it('documentation and skills may link to prototypes', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const name = 'linked-' + uid();
    await newProto(owner, name);
    const d = (await owner.call('POST', '/folders', { parent: AREA.documentation, name: 'd-' + uid() })).json.id;
    const doc = (await owner.call('POST', '/docs', { parent: d, name: 'page', content: `See [[prototypes/${name}]].` })).json.node.id;
    const links = await owner.call('GET', `/nodes/${doc}/links`);
    expect(links.json.outgoing[0].status).toBe('ok');
  });

  it('render_prototype explains when no browser is configured', async () => {
    if ((env as { BROWSER?: unknown }).BROWSER) return;
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const p = await newProto(owner);
    const r = await owner.call('POST', `/prototypes/${p.folder}/render`, {});
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('not configured');
  });

  it('MCP sends a render as an image block', () => {
    const out = toolResult({ image_url: 'u', mime: 'image/png', image_base64: 'AAAA', console: [] });
    expect(out.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(out.content[1]?.type).toBe('text');
    expect(JSON.stringify(out.structuredContent)).not.toContain('AAAA');
  });
});
