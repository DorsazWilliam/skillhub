import { describe, expect, it } from 'vitest';
import { AREA, enc, makeUser, rootFolder, sessionClient, type Client } from './helpers';

const uid = (): string => crypto.randomUUID().slice(0, 8).toLowerCase();

async function save(c: Client, doc: string, content: string, publish = true): Promise<void> {
  const cur = await c.call('GET', `/docs/${doc}/draft`);
  expect((await c.call('PUT', `/docs/${doc}/draft`, { content, etag: cur.json.draft?.etag ?? null })).status).toBe(200);
  const v = await c.call('POST', `/docs/${doc}/versions`, {});
  expect(v.status, JSON.stringify(v.json)).toBe(200);
  if (publish) expect((await c.call('POST', `/docs/${doc}/publish`, { version: v.json.version })).status).toBe(200);
}

/**
 * documentation/<open>/guide            readable by the viewer
 * documentation/<secret>/hidden-page    isolated, no grant for the viewer
 * skills/<org>/<skill>/SKILL.md + tpl   readable by the viewer
 * rules/<rule>                          links in every direction
 */
type Keys = 'open' | 'secret' | 'skill' | 'rule' | 'org' | 'openId' | 'secretId' | 'orgId' | 'guide' | 'hidden' | 'skillId' | 'skillMd' | 'tpl' | 'ruleId';

async function world(): Promise<{ owner: Client; viewer: Client; t: Record<Keys, string> }> {
  const owner = await sessionClient(await makeUser({ role: 'owner' }));
  const viewer = await sessionClient(await makeUser());
  const t: Record<Keys, string> = {
    open: 'open-' + uid(),
    secret: 'secret-' + uid(),
    skill: 'lk-' + uid(),
    rule: 'rule-' + uid(),
    org: 'org-' + uid(),
    openId: '',
    secretId: '',
    orgId: '',
    guide: '',
    hidden: '',
    skillId: '',
    skillMd: '',
    tpl: '',
    ruleId: '',
  };
  t.openId = (await rootFolder(owner, { name: t.open })).json.id;
  t.secretId = (await rootFolder(owner, { name: t.secret })).json.id;
  t.orgId = (await rootFolder(owner, { name: t.org }, 'skills')).json.id;
  for (const f of [t.openId, t.orgId]) await owner.call('POST', `/folders/${f}/grants`, { principal_type: 'user', principal: viewer.user.id, role: 'viewer' });

  t.guide = (await owner.call('POST', '/docs', { parent: t.openId, name: 'guide' })).json.node.id;
  await save(owner, t.guide, '# Guide\n');
  t.hidden = (await owner.call('POST', '/docs', { parent: t.secretId, name: 'hidden-page' })).json.node.id;
  await save(owner, t.hidden, '# Hidden\n');

  const sk = await owner.call('POST', '/skills', { parent: t.orgId, name: t.skill, description: 'Use when linking.' });
  t.skillId = sk.json.folder.id;
  t.skillMd = sk.json.skill_md.id;
  t.tpl = (await owner.call('POST', '/docs', { parent: t.skillId, name: 'tpl' })).json.node.id;
  await save(owner, t.tpl, '# Template\n');
  await save(
    owner,
    t.skillMd,
    `---\nname: ${t.skill}\ndescription: Use when linking.\n---\nSee [[documentation/${t.open}/guide]], [[skills/${t.skill}/tpl|the template]] and [[rules/${t.rule}]].\n`,
  );

  t.ruleId = (await owner.call('POST', '/docs', { parent: AREA.rules, name: t.rule })).json.node.id;
  await save(
    owner,
    t.ruleId,
    `Follow [[documentation/${t.open}/guide]] and [[skills/${t.skill}]].\nAlso [[documentation/${t.secret}/hidden-page]], [[documentation/${t.open}/missing]] and [[rules/${t.rule}]].\n`,
  );
  return { owner, viewer, t };
}

