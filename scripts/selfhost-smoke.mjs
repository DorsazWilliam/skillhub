// Smoke test for a running self-hosted SkillHub with DEV_LOGIN=true on localhost:
// sign in, write, commit, publish, search, upload and read an image, create and preview a prototype.
// Usage: node scripts/selfhost-smoke.mjs http://localhost:8099
const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const DOCS = '00000000000000000000000AD1';
const PROTOS = '00000000000000000000000AP1';
let cookie = '';

async function call(method, path, body) {
  const headers = { 'x-skillhub-csrf': '1', origin: BASE, cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, json, headers: r.headers };
}
function ok(cond, what, extra) {
  if (!cond) {
    console.error('FAIL', what, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
    process.exit(1);
  }
  console.log('ok  ', what);
}

for (let i = 0; i < 60; i++) {
  const h = await fetch(BASE + '/healthz').catch(() => null);
  if (h?.ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const login = await call('POST', '/auth/dev-login', { as: 'owner' });
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
ok(login.status < 400 && cookie, 'dev sign-in', login.json);

const me = await call('GET', '/api/v1/me');
ok(me.status === 200, 'whoami', me.json);
const top = await call('GET', '/api/v1/children');
ok(top.json.items.length === 4, 'four areas', top.json.items.map((n) => n.name));

const name = 'smoke-' + Date.now();
const folder = await call('POST', '/api/v1/folders', { parent: DOCS, name });
ok(folder.status === 200, 'create folder', folder.json);
const doc = await call('POST', '/api/v1/docs', { parent: folder.json.id, name: 'runbook', content: '# Runbook\n\nHow we roll out canary deployments safely.\n' });
ok(doc.status === 200, 'create doc with draft', doc.json);
const id = doc.json.node.id;
ok((await call('POST', `/api/v1/docs/${id}/versions`, { message: 'v1' })).status === 200, 'commit');
ok((await call('POST', `/api/v1/docs/${id}/publish`, { version: 1 })).status === 200, 'publish');

const search = await call('GET', '/api/v1/search?q=canary');
ok(search.json.items?.some((i) => i.node.id === id), 'full-text search finds it', search.json);
const skills = await call('GET', '/api/v1/skills?task=publish%20a%20skill');
ok(skills.status === 200 && skills.json.skills?.length > 0, 'find_skills ranks the built-in skills', skills.json);

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const up = await call('POST', `/api/v1/docs/${id}/assets`, { data_base64: png, alt: 'dot' });
ok(up.status === 200, 'upload image (file storage write)', up.json);
const img = await fetch(BASE + '/a/' + up.json.id, { headers: { cookie } });
ok(img.status === 200 && (await img.arrayBuffer()).byteLength === 70, 'read image back (file storage read)');

const proto = await call('POST', '/api/v1/prototypes', { parent: PROTOS, name });
ok(proto.status === 200, 'create prototype', proto.json);
const gp = await call('GET', `/api/v1/prototypes/${proto.json.folder.id}`);
const page = await fetch(gp.json.preview_url);
ok(page.status === 200 && (await page.text()).includes('<h1>'), 'prototype preview link');

const usage = await call('GET', '/api/v1/usage?days=30');
ok(usage.status === 200, 'usage page data', usage.json);
console.log('\nAll checks passed against', BASE);
