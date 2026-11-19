import { describe, expect, it } from 'vitest';
import { AREA, makeUser, rootFolder, sessionClient, type Client } from './helpers';

const uid = (): string => crypto.randomUUID().slice(0, 8).toLowerCase();
const md = (name: string, description: string, body = '1. Run the checks.\n'): string => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}`;
const codes = (ws: { code: string }[]): string[] => ws.map((w) => w.code);

async function setup(): Promise<{ owner: Client; editor: Client; viewer: Client; folder: string; doc: string; name: string; etag: string }> {
  const owner = await sessionClient(await makeUser({ role: 'owner' }));
  const org = (await rootFolder(owner, { name: 'w-' + uid() }, 'skills')).json.id;
  const editor = await sessionClient(await makeUser());
  const viewer = await sessionClient(await makeUser());
  await owner.call('POST', `/folders/${org}/grants`, { principal_type: 'user', principal: editor.user.id, role: 'publisher' });
  await owner.call('POST', `/folders/${org}/grants`, { principal_type: 'user', principal: viewer.user.id, role: 'viewer' });
  const name = 'warn-' + uid();
  const c = await editor.call('POST', '/skills', { parent: org, name, description: 'Use when warning.' });
  return { owner, editor, viewer, folder: c.json.folder.id, doc: c.json.skill_md.id, name, etag: c.json.etag };
}

describe('authoring warnings', () => {
  it('write ops return warnings; reads for readers do not', async () => {
    const { editor, viewer, folder, doc, name, etag } = await setup();
    const put = await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks releases for you.'), etag });
    expect(codes(put.json.warnings)).toEqual(['desc-trigger', 'desc-person']);
    const commit = await editor.call('POST', `/docs/${doc}/versions`, {});
    expect(codes(commit.json.warnings)).toEqual(['desc-trigger', 'desc-person']);
    const pub = await editor.call('POST', `/docs/${doc}/publish`, { version: 1 });
    expect(codes(pub.json.warnings)).toEqual(['desc-trigger', 'desc-person']);
    await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks releases for you.', '1. Run.\n2. Check.\n'), etag: null });
    await editor.call('POST', `/docs/${doc}/versions`, {});
    const ps = await editor.call('POST', `/skills/${folder}/publish`, {});
    expect(codes(ps.json.files[0].warnings)).toEqual(['desc-trigger', 'desc-person']);

    const read = await viewer.call('GET', `/docs/${folder}`);
    expect(read.status).toBe(200);
    expect(read.json).not.toHaveProperty('warnings');
    expect(JSON.stringify(read.json)).not.toContain('desc-trigger');
    expect((await viewer.call('GET', `/nodes/${doc}/warnings`)).status).toBe(403);
    expect((await viewer.call('POST', `/nodes/${doc}/warnings/dismiss`, { key: 'desc-trigger|x' })).status).toBe(403);
  });

  it('a dismissal is keyed on the flagged text: it survives unrelated edits and returns when the text changes', async () => {
    const { editor, doc, name, etag } = await setup();
    const first = await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks releases.'), etag });
    const w = first.json.warnings.find((x: { code: string }) => x.code === 'desc-trigger');
    expect(w.key).toBe('desc-trigger|Checks releases.');
    await editor.call('POST', `/docs/${doc}/versions`, {});
    const head = (await editor.call('GET', `/nodes/${doc}`)).json.head_version;

    const d = await editor.call('POST', `/nodes/${doc}/warnings/dismiss`, { key: w.key });
    expect(d.status).toBe(200);
    expect(codes(d.json.warnings)).not.toContain('desc-trigger');
    expect(codes(d.json.dismissed)).toEqual(['desc-trigger']);
    // Dismissing creates no version.
    expect((await editor.call('GET', `/nodes/${doc}`)).json.head_version).toBe(head);

    // Unrelated edit: still dismissed, in the write output too.
    const edit = await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks releases.', '1. Run the new checks.\n'), etag: null });
    expect(codes(edit.json.warnings)).not.toContain('desc-trigger');
    const c2 = await editor.call('POST', `/docs/${doc}/versions`, {});
    expect(codes(c2.json.warnings)).not.toContain('desc-trigger');

    // The flagged text changes: the warning is back.
    const changed = await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks every release.'), etag: null });
    expect(codes(changed.json.warnings)).toContain('desc-trigger');

    // restore_warnings brings back dismissed ones.
    await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Checks releases.'), etag: changed.json.etag });
    expect(codes((await editor.call('GET', `/nodes/${doc}/warnings`)).json.warnings)).not.toContain('desc-trigger');
    const r = await editor.call('POST', `/nodes/${doc}/warnings/restore`, {});
    expect(r.json.restored).toBe(1);
    expect(codes(r.json.warnings)).toContain('desc-trigger');
  });

  it('get_warnings checks a chosen version, and link warnings name what the author wrote', async () => {
    const { editor, doc, name, etag } = await setup();
    await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Use when checking.', 'See [[documentation/nowhere-' + uid() + ']] and [[rules/x]].\n'), etag });
    await editor.call('POST', `/docs/${doc}/versions`, {});
    await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Use when checking.'), etag: null });
    const latest = await editor.call('GET', `/nodes/${doc}/warnings`);
    expect(latest.json).toMatchObject({ version: 'draft', warnings: [] });
    const v1 = await editor.call('GET', `/nodes/${doc}/warnings?version=1`);
    expect(v1.json.version).toBe(1);
    expect(codes(v1.json.warnings)).toEqual(['link-broken', 'link-broken']);
  });

  it('nested references, rule size and procedure, long documentation pages', async () => {
    const { owner, editor, folder, doc, name, etag } = await setup();
    const tpl = (await editor.call('POST', '/docs', { parent: folder, name: 'tpl' })).json.node.id;
    await editor.call('PUT', `/docs/${tpl}/draft`, { content: `Next: [[skills/${name}/other]]\n`, etag: null });
    const put = await editor.call('PUT', `/docs/${doc}/draft`, { content: md(name, 'Use when checking.', `Use [[skills/${name}/tpl]].\n`), etag });
    expect(put.json.warnings.find((w: { code: string }) => w.code === 'refs-deep')?.message).toBe('Nested reference: tpl');

    const rule = (await owner.call('POST', '/docs', { parent: AREA.rules, name: 'zz-rule-' + uid() })).json.node.id;
    const steps = Array.from({ length: 6 }, (_, i) => `${i + 1}. Step ${i}`).join('\n');
    const r = await owner.call('PUT', `/docs/${rule}/draft`, { content: steps + '\n' + 'x'.repeat(2100), etag: null });
    expect(codes(r.json.warnings)).toEqual(['rule-long', 'rule-procedure']);
    const short = await owner.call('PUT', `/docs/${rule}/draft`, { content: 'Be brief.\n', etag: r.json.etag });
    expect(short.json.warnings).toEqual([]);
    await owner.call('POST', `/docs/${rule}/versions`, {});
    await owner.call('POST', `/docs/${rule}/publish`, { version: 1 });

    const docs = (await rootFolder(owner, { name: 'long-' + uid() })).json.id;
    const page = (await owner.call('POST', '/docs', { parent: docs, name: 'page' })).json.node.id;
    const long = await owner.call('PUT', `/docs/${page}/draft`, { content: 'line\n'.repeat(120), etag: null });
    expect(codes(long.json.warnings)).toEqual(['toc-missing']);
  });
});
