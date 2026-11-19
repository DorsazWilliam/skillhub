import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { all, chainIds, one, qs, stmt, type NodeRow, type UserRow } from '../db/d1';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { ulid } from '../lib/ulid';
import { toBase64 } from '../lib/crypto';
import { EXT, type ImageMime } from '../lib/sniff';
import { assetIds } from '../lib/markdown';
import { csv, flag } from '../env';
import { mcpMaxScopes } from '../authz/scopes';
import { roleName } from '../authz/roles';
import brand from '../../brand.json';
import { defineOp } from './types';
import { Cursor, Limit, RoleEnum, decodeCursor, encodeCursor, getNodesByIds, nodeOuts, NodeOut } from './shared';
import { findUser } from './access';
import { isUnique } from './nodes';

const UserRef = z.string().min(1).max(320).describe('User id or email');
const TeamRef = z.string().min(1).max(120).describe('Team id');

const UserOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  org_role: z.enum(['owner', 'member']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  last_login_at: z.number().nullable().optional(),
  created_at: z.number().optional(),
  teams: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

async function mustUser(db: D1Database, ref: string): Promise<UserRow> {
  const u = await findUser(db, ref);
  if (!u) throw notFound('User not found');
  return u;
}

async function mustTeam(db: D1Database, id: string): Promise<{ id: string; name: string; description: string | null }> {
  const t = await one<{ id: string; name: string; description: string | null }>(db, 'SELECT id, name, description FROM teams WHERE id = ?', id);
  if (!t) throw notFound('Team not found');
  return t;
}

async function activeOwnerCount(db: D1Database): Promise<number> {
  return (await one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM users WHERE org_role = 'owner' AND status = 'active'"))?.c ?? 0;
}

// ---------- users ----------

export const listUsers = defineOp({
  name: 'list_users',
  summary: 'List people in the organization. Owners also see role, status, teams and last login.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ q: z.string().max(120).optional(), cursor: Cursor, limit: Limit }),
  output: z.object({ items: z.array(UserOut), next_cursor: z.string().nullable() }),
  rest: { method: 'GET', path: '/users' },
  mcp: { tool: 'list_users', readOnly: true },
  handler: async (ctx, input) => {
    const limit = input.limit ?? 50;
    const after = decodeCursor(input.cursor);
    const like = input.q ? '%' + input.q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null;
    const rows = await all<UserRow>(
      ctx.db,
      `SELECT * FROM users WHERE (? IS NULL OR lower(coalesce(name,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(email,'')) LIKE ? ESCAPE '\\')
       AND (? IS NULL OR (lower(coalesce(name,'')), id) > (?, ?))
       ${ctx.az.isOwner ? '' : "AND status = 'active'"}
       ORDER BY lower(coalesce(name,'')), id LIMIT ?`,
      like,
      like,
      like,
      after ? 1 : null,
      after?.[0] ?? '',
      after?.[1] ?? '',
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? encodeCursor([(last.name ?? '').toLowerCase(), last.id]) : null;
    if (!ctx.az.isOwner) return { items: page.map((u) => ({ id: u.id, name: u.name, email: u.email })), next_cursor: next };
    const ids = page.map((u) => u.id);
    const teams = ids.length
      ? await all<{ user_id: string; id: string; name: string }>(
          ctx.db,
          `SELECT m.user_id, t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id IN (${qs(ids.length)}) ORDER BY t.name`,
          ...ids,
        )
      : [];
    return {
      items: page.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        org_role: u.org_role,
        status: u.status,
        last_login_at: u.last_login_at,
        created_at: u.created_at,
        teams: teams.filter((t) => t.user_id === u.id).map((t) => ({ id: t.id, name: t.name })),
      })),
      next_cursor: next,
    };
  },
});

export const setUserRole = defineOp({
  name: 'set_user_role',
  summary: 'Make a user an owner or a member.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ user: UserRef, role: z.enum(['owner', 'member']) }),
  output: UserOut,
  rest: { method: 'PUT', path: '/users/{user}/role' },
  mcp: { tool: 'set_user_role' },
  handler: async (ctx, input) => {
    const u = await mustUser(ctx.db, input.user);
    if (u.org_role === 'owner' && input.role === 'member' && u.status === 'active' && (await activeOwnerCount(ctx.db)) <= 1) {
      throw invalid('There must be at least one active owner');
    }
    await stmt(ctx.db, 'UPDATE users SET org_role = ? WHERE id = ?', input.role, u.id).run();
    ctx.audit.detail = { user: u.id, from: u.org_role, to: input.role };
    return { id: u.id, name: u.name, email: u.email, org_role: input.role, status: u.status };
  },
});

