import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { enc, makeTeam, makeUser, sessionClient, tokenClient, type Client } from './helpers';
import type { Scope } from '../src/authz/scopes';

/**
 * Generated authorization matrix: roles x ops x inheritance boundary x team membership x token scope.
 *
 * Tree per scenario:  /<root> (grant here)  ->  sub (inherit = 0 when boundary)  ->  doc (published v1)
 * The subject's grant is on <root>; ops target "sub" (and its doc).
 */
const ROLES = ['none', 'viewer', 'editor', 'publisher', 'manager'] as const;
const PRINCIPALS = ['user', 'team', 'everyone'] as const;

interface OpCase {
  name: string;
  min: number;
  scope: Scope;
  run: (c: Client, t: { sub: string; doc: string; tag: string }) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test JSON
}

const OPS: OpCase[] = [
  { name: 'get_node', min: 1, scope: 'read', run: (c, t) => c.call('GET', `/nodes/${t.sub}`) },
  { name: 'get_skill', min: 1, scope: 'read', run: (c, t) => c.call('GET', `/docs/${t.doc}`) },
  { name: 'list_children', min: 1, scope: 'read', run: (c, t) => c.call('GET', `/children?folder=${t.sub}`) },
  { name: 'create_folder', min: 2, scope: 'write', run: (c, t) => c.call('POST', '/folders', { parent: t.sub, name: `f-${t.tag}-${Math.random()}` }) },
  { name: 'list_versions', min: 2, scope: 'write', run: (c, t) => c.call('GET', `/docs/${t.doc}/versions`) },
  { name: 'get_draft', min: 2, scope: 'write', run: (c, t) => c.call('GET', `/docs/${t.doc}/draft`) },
  { name: 'publish_version', min: 3, scope: 'publish', run: (c, t) => c.call('POST', `/docs/${t.doc}/publish`, { version: 1 }) },
  { name: 'list_grants', min: 4, scope: 'manage', run: (c, t) => c.call('GET', `/folders/${t.sub}/grants`) },
];

async function buildTree(owner: Client, tag: string, boundary: boolean): Promise<{ root: string; sub: string; doc: string }> {
  const root = (await owner.call('POST', '/folders', { name: `root-${tag}` })).json.id as string;
  const sub = (await owner.call('POST', '/folders', { parent: root, name: 'sub' })).json.id as string;
  if (boundary) expect((await owner.call('PUT', `/folders/${sub}/inherit`, { inherit: false })).status).toBe(200);
  const doc = (await owner.call('POST', '/docs', { parent: sub, name: 'skill', content: '---\nname: s\ndescription: d\n---\nbody' })).json.node.id as string;
  expect((await owner.call('POST', `/docs/${doc}/versions`, { message: 'v1' })).status).toBe(200);
  expect((await owner.call('POST', `/docs/${doc}/publish`, { version: 1 })).status).toBe(200);
  return { root, sub, doc };
}

function expected(rank: number, min: number, scopeOk: boolean): number {
  if (rank === 0) return 404;
  if (!scopeOk) return 403;
  return rank >= min ? 200 : 403;
}

