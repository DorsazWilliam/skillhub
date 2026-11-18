// Interactive first-time setup: npm run setup
// Checks wrangler login, asks for config, writes wrangler.jsonc vars, sets secrets, provisions, migrates, deploys.
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = createInterface({ input, output });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG = new URL('../wrangler.jsonc', import.meta.url);

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', input: opts.input });
}

function tryRun(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

async function ask(q, { def, validate } = {}) {
  for (;;) {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '';
    if (!validate || validate(a)) return a;
    console.log('  Invalid value, try again.');
  }
}

function setString(text, key, value) {
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (!re.test(text)) throw new Error(`wrangler.jsonc has no "${key}"`);
  return text.replace(re, `$1${JSON.stringify(value)}`);
}

console.log('SkillHub setup\n');
const who = tryRun('npx wrangler whoami');
if (!who.ok || /not authenticated/i.test(who.out)) {
  console.log('You are not logged in to Cloudflare. Running `wrangler login`...');
  run('npx wrangler login');
}

const host = await ask('Hostname for this hub (a subdomain of a zone on your Cloudflare account)', {
  def: 'skills.example.com',
  validate: (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v),
});
const base = `https://${host}`;
const tenant = await ask('Entra tenant id (GUID)', { validate: (v) => GUID.test(v) });
const clientId = await ask('Entra application (client) id (GUID)', { validate: (v) => GUID.test(v) });
const owner = await ask('Owner email(s), comma separated', { validate: (v) => v.includes('@') });
const domains = await ask('Restrict to email domains (optional, comma separated)', { def: '' });
const secret = await ask('Entra client secret value', { validate: (v) => v.length > 8 });

let cfg = readFileSync(CONFIG, 'utf8');
cfg = cfg.replace(/("pattern"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(host)}`);
cfg = setString(cfg, 'BASE_URL', base);
cfg = setString(cfg, 'ENTRA_TENANT_ID', tenant);
cfg = setString(cfg, 'ENTRA_CLIENT_ID', clientId);
cfg = setString(cfg, 'OWNER_EMAILS', owner);
cfg = setString(cfg, 'ALLOWED_EMAIL_DOMAINS', domains);
writeFileSync(CONFIG, cfg);
console.log('\nUpdated wrangler.jsonc');

console.log('\nBuilding web assets...');
run('npm run build');

// Wrangler 4.45+ provisions D1, R2 and KV for bindings without ids on deploy. Deploy once to provision,
// fall back to explicit creation if that fails.
let deployed = tryRun('npx wrangler deploy');
if (!deployed.ok) {
  console.log(deployed.out);
  console.log('\nAutomatic provisioning failed. Creating resources explicitly...');
  const d1 = tryRun('npx wrangler d1 create skillhub');
  const id = /"database_id":\s*"([^"]+)"/.exec(d1.out)?.[1] ?? /database_id\s*=\s*"([^"]+)"/.exec(d1.out)?.[1];
  if (id) cfg = cfg.replace(/("database_name"\s*:\s*"skillhub")/, `$1, "database_id": ${JSON.stringify(id)}`);
  tryRun('npx wrangler r2 bucket create skillhub-assets');
  const kv = tryRun('npx wrangler kv namespace create OAUTH_KV');
  const kvId = /"id":\s*"([^"]+)"/.exec(kv.out)?.[1] ?? /id\s*=\s*"([^"]+)"/.exec(kv.out)?.[1];
  if (kvId) cfg = cfg.replace(/\{\s*"binding"\s*:\s*"OAUTH_KV"\s*\}/, `{ "binding": "OAUTH_KV", "id": ${JSON.stringify(kvId)} }`);
  writeFileSync(CONFIG, cfg);
  run('npx wrangler deploy');
}

run('npx wrangler secret put ENTRA_CLIENT_SECRET', { input: secret + '\n' });
run('npx wrangler secret put SESSION_SECRET', { input: randomBytes(32).toString('hex') + '\n' });
run('npx wrangler d1 migrations apply DB --remote');
run('npx wrangler deploy');

console.log(`
Done.

Entra redirect URI (Authentication > Web):   ${base}/auth/callback
Sign in:                                     ${base}
MCP connector URL (Claude, ChatGPT, Copilot): ${base}/mcp
`);
rl.close();
