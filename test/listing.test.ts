import { describe, expect, it } from 'vitest';
import { AREA, makeUser, sessionClient, type Client } from './helpers';

const uid = (): string => crypto.randomUUID().slice(0, 8).toLowerCase();

async function save(c: Client, doc: string, content: string): Promise<number> {
  const cur = await c.call('GET', `/docs/${doc}/draft`);
  expect((await c.call('PUT', `/docs/${doc}/draft`, { content, etag: cur.json.draft?.etag ?? null })).status).toBe(200);
  const v = await c.call('POST', `/docs/${doc}/versions`, {});
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  return v.json.version;
}

describe('list_children extras', () => {
  it('summarizes skills, documents and folders, role-aware', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner', name: 'Olive Owner' }));
    const viewer = await sessionClient(await makeUser());
    const group = (await owner.call('POST', '/folders', { parent: AREA.skills, name: 'g-' + uid() })).json.id;
    const name = 'sk-' + uid();
    const sk = await owner.call('POST', '/skills', { parent: group, name, description: 'Use when testing listings.' });
    expect(sk.status, JSON.stringify(sk.json)).toBe(200);
    const md = sk.json.skill_md.id;
    const folder = sk.json.folder.id;
    await save(owner, md, `---\nname: ${name}\ndescription: Use when testing listings.\n---\n# T\n\nSee [[documentation/x]] and [[documentation/y]].\n`);
    const file = (await owner.call('POST', '/docs', { parent: folder, name: 'run.sh', content: 'echo hi\n' })).json.node.id;
    await owner.call('POST', `/docs/${file}/versions`, {});

    let r = await owner.call('GET', `/children?folder=${group}`);
    const item = r.json.items.find((i: { id: string }) => i.id === folder);
    expect(item.skill).toMatchObject({ name, description: 'Use when testing listings.', version: 1, files: 2, state: 'unpublished', pending: 2 });

    expect((await owner.call('POST', `/skills/${folder}/publish`, {})).status).toBe(200);
    r = await owner.call('GET', `/children?folder=${group}`);
    expect(r.json.items.find((i: { id: string }) => i.id === folder).skill).toMatchObject({ state: 'published', pending: 0 });

    await owner.call('PUT', `/docs/${file}/draft`, { content: 'echo bye\n', etag: null });
    r = await owner.call('GET', `/children?folder=${group}`);
    expect(r.json.items.find((i: { id: string }) => i.id === folder).skill.state).toBe('draft');

    // Viewers see published data only, and no state.
    const vr = await viewer.call('GET', `/children?folder=${group}`);
    expect(vr.json.items.find((i: { id: string }) => i.id === folder).skill).toMatchObject({ name, version: 1, files: 2, state: null, pending: 0 });

    // Documents carry author and link count; plain folders a readable child count.
    const inner = await owner.call('GET', `/children?folder=${folder}`);
    const mdItem = inner.json.items.find((i: { id: string }) => i.id === md);
    expect(mdItem.author).toEqual({ id: owner.user.id, name: 'Olive Owner' });
    expect(mdItem.links).toBe(2);
    const top = await owner.call('GET', `/children?folder=${AREA.skills}`);
    expect(top.json.items.find((i: { id: string }) => i.id === group).children).toBe(1);
  });
});