describe('authorization matrix', () => {
  const ownerP = makeUser({ role: 'owner' }).then(sessionClient);
  let n = 0;

  for (const principal of PRINCIPALS) {
    for (let rank = 0; rank <= 4; rank++) {
      for (const boundary of [false, true]) {
        it(`${principal} ${ROLES[rank]} on parent, boundary=${boundary}`, async () => {
          const owner = await ownerP;
          const tag = `${principal}-${rank}-${boundary}-${n++}`;
          const tree = await buildTree(owner, tag, boundary);
          const subject = await makeUser();
          if (rank > 0) {
            let principalId: string = subject.id;
            if (principal === 'team') principalId = await makeTeam(`t-${tag}`, [{ user: subject }]);
            if (principal === 'everyone') principalId = 'everyone';
            const r = await owner.call('POST', `/folders/${tree.root}/grants`, {
              principal_type: principal === 'user' ? 'user' : 'team',
              principal: principalId,
              role: ROLES[rank],
            });
            expect(r.status).toBe(200);
          }
          // The grant is on the parent: a boundary on "sub" cuts it off entirely.
          const effective = boundary ? 0 : rank;
          const session = await sessionClient(subject);
          const readOnly = await tokenClient(subject, ['read']);
          for (const op of OPS) {
            const full = await op.run(session, { ...tree, tag });
            expect.soft(full.status, `${op.name} session`).toBe(expected(effective, op.min, true));
            const limited = await op.run(readOnly, { ...tree, tag });
            expect.soft(limited.status, `${op.name} read token`).toBe(expected(effective, op.min, op.scope === 'read'));
            if (limited.status === 403 && op.scope !== 'read' && effective >= op.min) expect(limited.json.error.code).toBe('scope_required');
          }
          // The direct grant on the boundary folder itself always applies.
          if (boundary && rank > 0) {
            await owner.call('POST', `/folders/${tree.sub}/grants`, { principal_type: 'user', principal: subject.id, role: ROLES[rank] });
            const r = await session.call('GET', `/nodes/${tree.sub}`);
            expect(r.status).toBe(200);
            expect(r.json.access).toBe(ROLES[rank]);
          }
        });
      }
    }
  }

  it('suspended users get nothing', async () => {
    const owner = await ownerP;
    const tree = await buildTree(owner, 'susp', false);
    const u = await makeUser();
    await owner.call('POST', `/folders/${tree.root}/grants`, { principal_type: 'user', principal: u.id, role: 'manager' });
    const c = await sessionClient(u);
    expect((await c.call('GET', `/nodes/${tree.sub}`)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    expect((await c.call('GET', `/nodes/${tree.sub}`)).status).toBe(401);
  });
});

describe('shared with me', () => {
  it('lists the highest readable folders and never names unreadable ones', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const secretRoot = (await owner.call('POST', '/folders', { name: 'Secret-Root-Name' })).json.id;
    const mid = (await owner.call('POST', '/folders', { parent: secretRoot, name: 'Hidden-Middle' })).json.id;
    const shared = (await owner.call('POST', '/folders', { parent: mid, name: 'Shared-Leaf' })).json.id;
    const u = await makeUser();
    await owner.call('POST', `/folders/${shared}/grants`, { principal_type: 'user', principal: u.id, role: 'viewer' });
    const c = await sessionClient(u);
    const top = await c.call('GET', '/children');
    const body = JSON.stringify(top.json);
    expect(top.json.items.map((i: { name: string }) => i.name)).toContain('Shared-Leaf');
    expect(body).not.toContain('Secret-Root-Name');
    expect(body).not.toContain('Hidden-Middle');
    const node = await c.call('GET', `/nodes/${shared}`);
    expect(node.json.path).toBe('/Shared-Leaf');
    expect(node.json.parent_id).toBeNull();
    expect(JSON.stringify(node.json)).not.toContain('Hidden-Middle');
    // Path refs resolve from the shared top.
    expect((await c.call('GET', `/nodes/${enc('/Shared-Leaf')}`)).status).toBe(200);
    expect((await c.call('GET', `/nodes/${enc('/Secret-Root-Name')}`)).status).toBe(404);
    expect((await c.call('GET', `/nodes/${secretRoot}`)).status).toBe(404);
  });

  it('hides a boundary child folder the user has no grant on', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const root = (await owner.call('POST', '/folders', { name: 'Open-Root' })).json.id;
    const closed = (await owner.call('POST', '/folders', { parent: root, name: 'Closed-Child' })).json.id;
    await owner.call('PUT', `/folders/${closed}/inherit`, { inherit: false });
    const u = await makeUser();
    await owner.call('POST', `/folders/${root}/grants`, { principal_type: 'user', principal: u.id, role: 'editor' });
    const c = await sessionClient(u);
    const list = await c.call('GET', `/children?folder=${root}`);
    expect(JSON.stringify(list.json)).not.toContain('Closed-Child');
  });

  it('viewers never see unpublished documents', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const root = (await owner.call('POST', '/folders', { name: 'Docs-Root' })).json.id;
    const doc = (await owner.call('POST', '/docs', { parent: root, name: 'unpublished-doc', content: 'x' })).json.node.id;
    const u = await makeUser();
    await owner.call('POST', `/folders/${root}/grants`, { principal_type: 'user', principal: u.id, role: 'viewer' });
    const c = await sessionClient(u);
    expect(JSON.stringify((await c.call('GET', `/children?folder=${root}`)).json)).not.toContain('unpublished-doc');
    expect((await c.call('GET', `/nodes/${doc}`)).status).toBe(404);
    expect(JSON.stringify((await c.call('GET', '/search?q=unpublished')).json)).not.toContain('unpublished-doc');
  });
});

