#!/usr/bin/env node
// Loads the prototype's Acme demo (prototype/index.html) into the LOCAL stack so the real app looks like the prototype.
//
//   npx wrangler d1 migrations apply DB --local            (once, on a fresh local state)
//   npx wrangler dev --infer-origin-from-routes=false     (with .dev.vars: BASE_URL=http://localhost:8787, DEV_LOGIN=true)
//   node scripts/seed-demo.mjs [--base http://localhost:8787] [--persist-to <dir>] [--force]
//
// Users and sessions go in with `wrangler d1 execute --local`; all content goes through the REST API as those users,
// so drafts, versions, links, search and warnings are real. Timestamps are then backdated with SQL.
// LOCAL ONLY: the base URL must be localhost or 127.0.0.1, and wrangler is never called with --remote.
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('--base', 'http://localhost:8787').replace(/\/+$/, '');
const PERSIST = opt('--persist-to', null);
const FORCE = args.includes('--force');
const ORIGIN = new URL(BASE).origin;
if (!['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)) {
  console.error(`Refusing to seed ${BASE}: the demo seed only runs against a local stack (localhost or 127.0.0.1).`);
  process.exit(1);
}
if (args.includes('--remote')) {
  console.error('Refusing: --remote is never allowed for the demo seed.');
  process.exit(1);
}

// ---------- wrangler d1 (local only) ----------
const tmp = mkdtempSync(join(tmpdir(), 'skillhub-seed-'));
let sqlN = 0;
function d1(sql, json = false) {
  const file = join(tmp, `q${++sqlN}.sql`);
  writeFileSync(file, sql);
  const a = ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', file];
  if (PERSIST) a.push('--persist-to', PERSIST);
  if (json) a.push('--json');
  const cmd = ['npx', ...a].map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ');
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!json) return null;
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ---------- seed text from the prototype ----------
const html = readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
const SEED = {};
for (const m of html.matchAll(/<script type="text\/markdown" data-seed="([^"]+)">([\s\S]*?)<\/script>/g)) {
  SEED[m[1]] = m[2].replace(/^\n/, '').trimEnd() + '\n';
}
SEED['runbooks'] = (() => {
  let s = '# Runbooks\n\nOne section per service. Owners are in [[documentation/engineering/architecture]].\n';
  for (const [n, sym] of [
    ['auth', 'Login failures or token errors'],
    ['billing', 'Invoices stuck in pending'],
    ['core-api', '5xx responses on product pages'],
    ['gateway', 'Timeouts on every route'],
    ['warehouse-loader', 'Events older than 15 minutes in raw'],
    ['notifier', 'Emails delayed or duplicated'],
    ['search', 'Empty or stale results'],
  ])
    s += `\n## ${n}\n\n### Symptoms\n- ${sym}.\n- Error rate above 2 percent for 5 minutes.\n- p95 latency above 800 ms.\n\n### Checks\n1. Open the ${n} dashboard.\n2. Compare with the last deploy time.\n3. Read the last 30 minutes of logs.\n\n### Fix\n- Roll back if a deploy started it.\n- Scale out if traffic doubled.\n- Escalate after 15 minutes.\n`;
  return s;
})();

