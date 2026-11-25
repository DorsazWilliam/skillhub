import { z } from 'zod';
import { all, chainIds, one, qs, stmt, type UserRow } from '../db/d1';
import { AppError, invalid, notFound } from '../lib/errors';
import { ulid } from '../lib/ulid';
import { ROLE, roleName, roleRank } from '../authz/roles';
import { ALL_SCOPES } from '../authz/scopes';
import { Authz } from '../authz/authorize';
import { defineOp } from './types';
import { AccessEnum, NodeRef, RoleEnum, getNodesByIds } from './shared';

const FolderRef = NodeRef.describe('Folder id or path');
const managerReq = { scope: 'manage', kind: 'node', minRole: ROLE.manager } as const;

const GrantOut = z.object({
  id: z.string(),
  principal_type: z.enum(['user', 'team']),
  principal_id: z.string(),
  principal_name: z.string().nullable(),
  principal_email: z.string().nullable(),
  role: RoleEnum,
  inherited_from: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

interface GrantJoin {
  id: string;
  node_id: string;
  principal_type: 'user' | 'team';
  principal_id: string;
  role: number;
  user_name: string | null;
  user_email: string | null;
  team_name: string | null;
}

export async function findUser(db: D1Database, idOrEmail: string): Promise<UserRow | null> {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ? OR lower(email) = lower(?) LIMIT 1', idOrEmail, idOrEmail);
}

export const listGrants = defineOp({
  name: 'list_grants',
  summary: 'List who has access to a folder: direct grants and grants inherited from parent folders.',
  scope: 'manage',
  target: { kind: 'node', field: 'folder', minRole: ROLE.manager, nodeKind: 'folder' },
  input: z.object({ folder: FolderRef }),
  output: z.object({ folder: z.string(), inherit: z.boolean(), grants: z.array(GrantOut) }),
  rest: { method: 'GET', path: '/folders/{folder}/grants' },
  mcp: { tool: 'list_grants', readOnly: true },
  handler: async (ctx) => {
    const folder = ctx.node!;
    const chain = chainIds(folder.path).reverse();
    const chainNodes = await getNodesByIds(ctx.db, chain);
    const byId = new Map(chainNodes.map((n) => [n.id, n]));
    const ids: string[] = [];
    for (const id of chain) {
      ids.push(id);
      if ((byId.get(id)?.inherit ?? 1) === 0) break;
    }
    const rows = await all<GrantJoin>(
      ctx.db,
      `SELECT g.id, g.node_id, g.principal_type, g.principal_id, g.role, u.name AS user_name, u.email AS user_email, t.name AS team_name
       FROM grants g LEFT JOIN users u ON g.principal_type = 'user' AND u.id = g.principal_id
       LEFT JOIN teams t ON g.principal_type = 'team' AND t.id = g.principal_id
       WHERE g.node_id IN (${qs(ids.length)}) ORDER BY g.role DESC, g.created_at`,
      ...ids,
    );
    const ancestorRoles = await ctx.az.roles(chainNodes.filter((n) => n.id !== folder.id));
    return {
      folder: folder.id,
      inherit: folder.inherit === 1,
      grants: rows.map((g) => ({
        id: g.id,
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        principal_name: g.principal_type === 'user' ? g.user_name : g.team_name,
        principal_email: g.principal_type === 'user' ? g.user_email : null,
        role: roleName(g.role) as z.infer<typeof RoleEnum>,
        inherited_from:
          g.node_id === folder.id ? null : { id: g.node_id, name: (ancestorRoles.get(g.node_id) ?? 0) > 0 ? (byId.get(g.node_id)?.name ?? null) : null },
      })),
    };
  },
});

export const grantAccess = defineOp({
  name: 'grant_access',
  summary: 'Give a user or team a role on a folder and everything inside it. Replaces an existing direct grant.',
  scope: 'manage',
  target: { kind: 'node', field: 'folder', minRole: ROLE.manager, nodeKind: 'folder' },
  input: z.object({
    folder: FolderRef,
    principal_type: z.enum(['user', 'team']),
    principal: z.string().min(1).max(320).describe('User id or email, or team id or name. Use "everyone" for all users.'),
    role: RoleEnum,
  }),
  output: GrantOut,
  rest: { method: 'POST', path: '/folders/{folder}/grants' },
  mcp: { tool: 'grant_access' },
  handler: async (ctx, input) => {
    const folder = ctx.node!;
    let principalId: string;
    let name: string | null;
    let email: string | null = null;
    if (input.principal_type === 'user') {
      const u = await findUser(ctx.db, input.principal);
      if (!u) throw notFound('User not found. They need to sign in once before they can be added.');
      principalId = u.id;
      name = u.name;
      email = u.email;
    } else {
      const t = await one<{ id: string; name: string }>(ctx.db, 'SELECT id, name FROM teams WHERE id = ? OR lower(name) = lower(?) LIMIT 1', input.principal, input.principal);
      if (!t) throw notFound('Team not found');
      principalId = t.id;
      name = t.name;
    }
    const rank = roleRank(input.role);
    const id = ulid();
    await stmt(
      ctx.db,
      `INSERT INTO grants (id, node_id, principal_type, principal_id, role, created_by, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(node_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
      id,
      folder.id,
      input.principal_type,
      principalId,
      rank,
      ctx.actor.user.id,
      Date.now(),
    ).run();
    const row = await one<{ id: string }>(ctx.db, 'SELECT id FROM grants WHERE node_id = ? AND principal_type = ? AND principal_id = ?', folder.id, input.principal_type, principalId);
    ctx.audit.detail = { principal_type: input.principal_type, principal_id: principalId, role: input.role };
    return { id: row?.id ?? id, principal_type: input.principal_type, principal_id: principalId, principal_name: name, principal_email: email, role: input.role, inherited_from: null };
  },
});

export const revokeAccess = defineOp({
  name: 'revoke_access',
  summary: 'Remove a direct grant from a folder.',
  scope: 'manage',
  target: { kind: 'node', field: 'folder', minRole: ROLE.manager, nodeKind: 'folder' },
  input: z.object({ folder: FolderRef, principal_type: z.enum(['user', 'team']), principal_id: z.string().min(1) }),
  output: z.object({ revoked: z.boolean() }),
  rest: { method: 'DELETE', path: '/folders/{folder}/grants/{principal_type}/{principal_id}' },
  mcp: { tool: 'revoke_access', destructive: true },
  handler: async (ctx, input) => {
    const res = await stmt(ctx.db, 'DELETE FROM grants WHERE node_id = ? AND principal_type = ? AND principal_id = ?', ctx.node!.id, input.principal_type, input.principal_id).run();
    ctx.audit.detail = { principal_type: input.principal_type, principal_id: input.principal_id };
    return { revoked: (res.meta.changes ?? 0) > 0 };
  },
});

export const setInherit = defineOp({
  name: 'set_inherit',
  summary: 'Turn inheritance from the parent folder on or off. Off makes the folder an access boundary.',
  scope: 'manage',
  target: { kind: 'node', field: 'folder', minRole: ROLE.manager, nodeKind: 'folder' },
  input: z.object({ folder: FolderRef, inherit: z.boolean() }),
  output: z.object({ folder: z.string(), inherit: z.boolean(), added_self_grant: z.boolean() }),
  rest: { method: 'PUT', path: '/folders/{folder}/inherit' },
  mcp: { tool: 'set_inherit' },
  handler: async (ctx, input) => {
    const folder = ctx.node!;
    const stmts = [stmt(ctx.db, 'UPDATE nodes SET inherit = ?, updated_at = ? WHERE id = ?', input.inherit ? 1 : 0, Date.now(), folder.id)];
    let addedSelf = false;
    if (!input.inherit && !ctx.az.isOwner) {
      // Keep the manager who breaks inheritance from locking themselves out.
      const direct = await one<{ r: number }>(
        ctx.db,
        `SELECT MAX(role) AS r FROM grants WHERE node_id = ? AND ((principal_type = 'user' AND principal_id = ?) OR (principal_type = 'team' AND (principal_id = 'everyone' OR principal_id IN (SELECT team_id FROM team_members WHERE user_id = ?))))`,
        folder.id,
        ctx.actor.user.id,
        ctx.actor.user.id,
      );
      if ((direct?.r ?? 0) < ROLE.manager) {
        addedSelf = true;
        stmts.push(
          stmt(
            ctx.db,
            `INSERT INTO grants (id, node_id, principal_type, principal_id, role, created_by, created_at) VALUES (?,?, 'user', ?, 4, ?, ?)
             ON CONFLICT(node_id, principal_type, principal_id) DO UPDATE SET role = 4`,
            ulid(),
            folder.id,
            ctx.actor.user.id,
            ctx.actor.user.id,
            Date.now(),
          ),
        );
      }
    }
    await ctx.db.batch(stmts);
    ctx.audit.detail = { inherit: input.inherit, added_self_grant: addedSelf };
    return { folder: folder.id, inherit: input.inherit, added_self_grant: addedSelf };
  },
});

export const effectiveAccess = defineOp({
  name: 'effective_access',
  summary: 'Explain the effective role on a folder or document, for you or (managers) for another user.',
  scope: 'read',
  target: { kind: 'node', field: 'node', minRole: ROLE.viewer },
  input: z.object({ node: NodeRef, user: z.string().max(320).optional().describe('User id or email. Managers only.') }),
  output: z.object({
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    role: AccessEnum,
    owner: z.boolean(),
    via: z.array(z.object({ folder_id: z.string(), folder_name: z.string(), principal_type: z.enum(['user', 'team']), principal_id: z.string(), role: RoleEnum })),
  }),
  rest: { method: 'GET', path: '/nodes/{node}/access' },
  mcp: { tool: 'effective_access', readOnly: true },
  handler: async (ctx, input) => {
    const node = ctx.node!;
    let subject: UserRow = ctx.actor.user;
    if (input.user && input.user !== ctx.actor.user.id && input.user.toLowerCase() !== (ctx.actor.user.email ?? '').toLowerCase()) {
      await ctx.az.authorize(managerReq, { node });
      const u = await findUser(ctx.db, input.user);
      if (!u) throw notFound('User not found');
      subject = u;
    }
    const az = subject.id === ctx.actor.user.id ? ctx.az : new Authz(ctx.db, { user: subject, scopes: new Set(ALL_SCOPES), via: 'system', client: null });
    const role = await az.role(node);
    const chain = chainIds(node.path);
    const folders = (node.kind === 'doc' ? chain.slice(0, -1) : chain).reverse();
    const chainNodes = await getNodesByIds(ctx.db, folders);
    const byId = new Map(chainNodes.map((n) => [n.id, n]));
    const ids: string[] = [];
    for (const id of folders) {
      ids.push(id);
      if ((byId.get(id)?.inherit ?? 1) === 0) break;
    }
    const via = ids.length
      ? await all<{ node_id: string; principal_type: 'user' | 'team'; principal_id: string; role: number }>(
          ctx.db,
          `SELECT node_id, principal_type, principal_id, role FROM grants WHERE node_id IN (${qs(ids.length)})
           AND ((principal_type = 'user' AND principal_id = ?) OR (principal_type = 'team' AND (principal_id = 'everyone' OR principal_id IN (SELECT team_id FROM team_members WHERE user_id = ?))))`,
          ...ids,
          subject.id,
          subject.id,
        )
      : [];
    if (subject.status !== 'active' && role !== 0) throw new AppError('internal', 'Inconsistent access state');
    if (!input.user && role === 0) throw invalid('No access');
    return {
      user: { id: subject.id, name: subject.name, email: subject.email },
      role: roleName(role),
      owner: subject.org_role === 'owner' && subject.status === 'active',
      via: via.map((g) => ({
        folder_id: g.node_id,
        folder_name: byId.get(g.node_id)?.name ?? '',
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        role: roleName(g.role) as z.infer<typeof RoleEnum>,
      })),
    };
  },
});