export const setUserStatus = defineOp({
  name: 'set_user_status',
  summary: 'Suspend or reactivate a user. Suspension takes effect on their next request.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ user: UserRef, status: z.enum(['active', 'suspended']) }),
  output: UserOut,
  rest: { method: 'PUT', path: '/users/{user}/status' },
  mcp: { tool: 'set_user_status', destructive: true },
  handler: async (ctx, input) => {
    const u = await mustUser(ctx.db, input.user);
    if (input.status === 'suspended') {
      if (u.id === ctx.actor.user.id) throw invalid('You cannot suspend yourself');
      if (u.org_role === 'owner' && u.status === 'active' && (await activeOwnerCount(ctx.db)) <= 1) throw invalid('There must be at least one active owner');
    }
    await ctx.db.batch([
      stmt(ctx.db, 'UPDATE users SET status = ? WHERE id = ?', input.status, u.id),
      ...(input.status === 'suspended' ? [stmt(ctx.db, 'DELETE FROM sessions WHERE user_id = ?', u.id)] : []),
    ]);
    ctx.audit.detail = { user: u.id, status: input.status };
    return { id: u.id, name: u.name, email: u.email, org_role: u.org_role, status: input.status };
  },
});

// ---------- teams ----------

const TeamOut = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), member_count: z.number(), builtin: z.boolean() });

export const listTeams = defineOp({
  name: 'list_teams',
  summary: 'List teams with member counts.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ q: z.string().max(120).optional() }),
  output: z.object({ items: z.array(TeamOut) }),
  rest: { method: 'GET', path: '/teams' },
  mcp: { tool: 'list_teams', readOnly: true },
  handler: async (ctx, input) => {
    const like = input.q ? '%' + input.q.toLowerCase() + '%' : '%';
    const rows = await all<{ id: string; name: string; description: string | null; c: number }>(
      ctx.db,
      `SELECT t.id, t.name, t.description, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS c FROM teams t WHERE lower(t.name) LIKE ? ORDER BY t.id = 'everyone' DESC, lower(t.name) LIMIT 500`,
      like,
    );
    const active = (await one<{ c: number }>(ctx.db, "SELECT COUNT(*) AS c FROM users WHERE status = 'active'"))?.c ?? 0;
    return {
      items: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, member_count: t.id === 'everyone' ? active : t.c, builtin: t.id === 'everyone' })),
    };
  },
});

export const createTeam = defineOp({
  name: 'create_team',
  summary: 'Create a team.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() }),
  output: TeamOut,
  rest: { method: 'POST', path: '/teams' },
  mcp: { tool: 'create_team' },
  handler: async (ctx, input) => {
    const id = ulid();
    const name = input.name.trim();
    if (name.toLowerCase() === 'everyone') throw invalid('"everyone" is reserved');
    try {
      await stmt(ctx.db, 'INSERT INTO teams (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)', id, name, input.description ?? null, ctx.actor.user.id, Date.now()).run();
    } catch (e) {
      if (isUnique(e)) throw conflict('A team with that name exists');
      throw e;
    }
    ctx.audit.detail = { team: id, name };
    return { id, name, description: input.description ?? null, member_count: 0, builtin: false };
  },
});

export const renameTeam = defineOp({
  name: 'rename_team',
  summary: 'Rename a team or change its description.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ team: TeamRef, name: z.string().min(1).max(80).optional(), description: z.string().max(500).nullable().optional() }),
  output: TeamOut,
  rest: { method: 'PATCH', path: '/teams/{team}' },
  mcp: { tool: 'rename_team' },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    if (t.id === 'everyone') throw invalid('The everyone team cannot be changed');
    const name = input.name?.trim() ?? t.name;
    if (name.toLowerCase() === 'everyone') throw invalid('"everyone" is reserved');
    const description = input.description === undefined ? t.description : input.description;
    try {
      await stmt(ctx.db, 'UPDATE teams SET name = ?, description = ? WHERE id = ?', name, description, t.id).run();
    } catch (e) {
      if (isUnique(e)) throw conflict('A team with that name exists');
      throw e;
    }
    const c = (await one<{ c: number }>(ctx.db, 'SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?', t.id))?.c ?? 0;
    ctx.audit.detail = { team: t.id, from: t.name, to: name };
    return { id: t.id, name, description, member_count: c, builtin: false };
  },
});