// ---------- the prototype's data ----------
const MIN = 6e4, HR = 36e5, DAY = 864e5, T0 = Date.now();
const DEV_TID = 'dev-local'; // must match src/auth/dev.ts
const USERS = [
  { k: 'u1', name: 'Alice Chen', email: 'alice.chen@acme.com', oid: 'dev-owner', role: 'owner', status: 'active', last: T0 - 4 * MIN },
  { k: 'u2', name: 'Marcus Webb', email: 'marcus.webb@acme.com', oid: 'dev-publisher', role: 'member', status: 'active', last: T0 - HR },
  { k: 'u3', name: 'Priya Raman', email: 'priya.raman@acme.com', oid: 'dev-priya', role: 'member', status: 'active', last: T0 - 12 * MIN },
  { k: 'u4', name: 'Jonas Keller', email: 'jonas.keller@acme.com', oid: 'dev-jonas', role: 'member', status: 'active', last: T0 - 3 * DAY },
  { k: 'u5', name: 'Tom Becker', email: 'tom.becker@acme.com', oid: 'dev-viewer', role: 'member', status: 'active', last: T0 - 2 * DAY },
  { k: 'u6', name: 'Sofia Alvarez', email: 'sofia.alvarez@acme.com', oid: 'dev-sofia', role: 'member', status: 'active', last: T0 - 5 * HR },
  { k: 'u7', name: 'Daniel Okafor', email: 'daniel.okafor@acme.com', oid: 'dev-daniel', role: 'member', status: 'active', last: T0 - DAY },
  { k: 'u8', name: 'Hannah Lund', email: 'hannah.lund@acme.com', oid: 'dev-hannah', role: 'member', status: 'suspended', last: T0 - 41 * DAY },
];
const TEAMS = [
  { k: 't_eng', name: 'Engineering', desc: 'Product and platform engineers', members: [['u2', 'maintainer'], ['u3', 'member'], ['u4', 'member']] },
  { k: 't_data', name: 'Data', desc: 'Analytics engineering', members: [['u3', 'maintainer'], ['u8', 'member']] },
  { k: 't_sales', name: 'Sales', desc: 'Account executives and SDRs', members: [['u6', 'maintainer'], ['u7', 'member']] },
];
const AREA = { A_rules: '00000000000000000000000AR1', A_skills: '00000000000000000000000AS1', A_docs: '00000000000000000000000AD1' };

/** Ordered structure, as in the prototype: ['folder', key, parent, name, inherit] | ['skill', key, parent, name] | ['doc', key, parent, name, seedKey, opts] */
const S = [];
const folder = (k, p, name, inherit = 1) => S.push(['folder', k, p, name, inherit]);
const skill = (k, p, name) => S.push(['skill', k, p, name]);
const doc = (k, p, name, seed, o = {}) => S.push(['doc', k, p, name, seed, o]);
const dr = (content, by, ago) => ({ content, by, ago });

doc('r_sec', 'A_rules', 'security', 'rule-security', { by: ['u4'], ago: 90 });
doc('r_wri', 'A_rules', 'writing', 'rule-writing', { by: ['u2'], ago: 80 });
doc('r_code', 'A_rules', 'code-standards', 'rule-code', { back: [[['- Review with [[skills/code-review]] before asking a human.\n- Ship only through [[skills/deploy-service]].\n', '']]], msgs: ['Tests and boundaries', 'Point to the code-review skill'], by: ['u2'], ago: 70 });
doc('r_data', 'A_rules', 'data-handling', 'rule-data', { by: ['u1'], ago: 65, draft: dr(SEED['rule-data'] + '- Exports to customers go through the data team.\n', 'u2', 3 * HR) });
doc('r_esc', 'A_rules', 'escalation', 'rule-escalation', { by: ['u2'], ago: 50 });
doc('r_com', 'A_rules', 'customer-commitments', 'rule-commitments', { by: ['u1'], ago: 40 });