describe('move', () => {
  it('needs manager on source and destination, rewrites paths in one batch and warns on access change', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const a = (await owner.call('POST', '/folders', { name: 'Move-A' })).json.id;
    const b = (await owner.call('POST', '/folders', { name: 'Move-B' })).json.id;
    const f = (await owner.call('POST', '/folders', { parent: a, name: 'payload' })).json.id;
    const inner = (await owner.call('POST', '/folders', { parent: f, name: 'inner' })).json.id;
    const doc = (await owner.call('POST', '/docs', { parent: inner, name: 'd', content: 'x' })).json.node.id;
    const u = await makeUser();
    await owner.call('POST', `/folders/${a}/grants`, { principal_type: 'user', principal: u.id, role: 'manager' });
    await owner.call('POST', `/folders/${b}/grants`, { principal_type: 'user', principal: u.id, role: 'editor' });
    const c = await sessionClient(u);
    expect((await c.call('POST', `/nodes/${f}/move`, { to: b })).status).toBe(403);
    await owner.call('POST', `/folders/${b}/grants`, { principal_type: 'user', principal: u.id, role: 'manager' });
    const r = await c.call('POST', `/nodes/${f}/move`, { to: b });
    expect(r.status).toBe(200);
    expect(r.json.moved).toBe(3);
    expect(r.json.access_changed).toBe(false);
    const row = await env.DB.prepare('SELECT path FROM nodes WHERE id = ?').bind(doc).first<{ path: string }>();
    expect(row!.path).toBe(`/${b}/${f}/${inner}/${doc}/`);
    const other = await makeUser();
    await owner.call('POST', `/folders/${a}/grants`, { principal_type: 'user', principal: other.id, role: 'viewer' });
    const back = await owner.call('POST', `/nodes/${f}/move`, { to: a });
    expect(back.json.access_changed).toBe(true);
    expect(back.json.warning).toBeTruthy();
  });

  it('refuses moving a folder into itself and caps subtree size', async () => {
    const owner = await sessionClient(await makeUser({ role: 'owner' }));
    const a = (await owner.call('POST', '/folders', { name: 'Self-A' })).json.id;
    const b = (await owner.call('POST', '/folders', { parent: a, name: 'b' })).json.id;
    expect((await owner.call('POST', `/nodes/${a}/move`, { to: b })).status).toBe(400);
    // Inflate the subtree past the cap with direct inserts.
    const big = (await owner.call('POST', '/folders', { name: 'Big' })).json.id;
    const path = (await env.DB.prepare('SELECT path FROM nodes WHERE id = ?').bind(big).first<{ path: string }>())!.path;
    const stmts = [];
    for (let i = 0; i < 5001; i++) {
      const id = `X${String(i).padStart(25, '0')}`;
      stmts.push(env.DB.prepare("INSERT INTO nodes (id, parent_id, kind, name, path, created_by, created_at, updated_at) VALUES (?,?, 'doc', ?, ?, 'x', 0, 0)").bind(id, big, `n${i}`, `${path}${id}/`));
    }
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    const r = await owner.call('POST', `/nodes/${big}/move`, { to: a });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('5000');
  });
});

describe('teams', () => {
  it('maintainers manage their own team only', async () => {
    const m = await makeUser();
    const x = await makeUser();
    const team = await makeTeam('maint-team', [{ user: m, role: 'maintainer' }]);
    const other = await makeTeam('other-team');
    const c = await sessionClient(m);
    expect((await c.call('PUT', `/teams/${team}/members/${x.id}`, { role: 'member' })).status).toBe(200);
    expect((await c.call('PUT', `/teams/${other}/members/${x.id}`, { role: 'member' })).status).toBe(403);
    expect((await c.call('DELETE', `/teams/${team}/members/${x.id}`)).status).toBe(200);
    expect((await c.call('POST', '/teams', { name: 'nope' })).status).toBe(403);
  });
});