export const deleteTeam = defineOp({
  name: 'delete_team',
  summary: 'Delete a team and every grant it holds.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({ team: TeamRef }),
  output: z.object({ deleted: z.boolean(), grants_removed: z.number() }),
  rest: { method: 'DELETE', path: '/teams/{team}' },
  mcp: { tool: 'delete_team', destructive: true },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    if (t.id === 'everyone') throw invalid('The everyone team cannot be deleted');
    const res = await ctx.db.batch([
      stmt(ctx.db, "DELETE FROM grants WHERE principal_type = 'team' AND principal_id = ?", t.id),
      stmt(ctx.db, 'DELETE FROM team_members WHERE team_id = ?', t.id),
      stmt(ctx.db, 'DELETE FROM teams WHERE id = ?', t.id),
    ]);
    ctx.audit.detail = { team: t.id, name: t.name };
    return { deleted: true, grants_removed: res[0]?.meta.changes ?? 0 };
  },
});

const MemberOut = z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), role: z.enum(['member', 'maintainer']) });

export const listTeamMembers = defineOp({
  name: 'list_team_members',
  summary: 'List the members of a team.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ team: TeamRef, cursor: Cursor, limit: Limit }),
  output: z.object({ team: TeamOut.omit({ member_count: true }), items: z.array(MemberOut), next_cursor: z.string().nullable() }),
  rest: { method: 'GET', path: '/teams/{team}/members' },
  mcp: { tool: 'list_team_members', readOnly: true },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    const limit = input.limit ?? 50;
    const after = decodeCursor(input.cursor);
    const everyone = t.id === 'everyone';
    const rows = await all<{ id: string; name: string | null; email: string | null; role: 'member' | 'maintainer' }>(
      ctx.db,
      everyone
        ? `SELECT u.id, u.name, u.email, 'member' AS role FROM users u WHERE u.status = 'active' AND (? IS NULL OR (lower(coalesce(u.name,'')), u.id) > (?, ?)) ORDER BY lower(coalesce(u.name,'')), u.id LIMIT ?`
        : `SELECT u.id, u.name, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND (? IS NULL OR (lower(coalesce(u.name,'')), u.id) > (?, ?)) ORDER BY lower(coalesce(u.name,'')), u.id LIMIT ?`,
      ...(everyone ? [] : [t.id]),
      after ? 1 : null,
      after?.[0] ?? '',
      after?.[1] ?? '',
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      team: { id: t.id, name: t.name, description: t.description, builtin: everyone },
      items: page,
      next_cursor: rows.length > limit && last ? encodeCursor([(last.name ?? '').toLowerCase(), last.id]) : null,
    };
  },
});