folder('f_seng', 'A_skills', 'engineering');
skill('s_cr', 'f_seng', 'code-review');
folder('f_cr_t', 's_cr', 'templates');
doc('d_cr', 's_cr', 'SKILL.md', 'code-review', { back: [[['\n## Escalate\n- Anything touching auth, billing or data deletion needs a second reviewer. See [[documentation/security/secrets-policy]].\n', '']], [['- Suggest code, do not describe it.\n', '']], [['4. Check risk: migrations, feature flags, rollback path.\n5. Style last', '4. Style last']]], msgs: ['Initial checklist', 'Add risk step', 'Suggest code in comments', 'Escalation for sensitive areas'], by: ['u2', 'u4', 'u2', 'u3'], ago: 60 });
doc('d_cr_t', 'f_cr_t', 'review-comment', 'review-comment', { by: ['u2'], ago: 55 });
skill('s_dep', 'f_seng', 'deploy-service');
folder('f_dep_s', 's_dep', 'scripts');
folder('f_dep_t', 's_dep', 'templates');
skill('s_rb', 's_dep', 'rollback');
skill('s_can', 's_dep', 'canary');
doc('d_dep', 's_dep', 'SKILL.md', 'deploy-service', { back: [[['2. Promote with a canary: [[skills/deploy-service/canary]].\n3. Watch', '2. Watch']], [['- Risky changes ship behind a flag: [[documentation/engineering/feature-flags]].\n', '']], [['1. Deploy to staging and run [[skills/deploy-service/scripts/smoke-test.sh]].\n', '1. Deploy to staging and check the health endpoint.\n']]], msgs: ['Deploy checklist', 'Run the smoke test script', 'Ship risky changes behind flags', 'Canary before full rollout'], pub: 3, by: ['u2', 'u3', 'u2', 'u2'], ago: 45 });
doc('d_dep_sh', 'f_dep_s', 'smoke-test.sh', 'smoke-test.sh', { back: [[['for attempt in 1 2 3; do\n  if curl -fsS "$BASE/healthz" > /dev/null; then\n    break\n  fi\n  echo "health check failed, attempt $attempt" >&2\n  sleep 5\ndone\n\n', '']]], msgs: ['Health and version checks', 'Retry health check 3 times'], pub: 1, by: ['u3', 'u2'], ago: 40 });
doc('d_dep_rn', 'f_dep_t', 'release-notes', 'release-notes', { by: ['u2'], ago: 44 });
doc('d_rb', 's_rb', 'SKILL.md', 'rollback', { by: ['u2'], ago: 30 });
doc('d_can', 's_can', 'SKILL.md', 'canary', { pub: null, by: ['u2'], ago: 2 });
skill('s_ir', 'f_seng', 'incident-response');
folder('f_ir_t', 's_ir', 'templates');
folder('f_ir_s', 's_ir', 'scripts');
doc('d_ir', 's_ir', 'SKILL.md', 'incident-response', {
  back: [
    [['- **Scribe** records every action with a timestamp.\n', ''], ['| SEV3 | Minor, workaround exists | 2 h |', '| SEV3 | Minor, workaround exists | 1 h |']],
    [['dashboard for 15 minutes.', 'dashboard.']],
    [['- File follow-ups as tickets with an owner and a date.\n', '']],
    [['![Severity matrix](asset://a-sev)\n\n', '']],
    [['| SEV2 | Major feature degraded | 30 min |', '| SEV2 | Major feature degraded | 1 h |']],
    [['1. Mitigate first. Roll back before you debug.', '1. Mitigate first.']],
    [['\n## After\n- Write the postmortem within 3 business days with [[skills/incident-response/templates/postmortem|the template]].\n', '']],
  ],
  msgs: ['Initial runbook', 'Add postmortem section', 'Roll back before debugging', 'SEV2 updates every 30 min', 'Add severity diagram', 'File follow-ups as tickets', 'Confirm recovery for 15 min', 'Add scribe, SEV3 every 2 h'],
  pub: 7,
  by: ['u4', 'u2', 'u4', 'u2', 'u3', 'u4', 'u2', 'u4'],
  ago: 80,
  asset: 'a-sev',
  dismiss: ['dated'],
});
doc('d_ir_pm', 'f_ir_t', 'postmortem', 'postmortem', { by: ['u4'], ago: 70 });
doc('d_ir_sh', 'f_ir_s', 'collect-logs.sh', 'collect-logs.sh', { by: ['u3'], ago: 35 });
folder('f_ssec', 'A_skills', 'security', 0);
skill('s_rot', 'f_ssec', 'rotating-secrets');
folder('f_rot_s', 's_rot', 'scripts');
doc('d_rot', 's_rot', 'SKILL.md', 'rotating-secrets', { by: ['u4'], ago: 70 });
doc('d_rot_py', 'f_rot_s', 'rotate.py', 'rotate.py', { by: ['u4'], ago: 70 });
folder('f_sdata', 'A_skills', 'data');
skill('s_sql', 'f_sdata', 'sql-review');
folder('f_sql_s', 's_sql', 'scripts');
doc('d_sql', 's_sql', 'SKILL.md', 'sql-review', { back: [[['- Check the query plan for full scans on tables over 10 GB with [[skills/sql-review/scripts/explain-check.sql]].\n', ''], ['\nSee [[documentation/data/dbt-conventions]] for model naming and [[documentation/data/warehouse]] for table sizes.\n', '']], [['\n## Safety\n- Migrations are additive. Drop columns in a later release.\n- `UPDATE` and `DELETE` run inside a transaction with a row count check.\n', '']]], msgs: ['Correctness and cost checks', 'Add safety rules', 'Query plan check, link data docs'], pub: 2, by: ['u3', 'u3', 'u2'], ago: 45, draftFromHead: (v3) => dr(v3.replace('- Avoid `SELECT *` outside exploration.\n', '- Avoid `SELECT *` outside exploration.\n- Prefer `QUALIFY` over nested subqueries for deduplication.\n').replace('10 GB', '5 GB'), 'u3', 12 * MIN) });
doc('d_sql_q', 'f_sql_s', 'explain-check.sql', 'explain-check.sql', { by: ['u3'], ago: 20 });
folder('f_ssales', 'A_skills', 'sales');
skill('s_disc', 'f_ssales', 'discovery-call');
folder('f_disc_t', 's_disc', 'templates');
skill('s_price', 'f_ssales', 'pricing-objections');
doc('d_disc', 's_disc', 'SKILL.md', 'discovery-call', { back: [[['4. How do you measure success for this project?\n', '']], [['- Write down one hypothesis about their main problem.\n', '']]], msgs: ['First draft', 'Add hypothesis prep', 'Ask about success metrics'], by: ['u6', 'u7', 'u6'], ago: 50 });
doc('d_disc_t', 'f_disc_t', 'call-notes', 'call-notes', { by: ['u6'], ago: 48 });
doc('d_price', 's_price', 'SKILL.md', 'pricing-objections', { msgs: ['First objections'], pub: null, by: ['u7'], ago: 6, draft: dr(SEED['pricing-objections'] + '\n## Competitor is cheaper\n- Compare total cost over 3 years, including migration.\n- Stay inside [[rules/customer-commitments]].\n', 'u7', DAY) });