describe('canonical links', () => {
  it('classifies outgoing links: ok, wrong_direction, broken, locked; locked targets are never named', async () => {
    const { owner, viewer, t } = await world();
    const r = await viewer.call('GET', `/nodes/${t.ruleId}/links`);
    expect(r.status).toBe(200);
    expect(r.json.outgoing.map((l: { status: string }) => l.status)).toEqual(['ok', 'ok', 'locked', 'broken', 'wrong_direction']);
    expect(r.json.outgoing[0]).toMatchObject({ id: t.guide, canonical_path: `documentation/${t.open}/guide`, kind: 'doc' });
    expect(r.json.outgoing[1]).toMatchObject({ id: t.skillId, canonical_path: `skills/${t.skill}`, kind: 'skill' });
    expect(r.json.outgoing[2]).toMatchObject({ href: null, id: null, canonical_path: null, kind: null });
    const body = JSON.stringify(r.json);
    expect(body).not.toContain(t.secret);
    expect(body).not.toContain('hidden-page');
    expect(body).not.toContain(t.hidden);
    // get_skill gives the same classification, still without naming the locked target.
    const read = await viewer.call('GET', `/docs/${t.ruleId}`);
    expect(read.json.links.map((l: { status: string }) => l.status)).toEqual(['ok', 'ok', 'locked', 'broken', 'wrong_direction']);
    expect(JSON.stringify(read.json.links)).not.toContain(t.secret);
    // The owner can read the target, so for them it is ok.
    const asOwner = await owner.call('GET', `/nodes/${t.ruleId}/links`);
    expect(asOwner.json.outgoing[2]).toMatchObject({ status: 'ok', id: t.hidden });
  });

  it('skills may link to documentation and their own files, not to rules', async () => {
    const { viewer, t } = await world();
    const r = await viewer.call('GET', `/nodes/${t.skillId}/links`);
    expect(r.json.outgoing.map((l: { status: string; label: string | null }) => [l.status, l.label])).toEqual([
      ['ok', null],
      ['ok', 'the template'],
      ['wrong_direction', null],
    ]);
    expect(r.json.outgoing[1].id).toBe(t.tpl);
  });

  it('backlinks: readable sources only; viewers see published links, editors the working copy', async () => {
    const { owner, viewer, t } = await world();
    const viewerBack = await viewer.call('GET', `/nodes/${t.guide}/links`);
    const ids = viewerBack.json.backlinks.map((b: { id: string }) => b.id).sort();
    expect(ids).toEqual([t.ruleId, t.skillMd].sort());
    const fromSkill = viewerBack.json.backlinks.find((b: { id: string }) => b.id === t.skillMd);
    expect(fromSkill).toMatchObject({ skill_id: t.skillId, canonical_path: `skills/${t.skill}`, area: 'skills', status: 'ok' });

    // A draft-only link shows up for editors, not viewers.
    const draftDoc = (await owner.call('POST', '/docs', { parent: t.openId, name: 'draft-linker' })).json.node.id;
    await owner.call('PUT', `/docs/${draftDoc}/draft`, { content: `See [[documentation/${t.open}/guide]]\n`, etag: null });
    expect((await owner.call('GET', `/nodes/${t.guide}/links`)).json.backlinks.map((b: { id: string }) => b.id)).toContain(draftDoc);
    expect((await viewer.call('GET', `/nodes/${t.guide}/links`)).json.backlinks.map((b: { id: string }) => b.id)).not.toContain(draftDoc);

    // A source the viewer cannot read is not listed.
    const hiddenLinker = (await owner.call('POST', '/docs', { parent: t.secretId, name: 'secret-linker' })).json.node.id;
    await save(owner, hiddenLinker, `See [[documentation/${t.open}/guide]]\n`);
    const again = await viewer.call('GET', `/nodes/${t.guide}/links`);
    expect(JSON.stringify(again.json)).not.toContain(hiddenLinker);
    expect(JSON.stringify(again.json)).not.toContain(t.secret);
    expect((await owner.call('GET', `/nodes/${t.guide}/links`)).json.backlinks.map((b: { id: string }) => b.id)).toContain(hiddenLinker);

    // Backlinks to a skill folder include links written to the skill's short canonical path.
    const skillBack = await viewer.call('GET', `/nodes/${enc('skills/' + t.skill)}/links`);
    expect(skillBack.json.backlinks.map((b: { id: string }) => b.id)).toEqual([t.ruleId]);
  });

  it('links follow the target: a later created target turns broken into ok', async () => {
    const { owner, t } = await world();
    const before = await owner.call('GET', `/nodes/${t.ruleId}/links`);
    expect(before.json.outgoing[3].status).toBe('broken');
    const missing = (await owner.call('POST', '/docs', { parent: t.openId, name: 'missing' })).json.node.id;
    const after = await owner.call('GET', `/nodes/${t.ruleId}/links`);
    expect(after.json.outgoing[3]).toMatchObject({ status: 'ok', id: missing });
  });

  it('graph: viewers get published, readable nodes only; editors see more; files collapse into their skill', async () => {
    const { owner, viewer, t } = await world();
    const draftOnly = (await owner.call('POST', '/docs', { parent: t.openId, name: 'draft-only-' + uid() })).json.node.id;
    await owner.call('PUT', `/docs/${draftOnly}/draft`, { content: `[[documentation/${t.open}/guide]]\n`, etag: null });

    const g = await viewer.call('GET', '/graph');
    expect(g.status).toBe(200);
    const ids = new Set(g.json.nodes.map((n: { id: string }) => n.id));
    expect(ids.has(t.guide)).toBe(true);
    expect(ids.has(t.skillId)).toBe(true);
    expect(ids.has(t.ruleId)).toBe(true);
    expect(ids.has(t.tpl)).toBe(false);
    expect(ids.has(t.hidden)).toBe(false);
    expect(ids.has(draftOnly)).toBe(false);
    expect(JSON.stringify(g.json)).not.toContain(t.secret);
    const skillNode = g.json.nodes.find((n: { id: string }) => n.id === t.skillId);
    expect(skillNode).toMatchObject({ kind: 'skill', open_id: t.skillMd, area: 'skills', canonical_path: `skills/${t.skill}`, published: true });
    const edge = (from: string, to: string): { status: string } | undefined =>
      g.json.edges.find((e: { from: string; to: string }) => e.from === from && e.to === to);
    expect(edge(t.ruleId, t.guide)?.status).toBe('ok');
    expect(edge(t.ruleId, t.skillId)?.status).toBe('ok');
    expect(edge(t.skillId, t.ruleId)?.status).toBe('wrong_direction');
    expect(edge(t.ruleId, t.hidden)).toBeUndefined();

    const og = await owner.call('GET', '/graph');
    const oids = new Set(og.json.nodes.map((n: { id: string }) => n.id));
    expect(oids.has(t.hidden)).toBe(true);
    expect(oids.has(draftOnly)).toBe(true);
    expect(og.json.edges.find((e: { from: string; to: string }) => e.from === t.ruleId && e.to === t.hidden)?.status).toBe('ok');

    const onlyRules = await viewer.call('GET', '/graph?area=rules');
    expect(onlyRules.json.nodes.every((n: { area: string }) => n.area === 'rules')).toBe(true);
  });
});