export const addTeamMember = defineOp({
  name: 'add_team_member',
  summary: 'Add a user to a team, or change their team role. Owners and team maintainers.',
  scope: 'admin',
  target: { kind: 'team', field: 'team', allowMaintainer: true },
  input: z.object({ team: TeamRef, user: UserRef, role: z.enum(['member', 'maintainer']).default('member') }),
  output: MemberOut,
  rest: { method: 'PUT', path: '/teams/{team}/members/{user}' },
  mcp: { tool: 'add_team_member' },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    if (t.id === 'everyone') throw invalid('Everyone is a member of the everyone team');
    const u = await mustUser(ctx.db, input.user);
    await stmt(
      ctx.db,
      `INSERT INTO team_members (team_id, user_id, role, added_by, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
      t.id,
      u.id,
      input.role,
      ctx.actor.user.id,
      Date.now(),
    ).run();
    ctx.audit.detail = { team: t.id, user: u.id, role: input.role };
    return { id: u.id, name: u.name, email: u.email, role: input.role };
  },
});

export const removeTeamMember = defineOp({
  name: 'remove_team_member',
  summary: 'Remove a user from a team. Owners and team maintainers.',
  scope: 'admin',
  target: { kind: 'team', field: 'team', allowMaintainer: true },
  input: z.object({ team: TeamRef, user: UserRef }),
  output: z.object({ removed: z.boolean() }),
  rest: { method: 'DELETE', path: '/teams/{team}/members/{user}' },
  mcp: { tool: 'remove_team_member', destructive: true },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    const u = await mustUser(ctx.db, input.user);
    const res = await stmt(ctx.db, 'DELETE FROM team_members WHERE team_id = ? AND user_id = ?', t.id, u.id).run();
    ctx.audit.detail = { team: t.id, user: u.id };
    return { removed: (res.meta.changes ?? 0) > 0 };
  },
});

export const listTeamAccess = defineOp({
  name: 'list_team_access',
  summary: 'Folders a team has been granted access to (reverse lookup). Only folders you can read are listed.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ team: TeamRef }),
  output: z.object({ items: z.array(z.object({ folder: NodeOut, role: RoleEnum })) }),
  rest: { method: 'GET', path: '/teams/{team}/access' },
  mcp: { tool: 'list_team_access', readOnly: true },
  handler: async (ctx, input) => {
    const t = await mustTeam(ctx.db, input.team);
    const grants = await all<{ node_id: string; role: number }>(ctx.db, "SELECT node_id, role FROM grants WHERE principal_type = 'team' AND principal_id = ?", t.id);
    const nodes = (await getNodesByIds(ctx.db, grants.map((g) => g.node_id))).filter((n) => n.deleted_at === null);
    const roles = await ctx.az.roles(nodes);
    const readable = nodes.filter((n) => (roles.get(n.id) ?? 0) > 0);
    const outs = await nodeOuts(ctx.az, readable, roles);
    const gr = new Map(grants.map((g) => [g.node_id, g.role]));
    return { items: outs.map((o) => ({ folder: o, role: roleName(gr.get(o.id) ?? 1) as z.infer<typeof RoleEnum> })) };
  },
});

// ---------- audit, export, settings ----------

const AuditRowOut = z.object({
  id: z.string(),
  ts: z.number(),
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable(),
  via: z.enum(['ui', 'rest', 'mcp', 'system']),
  client: z.string().nullable(),
  op: z.string(),
  node_id: z.string().nullable(),
  node_name: z.string().nullable(),
  version: z.number().nullable(),
  ok: z.boolean(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});

export const listAudit = defineOp({
  name: 'list_audit',
  summary: 'Read the last 7 days of the audit log with filters, newest first. Older rows are archived to R2 under audit/.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({
    actor: z.string().max(64).optional(),
    op: z.string().max(64).optional(),
    node: z.string().max(64).optional(),
    via: z.enum(['ui', 'rest', 'mcp', 'system']).optional(),
    from: z.number().int().optional().describe('Epoch ms, inclusive'),
    to: z.number().int().optional().describe('Epoch ms, exclusive'),
    cursor: Cursor,
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({ items: z.array(AuditRowOut), next_cursor: z.string().nullable() }),
  rest: { method: 'GET', path: '/audit' },
  mcp: { tool: 'list_audit', readOnly: true },
  handler: async (ctx, input) => {
    const limit = input.limit ?? 100;
    const after = decodeCursor(input.cursor);
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.actor) (where.push('a.actor_id = ?'), params.push(input.actor));
    if (input.op) (where.push('a.op = ?'), params.push(input.op));
    if (input.node) (where.push('a.node_id = ?'), params.push(input.node));
    if (input.via) (where.push('a.via = ?'), params.push(input.via));
    if (input.from !== undefined) (where.push('a.ts >= ?'), params.push(input.from));
    if (input.to !== undefined) (where.push('a.ts < ?'), params.push(input.to));
    if (after) (where.push('(a.ts, a.id) < (?, ?)'), params.push(after[0], after[1]));
    const rows = await all<{
      id: string;
      ts: number;
      actor_id: string | null;
      actor_name: string | null;
      via: 'ui' | 'rest' | 'mcp' | 'system';
      client: string | null;
      op: string;
      node_id: string | null;
      node_name: string | null;
      version: number | null;
      ok: number;
      detail: string | null;
    }>(
      ctx.db,
      `SELECT a.*, u.name AS actor_name, n.name AS node_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN nodes n ON n.id = a.node_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.ts DESC, a.id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ ...r, ok: r.ok === 1, detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null })),
      next_cursor: rows.length > limit && last ? encodeCursor([last.ts, last.id]) : null,
    };
  },
});