folder('f_hb', 'A_docs', 'handbook');
folder('f_deng', 'A_docs', 'engineering');
folder('f_svc', 'f_deng', 'services');
folder('f_ddata', 'A_docs', 'data');
folder('f_dsec', 'A_docs', 'security', 0);
folder('f_dsales', 'A_docs', 'sales', 0);
doc('x_onb', 'f_hb', 'onboarding', 'onboarding', { by: ['u2'], ago: 30 });
doc('x_wri', 'f_hb', 'writing-style', 'writing-style', { by: ['u2'], ago: 90 });
doc('x_glo', 'f_hb', 'glossary', 'glossary', { by: ['u1'], ago: 100 });
doc('x_arch', 'f_deng', 'architecture', 'architecture', { back: [[['Every service runs in the three environments in [[documentation/engineering/environments]].\n\n', '']]], msgs: ['Services and boundaries', 'Link environments'], by: ['u2', 'u4'], ago: 120 });
doc('x_env', 'f_deng', 'environments', 'environments', { by: ['u4'], ago: 110 });
doc('x_oc', 'f_deng', 'on-call', 'on-call', { by: ['u4'], ago: 100 });
doc('x_test', 'f_deng', 'testing-strategy', 'testing-strategy', { by: ['u3'], ago: 60 });
doc('x_ff', 'f_deng', 'feature-flags', 'feature-flags', { by: ['u2'], ago: 58 });
doc('x_rb', 'f_deng', 'runbooks', 'runbooks', { by: ['u4'], ago: 15 });
doc('x_auth', 'f_svc', 'auth', 'svc-auth', { by: ['u4'], ago: 95 });
doc('x_bill', 'f_svc', 'billing', 'svc-billing', { by: ['u2'], ago: 95 });
doc('x_wh', 'f_ddata', 'warehouse', 'warehouse', { by: ['u3'], ago: 85 });
doc('x_dbt', 'f_ddata', 'dbt-conventions', 'dbt-conventions', { none: true, pub: null, by: ['u3'], ago: 2, draft: dr(SEED['dbt-conventions'], 'u3', 2 * HR) });
doc('x_pii', 'f_ddata', 'pii-classification', 'pii-classification', { by: ['u3'], ago: 75 });
doc('x_sec', 'f_dsec', 'secrets-policy', 'secrets-policy', { msgs: ['Initial policy'], by: ['u4'], ago: 70 });
doc('x_icp', 'f_dsales', 'icp', 'icp', { by: ['u6'], ago: 60 });
doc('x_price', 'f_dsales', 'pricing-2026', 'pricing-2026', { by: ['u6'], ago: 20 });

