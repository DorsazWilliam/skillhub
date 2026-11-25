import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { AREA, enc, makeUser, rootFolder, sessionClient, type Client } from './helpers';
import { dialectOf } from '../src/node/sql';

const uid = (): string => crypto.randomUUID().slice(0, 8).toLowerCase();
const skillMd = (name: string, body = '1. Run the checks.\n', description = 'Use when checking a release.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}`;

/** Commit (and optionally publish) new content on a document, whatever its current draft state. */
async function save(c: Client, doc: string, content: string, publishWith?: Client): Promise<number> {
  const cur = await c.call('GET', `/docs/${doc}/draft`);
  const put = await c.call('PUT', `/docs/${doc}/draft`, { content, etag: cur.json.draft?.etag ?? null });
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  const v = await c.call('POST', `/docs/${doc}/versions`, {});
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  if (publishWith) expect((await publishWith.call('POST', `/docs/${doc}/publish`, { version: v.json.version })).status).toBe(200);
  return v.json.version;
}

describe('areas', () => {
  it('the top level is exactly rules, skills, documentation, prototypes, in that order', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const top = await owner.call('GET', '/children');
    expect(top.json.items.map((n: { id: string; is_area: boolean }) => [n.id, n.is_area])).toEqual([
      [AREA.rules, true],
      [AREA.skills, true],
      [AREA.documentation, true],
      [AREA.prototypes, true],
    ]);
  });

  it('areas cannot be renamed, moved or deleted, and no other root can be created', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    for (const id of Object.values(AREA)) {
      expect((await owner.call('PATCH', `/nodes/${id}`, { name: 'x' + uid() })).status).toBe(400);
      expect((await owner.call('DELETE', `/nodes/${id}`)).status).toBe(400);
      expect((await owner.call('POST', `/nodes/${id}/move`, { to: AREA.documentation === id ? AREA.skills : AREA.documentation })).status).toBe(400);
    }
    expect((await owner.call('POST', '/folders', { name: 'new-root' })).status).toBe(400);
    const f = (await owner.call('POST', '/folders', { parent: AREA.documentation, name: 'f-' + uid() })).json.id;
    expect((await owner.call('POST', `/nodes/${f}/move`, { to: '/' })).status).toBe(400);
    const top = await owner.call('GET', '/children');
    expect(top.json.items).toHaveLength(4);
  });

  it('rules hold markdown rules only: no folders, no files, no SKILL.md', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    expect((await owner.call('POST', '/folders', { parent: AREA.rules, name: 'sub' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: AREA.rules, name: 'x.sh' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: AREA.rules, name: 'SKILL.md' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: AREA.rules, name: 'rule-' + uid() })).status).toBe(200);
    // A folder cannot be moved into rules either.
    const f = (await owner.call('POST', '/folders', { parent: AREA.documentation, name: 'f-' + uid() })).json.id;
    expect((await owner.call('POST', `/nodes/${f}/move`, { to: AREA.rules })).status).toBe(400);
  });

  it('documents stay in their area; files and SKILL.md belong in skills', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const docs = (await owner.call('POST', '/folders', { parent: AREA.documentation, name: 'd-' + uid() })).json.id;
    expect((await owner.call('POST', '/docs', { parent: docs, name: 'run.py' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: docs, name: 'SKILL.md' })).status).toBe(400);
    const page = (await owner.call('POST', '/docs', { parent: docs, name: 'page' })).json.node.id;
    expect((await owner.call('PATCH', `/nodes/${page}`, { name: 'page.sh' })).status).toBe(400);
    const org = (await owner.call('POST', '/folders', { parent: AREA.skills, name: 'org-' + uid() })).json.id;
    // Outside a skill folder, skills/ holds no documents.
    expect((await owner.call('POST', '/docs', { parent: org, name: 'notes' })).status).toBe(400);
    expect((await owner.call('POST', '/docs', { parent: AREA.skills, name: 'SKILL.md' })).status).toBe(400);
    expect((await owner.call('POST', `/nodes/${page}/move`, { to: org })).status).toBe(400);
  });

  it('the seeded _hub skills are skill folders under skills/', async () => {
    const c = await sessionClient(await makeUser());
    const r = await c.call('GET', `/docs/${enc('skills/hub-authoring')}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'skill', canonical_path: 'skills/hub-authoring', path: '/skills/_hub/hub-authoring' });
    expect(r.json.files.map((f: { path: string }) => f.path)).toEqual(['SKILL.md']);
    expect(r.json.markdown).toContain('return `warnings`');
    expect(r.json.version).toBe(2);
    // Owners only can edit _hub (it keeps its boundary).
    expect((await c.call('GET', `/docs/${r.json.id}/draft`)).status).toBe(403);
  });
});

async function skillSetup(): Promise<{ owner: Client; editor: Client; viewer: Client; org: string; name: string; folder: string; md: string; etag: string }> {
  const owner = await sessionClient(await makeUser({ role: 'owner' }));
  const org = (await rootFolder(owner, { name: 'org-' + uid() }, 'skills')).json.id;
  const editorUser = await makeUser();
  const viewerUser = await makeUser();
  await owner.call('POST', `/folders/${org}/grants`, { principal_type: 'user', principal: editorUser.id, role: 'editor' });
  await owner.call('POST', `/folders/${org}/grants`, { principal_type: 'user', principal: viewerUser.id, role: 'viewer' });
  const editor = await sessionClient(editorUser);
  const viewer = await sessionClient(viewerUser);
  const name = 'release-check-' + uid();
  const created = await editor.call('POST', '/skills', { parent: org, name, description: 'Use when checking a release.' });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return { owner, editor, viewer, org, name, folder: created.json.folder.id, md: created.json.skill_md.id, etag: created.json.etag };
}

describe('skill folders', () => {
  it('create_skill makes a folder with a SKILL.md draft; viewers see it only once SKILL.md is published', async () => {
    const { owner, editor, viewer, folder, md, name } = await skillSetup();
    const node = await editor.call('GET', `/nodes/${folder}`);
    expect(node.json).toMatchObject({ is_skill: true, area: 'skills', canonical_path: `skills/${name}` });
    const draft = await editor.call('GET', `/docs/${md}/draft`);
    expect(draft.json.draft.content).toContain(`name: ${name}`);
    // Unpublished skill: invisible to viewers, folder and contents alike.
    expect((await viewer.call('GET', `/nodes/${folder}`)).status).toBe(404);
    expect((await viewer.call('GET', `/docs/${enc('skills/' + name)}`)).status).toBe(404);
    await save(editor, md, skillMd(name), owner);
    expect((await viewer.call('GET', `/nodes/${folder}`)).status).toBe(200);
  });

  it('find_skills returns skill folders, and plain documents are never returned', async () => {
    const { owner, editor, viewer, folder, md, name } = await skillSetup();
    await save(editor, md, skillMd(name, '1. Inspect the wombat ledger.\n'), owner);
    const docsFolder = (await rootFolder(owner, { name: 'docs-' + uid() })).json.id;
    await owner.call('POST', `/folders/${docsFolder}/grants`, { principal_type: 'user', principal: viewer.user.id, role: 'viewer' });
    const plain = (await owner.call('POST', '/docs', { parent: docsFolder, name: 'wombat-notes' })).json.node.id;
    await save(owner, plain, skillMd('wombat-notes', 'The wombat ledger reference.\n'), owner);

    const hits = (await viewer.call('GET', '/skills?task=wombat%20ledger')).json.skills;
    expect(hits.map((h: { id: string }) => h.id)).toEqual([folder]);
    expect(hits[0]).toMatchObject({ name, canonical_path: `skills/${name}`, version: 1 });
    // search finds both: the skill (as its folder) and the plain document by content.
    const found = (await viewer.call('GET', '/search?q=wombat%20ledger')).json.items.map((i: { node: { id: string } }) => i.node.id);
    expect(found).toContain(folder);
    expect(found).toContain(plain);
  });

  it('get_skill returns SKILL.md, its files (sub-skills listed, not descended) and only published files for viewers', async () => {
    const { owner, editor, viewer, folder, md, name } = await skillSetup();
    await save(editor, md, skillMd(name), owner);
    const scripts = (await editor.call('POST', '/folders', { parent: folder, name: 'scripts' })).json.id;
    const sh = (await editor.call('POST', '/docs', { parent: scripts, name: 'run.sh' })).json.node.id;
    const tpl = (await editor.call('POST', '/docs', { parent: folder, name: 'template' })).json.node.id;
    await save(editor, sh, '#!/bin/sh\necho ok\n', owner);
    await save(editor, tpl, '# Template\n');
    const sub = await editor.call('POST', '/skills', { parent: folder, name: 'sub-' + uid(), description: 'Use when going deeper.' });
    const subMd = sub.json.skill_md.id;
    await save(editor, subMd, skillMd(sub.json.folder.name), owner);
    const deep = (await editor.call('POST', '/docs', { parent: sub.json.folder.id, name: 'deep' })).json.node.id;
    await save(editor, deep, '# Deep\n', owner);

    const asEditor = await editor.call('GET', `/docs/${folder}`);
    expect(asEditor.json.files.map((f: { path: string; kind: string }) => [f.path, f.kind])).toEqual([
      ['SKILL.md', 'markdown'],
      ['scripts/run.sh', 'file'],
      ['template', 'markdown'],
      [sub.json.folder.name, 'skill'],
    ]);
    const asViewer = await viewer.call('GET', `/docs/${folder}`);
    expect(asViewer.json.kind).toBe('skill');
    expect(asViewer.json.files.map((f: { path: string }) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh', sub.json.folder.name]);
    expect(asViewer.json.files.find((f: { path: string }) => f.path === 'scripts/run.sh')).toMatchObject({ format: 'sh', published_version: 1, head_version: null });
    // Sub-skill canonical path hangs off the parent skill.
    const subNode = await viewer.call('GET', `/nodes/${sub.json.folder.id}`);
    expect(subNode.json.canonical_path).toBe(`skills/${name}/${sub.json.folder.name}`);
    expect((await viewer.call('GET', `/docs/${enc(`skills/${name}/scripts/run.sh`)}`)).json.id).toBe(sh);
  });

  it('script files are versioned like documents and served as plain text', async () => {
    const { owner, editor, viewer, folder, md, name } = await skillSetup();
    await save(editor, md, skillMd(name), owner);
    const py = await editor.call('POST', '/docs', { parent: folder, name: 'check.py' });
    expect(py.json.node).toMatchObject({ format: 'py', kind: 'doc' });
    const id = py.json.node.id;
    // Not markdown: frontmatter-looking content is not validated.
    const v1 = '---\nname: Not A Skill Name\n---\nprint("<script>alert(1)</script>")\n';
    await save(editor, id, v1, owner);
    await save(editor, id, v1 + 'print("v2")\n');
    const versions = await editor.call('GET', `/docs/${id}/versions`);
    expect(versions.json.items.map((v: { n: number }) => v.n)).toEqual([2, 1]);
    const res = await viewer.raw(`/api/v1/docs/${id}`);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { kind: string; format: string; markdown: string; frontmatter: unknown; version: number; assets: unknown[] };
    expect(body).toMatchObject({ kind: 'file', format: 'py', markdown: v1, frontmatter: null, version: 1, assets: [] });
    const diff = await editor.call('GET', `/docs/${id}/diff?from=1&to=2`);
    expect(diff.json.patch).toContain('+print("v2")');
    // Too large files are refused like documents.
    expect((await editor.call('PUT', `/docs/${id}/draft`, { content: 'x'.repeat(256 * 1024 + 1), etag: null })).status).toBe(400);
  });

  it('publish_skill publishes every changed file of the skill in one batch, with one audit row', async () => {
    const { owner, editor, folder, md, name } = await skillSetup();
    await save(editor, md, skillMd(name));
    const sh = (await editor.call('POST', '/docs', { parent: folder, name: 'run.sh' })).json.node.id;
    await save(editor, sh, 'echo 1\n', owner);
    await save(editor, sh, 'echo 2\n');
    const tpl = (await editor.call('POST', '/docs', { parent: folder, name: 'template' })).json.node.id;
    await save(editor, tpl, '# T\n', owner);
    const empty = (await editor.call('POST', '/docs', { parent: folder, name: 'empty' })).json.node.id;
    await editor.call('PUT', `/docs/${tpl}/draft`, { content: '# T draft\n', etag: null });
    const sub = await editor.call('POST', '/skills', { parent: folder, name: 'sub-' + uid(), description: 'Use when nested.' });
    await save(editor, sub.json.skill_md.id, skillMd(sub.json.folder.name));

    // Editors cannot publish.
    expect((await editor.call('POST', `/skills/${folder}/publish`, {})).status).toBe(403);

    const before = (await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE op = 'publish_skill' AND node_id = ?").bind(folder).first<{ c: number }>())!.c;
    const r = await owner.call('POST', `/skills/${enc('skills/' + name)}/publish`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.published).toBe(2);
    const by = Object.fromEntries(r.json.files.map((f: { id: string }) => [f.id, f]));
    expect(by[md]).toMatchObject({ status: 'published', from: null, to: 1 });
    expect(by[sh]).toMatchObject({ status: 'published', from: 1, to: 2 });
    expect(by[tpl]).toMatchObject({ status: 'unchanged', from: 1, to: 1, has_draft: true });
    expect(by[empty]).toMatchObject({ status: 'empty' });
    expect(by[sub.json.skill_md.id]).toBeUndefined();
    expect(Array.isArray(by[md].warnings)).toBe(true);
    // The sub-skill is left alone.
    expect((await owner.call('GET', `/nodes/${sub.json.skill_md.id}`)).json.published_version).toBeNull();
    const after = (await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE op = 'publish_skill' AND node_id = ?").bind(folder).first<{ c: number }>())!.c;
    expect(after - before).toBe(1);
    expect((await owner.call('POST', `/skills/${folder}/publish`, {})).json.published).toBe(0);
    // Not a skill folder.
    const org = (await owner.call('GET', `/nodes/${folder}`)).json;
    expect((await owner.call('POST', `/skills/${AREA.skills}/publish`, {})).status).toBe(400);
    expect(org.is_skill).toBe(true);
  });

  it('publish_skill is atomic: when one file fails, none is published', async () => {
    const { owner, editor, folder, md, name } = await skillSetup();
    await save(editor, md, skillMd(name));
    const a = (await editor.call('POST', '/docs', { parent: folder, name: 'a.sh' })).json.node.id;
    await save(editor, a, 'echo a\n');
    // Make publishing file a fail inside the batch (SQLite or Postgres trigger).
    const pg = dialectOf(env.DB) === 'postgres';
    if (pg) {
      await env.DB.exec(
        `CREATE FUNCTION fail_publish_${a}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;\n` +
          `CREATE TRIGGER fail_publish_${a} BEFORE UPDATE OF published_version ON nodes FOR EACH ROW WHEN (NEW.id = '${a}') EXECUTE FUNCTION fail_publish_${a}();`,
      );
    } else {
      await env.DB.prepare(`CREATE TRIGGER fail_publish_${a} BEFORE UPDATE OF published_version ON nodes WHEN NEW.id = '${a}' BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    }
    try {
      const r = await owner.call('POST', `/skills/${folder}/publish`, {});
      expect(r.status).toBe(500);
      const rows = await env.DB.prepare('SELECT id, published_version FROM nodes WHERE id IN (?, ?)').bind(md, a).all<{ id: string; published_version: number | null }>();
      expect(rows.results.every((x) => x.published_version === null)).toBe(true);
      expect(await env.DB.prepare('SELECT 1 FROM skill_fts WHERE doc_id = ?').bind(md).first()).toBeNull();
    } finally {
      if (pg) await env.DB.exec(`DROP TRIGGER fail_publish_${a} ON nodes; DROP FUNCTION fail_publish_${a}();`);
      else await env.DB.prepare(`DROP TRIGGER fail_publish_${a}`).run();
    }
    expect((await owner.call('POST', `/skills/${folder}/publish`, {})).json.published).toBe(2);
  });
});