export const exportTree = defineOp({
  name: 'export_tree',
  summary: 'Export every published document as a zip of markdown files with relative image links.',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({}),
  output: z.object({ filename: z.string(), bytes: z.number(), documents: z.number(), zip_base64: z.string() }),
  rest: { method: 'POST', path: '/export' },
  mcp: { tool: 'export_tree', readOnly: true },
  handler: async (ctx) => {
    const nodes = await all<NodeRow>(ctx.db, 'SELECT * FROM nodes WHERE deleted_at IS NULL');
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const docs = nodes.filter((n) => n.kind === 'doc' && n.published_version !== null);
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    const usedAssets = new Set<string>();
    for (const d of docs) {
      const v = await one<{ content: string }>(ctx.db, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', d.id, d.published_version);
      if (!v) continue;
      const segs = chainIds(d.path).map((id) => byId.get(id)?.name ?? id);
      const depth = segs.length - 1;
      const prefix = '../'.repeat(depth);
      const ids = assetIds(v.content);
      const assetRows = ids.length ? await all<{ id: string; mime: string }>(ctx.db, `SELECT id, mime FROM assets WHERE id IN (${qs(ids.length)})`, ...ids) : [];
      let content = v.content;
      for (const a of assetRows) {
        const ext = EXT[a.mime as ImageMime] ?? 'bin';
        content = content.split(`asset://${a.id}`).join(`${prefix}_assets/${a.id}.${ext}`);
        usedAssets.add(`${a.id}.${ext}`);
      }
      const bytes = strToU8(content);
      total += bytes.length;
      files[segs.map((s) => s.replace(/[\\:*?"<>|]/g, '_')).join('/') + '.md'] = bytes;
    }
    for (const name of usedAssets) {
      const id = name.split('.')[0]!;
      const obj = await ctx.env.BUCKET.get(`assets/${id}`);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      total += bytes.length;
      if (total > 50 * 1024 * 1024) throw new AppError('invalid', 'Export is larger than 50 MB');
      files[`_assets/${name}`] = bytes;
    }
    const zip = zipSync(files, { level: 6 });
    ctx.audit.detail = { documents: docs.length, bytes: zip.length };
    const date = new Date().toISOString().slice(0, 10);
    return { filename: `${brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-export-${date}.zip`, bytes: zip.length, documents: docs.length, zip_base64: toBase64(zip) };
  },
});

export const getSettings = defineOp({
  name: 'get_settings',
  summary: 'Read the instance configuration (no secrets).',
  scope: 'admin',
  target: { kind: 'org' },
  input: z.object({}),
  output: z.object({
    brand: z.record(z.string(), z.unknown()),
    base_url: z.string(),
    mcp_url: z.string(),
    tenants: z.array(z.string()),
    allowed_email_domains: z.array(z.string()),
    allow_guests: z.boolean(),
    mcp_max_scopes: z.array(z.string()),
    catalog_in_tool_desc: z.boolean(),
  }),
  rest: { method: 'GET', path: '/settings' },
  mcp: { tool: 'get_settings', readOnly: true },
  handler: async (ctx) => {
    const env = ctx.env;
    const tenants = csv(env.ENTRA_ALLOWED_TENANTS).length ? csv(env.ENTRA_ALLOWED_TENANTS) : [env.ENTRA_TENANT_ID];
    return {
      brand: brand as Record<string, unknown>,
      base_url: env.BASE_URL,
      mcp_url: `${env.BASE_URL}/mcp`,
      tenants,
      allowed_email_domains: csv(env.ALLOWED_EMAIL_DOMAINS),
      allow_guests: flag(env.ALLOW_GUESTS),
      mcp_max_scopes: [...mcpMaxScopes(env)],
      catalog_in_tool_desc: flag(env.CATALOG_IN_TOOL_DESC),
    };
  },
});