const GRANTS = [
  ['A_rules', 'user', 'u2', 3],
  ['f_seng', 'team', 't_eng', 3], ['f_ssec', 'user', 'u4', 4], ['f_ssec', 'team', 't_eng', 1], ['f_sdata', 'team', 't_data', 3], ['f_ssales', 'team', 't_sales', 3], ['f_ssales', 'user', 'u6', 4],
  ['f_hb', 'user', 'u2', 3], ['f_deng', 'team', 't_eng', 3], ['f_ddata', 'team', 't_data', 3], ['f_dsec', 'user', 'u4', 4], ['f_dsec', 'team', 't_eng', 1], ['f_dsales', 'team', 't_sales', 3], ['f_dsales', 'user', 'u6', 4],
];
const ROLE = ['none', 'viewer', 'editor', 'publisher', 'manager'];

function evolve(final, back) {
  const out = [final];
  let c = final;
  for (const step of back) {
    for (const [f, r] of step) {
      if (!c.includes(f)) console.warn('seed miss', f.slice(0, 60));
      c = c.replace(f, r);
    }
    out.unshift(c);
  }
  return out;
}

// ---------- API ----------
const sessions = new Map(); // user key -> token
class ApiError extends Error {
  constructor(status, body) {
    super(`${status} ${JSON.stringify(body)}`);
    this.status = status;
  }
}
async function api(user, method, path, body, form) {
  const headers = { cookie: `__Host-skillhub_session=${sessions.get(user)}`, 'x-skillhub-csrf': '1', origin: ORIGIN };
  const init = { method, headers };
  if (form) init.body = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res = await fetch(BASE + '/api/v1' + path, init);
  for (let i = 0; res.status === 429 && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get('retry-after') ?? 10)));
    res = await fetch(BASE + '/api/v1' + path, init);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}
const enc = encodeURIComponent;

