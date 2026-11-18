// Parity check (SPEC 1.1, 10.3): every operation is a REST endpoint, an MCP tool and a client call.
// The only exceptions are the five UI-only operations. Exits non-zero on any violation.
import { readFileSync } from 'node:fs';
import { generateClient } from './lib/client-gen.mjs';

const { OPS, UI_ONLY_OPS } = await import('../src/registry/index.ts');

const EXPECTED_UI_ONLY = ['login', 'logout', 'mint_api_token', 'revoke_api_token', 'revoke_mcp_connection'];
const SPEC_OPS = [
  'whoami', 'list_children', 'get_node', 'get_skill', 'find_skills', 'search', 'get_asset', 'effective_access',
  'create_folder', 'create_doc', 'rename_node', 'get_draft', 'update_draft', 'discard_draft', 'commit_version', 'list_versions', 'get_version', 'diff_versions', 'upload_asset',
  'publish_version', 'unpublish',
  'list_grants', 'grant_access', 'revoke_access', 'set_inherit', 'move_node', 'delete_node', 'restore_node', 'list_trash',
  'list_users', 'set_user_role', 'set_user_status', 'list_teams', 'create_team', 'rename_team', 'delete_team',
  'list_team_members', 'add_team_member', 'remove_team_member', 'list_team_access', 'list_audit', 'export_tree', 'get_settings',
];

const errors = [];
const fail = (m) => errors.push(m);

if (JSON.stringify([...UI_ONLY_OPS].sort()) !== JSON.stringify([...EXPECTED_UI_ONLY].sort())) fail(`UI-only list must be exactly ${EXPECTED_UI_ONLY.join(', ')}`);

const names = new Set();
const routes = new Set();
const tools = new Set();
for (const op of OPS) {
  if (names.has(op.name)) fail(`duplicate op ${op.name}`);
  names.add(op.name);
  if (UI_ONLY_OPS.includes(op.name)) fail(`${op.name} is UI-only and must not be in the registry`);
  if (!op.rest) fail(`${op.name} has no REST binding`);
  if (!op.mcp) fail(`${op.name} has no MCP binding`);
  if (op.rest) {
    const key = `${op.rest.method} ${op.rest.path}`;
    if (routes.has(key)) fail(`duplicate route ${key}`);
    routes.add(key);
  }
  if (op.mcp) {
    if (tools.has(op.mcp.tool)) fail(`duplicate MCP tool ${op.mcp.tool}`);
    tools.add(op.mcp.tool);
  }
}
for (const s of SPEC_OPS) if (!names.has(s)) fail(`SPEC 10.2 operation missing: ${s}`);

// Generated client must be up to date and cover every op.
let client = '';
try {
  client = readFileSync(new URL('../web/src/api/client.ts', import.meta.url), 'utf8');
} catch {
  fail('web/src/api/client.ts missing: run npm run gen');
}
const fresh = await generateClient();
if (client && client.replace(/\r\n/g, '\n') !== fresh) fail('web/src/api/client.ts is stale: run npm run gen');
for (const op of OPS) if (client && !client.includes(`  ${op.name}: (input`)) fail(`client has no call for ${op.name}`);

// UI-only operations must exist as session-only routes.
const ui = readFileSync(new URL('../src/http/ui.ts', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/auth/routes.ts', import.meta.url), 'utf8');
for (const [op, needle, src] of [
  ['login', "app.get('/auth/login'", auth],
  ['logout', "app.post('/logout'", ui],
  ['mint_api_token', "app.post('/tokens'", ui],
  ['revoke_api_token', "app.delete('/tokens/:id'", ui],
  ['revoke_mcp_connection', "app.delete('/connections/:id'", ui],
]) {
  if (!src.includes(needle)) fail(`UI-only op ${op} has no route`);
}

if (errors.length) {
  console.error('Parity check failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log(`Parity OK: ${OPS.length} operations on REST + MCP + client, ${EXPECTED_UI_ONLY.length} UI-only.`);