// ---------- run ----------
async function main() {
  try {
    const h = await fetch(BASE + '/healthz');
    if (!h.ok) throw new Error(String(h.status));
  } catch (e) {
    console.error(`No local SkillHub at ${BASE} (${e.message}). Start it with: npx wrangler dev`);
    process.exit(1);
  }

  // users + sessions
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  let sql = '';
  for (const u of USERS) {
    const id = 'DEV' + createHash('sha256').update(u.oid).digest('hex').slice(0, 23).toUpperCase();
    sql += `INSERT INTO users (id, tid, oid, email, name, org_role, status, created_at, last_login_at) VALUES (${q(id)},${q(DEV_TID)},${q(u.oid)},${q(u.email)},${q(u.name)},${q(u.role)},'active',${T0 - 200 * DAY},${u.last})
ON CONFLICT(tid, oid) DO UPDATE SET email = excluded.email, name = excluded.name, org_role = excluded.org_role, status = 'active';\n`;
  }
  d1(sql);
  const rows = d1(`SELECT id, oid FROM users WHERE tid = '${DEV_TID}'`, true);
  const UID = {};
  for (const u of USERS) UID[u.k] = rows.find((r) => r.oid === u.oid)?.id;
  sql = '';
  for (const u of USERS) {
    const token = randomBytes(32).toString('base64url');
    sessions.set(u.k, token);
    sql += `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (${q(sha(token))},${q(UID[u.k])},${T0},${T0 + 8 * HR},${T0});\n`;
  }
  d1(sql);
  const seedStart = Date.now() - 1000;

  const rules = await api('u1', 'GET', `/children?folder=${AREA.A_rules}`);
  if (rules.items.length && !FORCE) {
    console.error('The local stack already has rules. Refusing to seed twice (pass --force to seed anyway, or reset the local state).');
    process.exit(1);
  }

  // teams
  const TID = {};
  for (const t of TEAMS) {
    const r = await api('u1', 'POST', '/teams', { name: t.name, description: t.desc });
    TID[t.k] = r.id;
    for (const [u, role] of t.members) await api('u1', 'PUT', `/teams/${r.id}/members/${UID[u]}`, { role });
  }

  // structure (as Alice)
  const ID = { ...AREA };
  for (const s of S) {
    if (s[0] === 'folder') ID[s[1]] = (await api('u1', 'POST', '/folders', { parent: ID[s[2]], name: s[3] })).id;
    else if (s[0] === 'skill') {
      const r = await api('u1', 'POST', '/skills', { parent: ID[s[2]], name: s[3] });
      ID[s[1]] = r.folder.id;
      ID['md:' + s[1]] = r.skill_md.id;
    }
  }
  // grants and boundaries
  for (const [f, type, p, role] of GRANTS) await api('u1', 'POST', `/folders/${ID[f]}/grants`, { principal_type: type, principal: type === 'user' ? UID[p] : TID[p], role: ROLE[role] });
  for (const s of S) if (s[0] === 'folder' && !s[4]) await api('u1', 'PUT', `/folders/${ID[s[1]]}/inherit`, { inherit: false });

  // documents and histories
  const asUser = async (user, fn) => {
    try {
      return await fn(user);
    } catch (e) {
      if (user !== 'u1' && e instanceof ApiError && (e.status === 403 || e.status === 404)) return fn('u1');
      throw e;
    }
  };
  const putDraft = async (user, id, content) => {
    const cur = await api(user, 'GET', `/docs/${id}/draft`);
    return api(user, 'PUT', `/docs/${id}/draft`, { content, etag: cur.draft?.etag ?? null });
  };
  const timing = []; // [docId, versions[{n, ts}], draftTs, createdTs, pubVersion]
  let assetId = null;
  for (const s of S) {
    if (s[0] !== 'doc') continue;
    const [, k, parent, name, seedKey, o] = s;
    let id;
    if (name === 'SKILL.md' && ID['md:' + parent]) id = ID['md:' + parent];
    else id = (await api('u1', 'POST', '/docs', { parent: ID[parent], name })).node.id;
    ID[k] = id;
    if (!SEED[seedKey]) throw new Error('missing seed text ' + seedKey);
    if (o.asset) {
      const png = readFileSync(new URL('./seed-assets/severity-matrix.png', import.meta.url));
      const form = new FormData();
      form.set('file', new Blob([png], { type: 'image/png' }), 'severity-matrix.png');
      form.set('alt', 'Severity matrix');
      assetId = (await api('u1', 'POST', `/docs/${id}/assets`, undefined, form)).id;
    }
    const fix = (c) => (assetId ? c.split('asset://a-sev').join('asset://' + assetId) : c);
    const contents = o.none ? [] : o.back ? evolve(SEED[seedKey], o.back) : [SEED[seedKey]];
    const n = contents.length;
    const by = o.by || ['u1'];
    const ago = o.ago || 60;
    const versions = [];
    for (let i = 0; i < n; i++) {
      const author = by[i % by.length];
      const msg = (o.msgs || [])[i] || (i ? 'Update' : 'First version');
      const v = await asUser(author, async (u) => {
        await putDraft(u, id, fix(contents[i]));
        return api(u, 'POST', `/docs/${id}/versions`, { message: msg });
      });
      versions.push({ n: v.version, ts: Math.round(T0 - ago * DAY + i * ((ago * DAY * 0.8) / Math.max(n, 1))) });
    }
    const pub = o.pub === undefined ? n || null : o.pub;
    if (pub) await api('u1', 'POST', `/docs/${id}/publish`, { version: pub });
    let draftTs = null;
    const draft = o.draft ?? (o.draftFromHead ? o.draftFromHead(contents[n - 1]) : null);
    if (draft) {
      await asUser(draft.by, (u) => putDraft(u, id, fix(draft.content)));
      draftTs = T0 - draft.ago;
    }
    if (o.dismiss) {
      const w = await api('u1', 'GET', `/nodes/${id}/warnings`);
      for (const code of o.dismiss) for (const x of w.warnings.filter((x) => x.code === code)) await api('u1', 'POST', `/nodes/${id}/warnings/dismiss`, { key: x.key });
    }
    timing.push({ id, versions, draftTs, created: T0 - ago * DAY, pub });
  }

  // backdate
  sql = '';
  const folderIds = S.filter((s) => s[0] !== 'doc').map((s) => ID[s[1]]);
  sql += `UPDATE nodes SET created_at = ${T0 - 200 * DAY}, updated_at = ${T0 - 150 * DAY} WHERE id IN (${folderIds.map(q).join(',')});\n`;
  for (const t of timing) {
    for (const v of t.versions) {
      sql += `UPDATE doc_versions SET created_at = ${v.ts} WHERE doc_id = ${q(t.id)} AND n = ${v.n};\n`;
      sql += `UPDATE audit_log SET ts = ${v.ts} WHERE node_id = ${q(t.id)} AND op = 'commit_version' AND version = ${v.n} AND ts >= ${seedStart};\n`;
    }
    if (t.pub) {
      const pv = t.versions.find((v) => v.n === t.pub);
      if (pv) sql += `UPDATE audit_log SET ts = ${pv.ts + 20 * MIN} WHERE node_id = ${q(t.id)} AND op = 'publish_version' AND ts >= ${seedStart};\n`;
    }
    if (t.draftTs) sql += `UPDATE drafts SET updated_at = ${t.draftTs} WHERE doc_id = ${q(t.id)};\n`;
    const last = Math.max(t.draftTs ?? 0, ...t.versions.map((v) => v.ts), t.created);
    sql += `UPDATE nodes SET created_at = ${t.created}, updated_at = ${last} WHERE id = ${q(t.id)};\n`;
  }
  // Everything else the seed itself did is noise in the audit log.
  sql += `DELETE FROM audit_log WHERE ts >= ${seedStart} AND op NOT IN ('commit_version','publish_version');\n`;
  sql += `UPDATE teams SET created_at = ${T0 - 180 * DAY} WHERE id IN (${Object.values(TID).map(q).join(',')});\n`;
  sql += `UPDATE grants SET created_at = ${T0 - 150 * DAY} WHERE created_at >= ${seedStart};\n`;
  for (const u of USERS) sql += `UPDATE users SET last_login_at = ${u.last}, status = ${q(u.status)} WHERE id = ${q(UID[u.k])};\n`;
  sql += `DELETE FROM sessions WHERE id_hash IN (${[...sessions.values()].map((t) => q(sha(t))).join(',')});\n`;

  // tokens
  sql += `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at, last_used_at, revoked_at, created_at) VALUES
 ('seedtok-ci-sync', ${q(UID.u1)}, 'ci-sync', ${q(sha(randomBytes(32).toString('hex')))}, 'read,write', ${T0 + 50 * DAY}, ${T0 - 2 * HR}, NULL, ${T0 - 40 * DAY}),
 ('seedtok-backstage', ${q(UID.u1)}, 'backstage', ${q(sha(randomBytes(32).toString('hex')))}, 'read', NULL, ${T0 - 5 * DAY}, NULL, ${T0 - 90 * DAY})
 ON CONFLICT(id) DO NOTHING;\n`;

  // synthetic reads and admin events, like the prototype's audit seed
  const rnd = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = rnd(42);
  const run = Date.now().toString(36);
  let an = 0;
  const audit = (ts, actor, via, client, op, node, v, ok, detail) =>
    `(${q(`seed-${run}-${String(++an).padStart(4, '0')}`)},${Math.round(ts)},${q(actor ? UID[actor] : null)},${q(via)},${q(client)},${q(op)},${q(node)},${v ?? 'NULL'},${ok},${q(detail ? JSON.stringify(detail) : null)})`;
  const rowsA = [];
  const published = timing.filter((t) => t.pub);
  const clients = [['mcp', 'Claude'], ['mcp', 'ChatGPT'], ['mcp', 'Copilot Studio'], ['rest', 'ci-sync']];
  const actors = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
  for (let i = 0; i < 70; i++) {
    const d = published[Math.floor(r() * published.length)];
    const c = clients[Math.floor(r() * clients.length)];
    rowsA.push(audit(T0 - r() * 7 * DAY, actors[Math.floor(r() * actors.length)], c[0], c[1], r() < 0.3 ? 'find_skills' : 'get_skill', d.id, d.pub, 1, null));
  }
  rowsA.push(audit(T0 - 3 * HR, 'u2', 'mcp', 'ChatGPT', 'publish_version', ID.d_cr, 4, 0, { error: 'scope_required', scope: 'publish' }));
  rowsA.push(audit(T0 - 2 * DAY, 'u1', 'ui', null, 'set_inherit', ID.f_dsec, null, 1, { inherit: false }));
  rowsA.push(audit(T0 - 2 * DAY + MIN, 'u1', 'ui', null, 'grant_access', ID.f_dsec, null, 1, null));
  rowsA.push(audit(T0 - 9 * DAY + 5 * DAY, 'u1', 'ui', null, 'set_user_status', null, null, 1, { user: UID.u8, status: 'suspended' }));
  rowsA.push(audit(T0 - 12 * MIN, 'u3', 'ui', null, 'update_draft', ID.d_sql, null, 1, null));
  rowsA.push(audit(T0 - 40 * MIN, 'u5', 'mcp', 'Claude', 'get_draft', ID.d_sql, null, 0, { error: 'forbidden' }));
  sql += `INSERT INTO audit_log (id, ts, actor_id, via, client, op, node_id, version, ok, detail) VALUES\n${rowsA.join(',\n')};\n`;
  d1(sql);

  console.log(
    `Seeded ${BASE}: ${USERS.length} users, ${TEAMS.length} teams, ${S.filter((s) => s[0] !== 'doc').length} folders and skills, ${timing.length} documents, ${timing.reduce((a, t) => a + t.versions.length, 0)} versions, ${rowsA.length} audit rows.`,
  );
  console.log('Sign in locally as owner (Alice Chen), publisher (Marcus Webb) or viewer (Tom Becker) on the sign-in page.');
}

try {
  await main();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
