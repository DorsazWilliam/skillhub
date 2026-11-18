import { all, chainIds, qs, type NodeRow, type UserRow } from '../db/d1';
import { AppError } from '../lib/errors';
import type { Via } from '../db/audit';
import type { Scope } from './scopes';
import { roleName } from './roles';

export interface Actor {
  user: UserRow;
  scopes: Set<Scope>;
  via: Via;
  client: string | null;
}

export type Requirement =
  | { scope: Scope; kind: 'node'; minRole: number }
  | { scope: Scope; kind: 'org'; orgRole: 'owner' }
  | { scope: Scope; kind: 'team'; allowMaintainer: boolean }
  | { scope: Scope; kind: 'user' };

const PRINCIPALS_SQL =
  "((g.principal_type = 'user' AND g.principal_id = ?) OR (g.principal_type = 'team' AND (g.principal_id = 'everyone' OR g.principal_id IN (SELECT team_id FROM team_members WHERE user_id = ?))))";

/** D1 allows at most 100 bound parameters per statement. */
const CHUNK = 90;

/**
 * Effective role resolution with a per-request memo. The only place folder permissions are computed.
 * effectiveRole(user, node): nearest-first walk up the folder chain, max grant rank, stop at an inheritance boundary.
 */
export class Authz {
  readonly db: D1Database;
  readonly actor: Actor;
  private memo = new Map<string, number>();

  constructor(db: D1Database, actor: Actor) {
    this.db = db;
    this.actor = actor;
  }

  get isOwner(): boolean {
    return this.actor.user.org_role === 'owner' && this.actor.user.status === 'active';
  }

  /** Forget memoized roles (after grants or the tree change within a request). */
  reset(): void {
    this.memo.clear();
  }

  async role(node: NodeRow): Promise<number> {
    return (await this.roles([node])).get(node.id) ?? 0;
  }

  /** Batch effective roles: two indexed queries per chunk, in one D1 batch. */
  async roles(nodes: NodeRow[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (this.actor.user.status !== 'active') {
      for (const n of nodes) out.set(n.id, 0);
      return out;
    }
    if (this.isOwner) {
      for (const n of nodes) out.set(n.id, 4);
      return out;
    }
    const todo: NodeRow[] = [];
    for (const n of nodes) {
      const m = this.memo.get(n.id);
      if (m !== undefined) out.set(n.id, m);
      else todo.push(n);
    }
    if (todo.length === 0) return out;

    const chains = new Map<string, string[]>();
    const ids = new Set<string>();
    for (const n of todo) {
      const chain = chainIds(n.path);
      const start = n.kind === 'doc' ? chain.slice(0, -1) : chain;
      const nearestFirst = start.reverse();
      chains.set(n.id, nearestFirst);
      for (const id of nearestFirst) ids.add(id);
    }
    const idList = [...ids];
    const inherit = new Map<string, number>();
    const grant = new Map<string, number>();
    for (let i = 0; i < idList.length; i += CHUNK) {
      const part = idList.slice(i, i + CHUNK);
      const [flags, grants] = await this.db.batch([
        this.db.prepare(`SELECT id, inherit FROM nodes WHERE id IN (${qs(part.length)})`).bind(...part),
        this.db
          .prepare(
            `SELECT g.node_id AS node_id, MAX(g.role) AS role FROM grants g WHERE g.node_id IN (${qs(part.length)}) AND ${PRINCIPALS_SQL} GROUP BY g.node_id`,
          )
          .bind(...part, this.actor.user.id, this.actor.user.id),
      ]);
      for (const r of (flags?.results ?? []) as { id: string; inherit: number }[]) inherit.set(r.id, r.inherit);
      for (const r of (grants?.results ?? []) as { node_id: string; role: number }[]) grant.set(r.node_id, r.role);
    }
    for (const n of todo) {
      let role = 0;
      for (const f of chains.get(n.id) ?? []) {
        role = Math.max(role, grant.get(f) ?? 0);
        if ((inherit.get(f) ?? 1) === 0) break;
      }
      // Viewers only ever see published documents: an unpublished doc does not exist for them.
      if (n.kind === 'doc' && role < 2 && n.published_version === null) role = 0;
      this.memo.set(n.id, role);
      out.set(n.id, role);
    }
    return out;
  }

  /** Node ids where the actor's principals hold a direct grant. */
  async grantedNodeIds(): Promise<string[]> {
    const rows = await all<{ node_id: string }>(
      this.db,
      `SELECT DISTINCT g.node_id AS node_id FROM grants g JOIN nodes n ON n.id = g.node_id WHERE n.deleted_at IS NULL AND ${PRINCIPALS_SQL}`,
      this.actor.user.id,
      this.actor.user.id,
    );
    return rows.map((r) => r.node_id);
  }

  async isTeamMaintainer(teamId: string): Promise<boolean> {
    const rows = await all<{ role: string }>(this.db, 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, this.actor.user.id);
    return rows[0]?.role === 'maintainer';
  }

  /**
   * The single authorization decision. Default deny.
   * Unreadable nodes are reported as not_found so their existence is never revealed.
   */
  async authorize(req: Requirement, target?: { node?: NodeRow | null; teamId?: string | null }): Promise<number> {
    const { user, scopes } = this.actor;
    if (user.status !== 'active') throw new AppError('unauthenticated', 'Account suspended');
    // Existence first: an unreadable node is not_found whatever the token scope, so a scope error never confirms it exists.
    const nodeRole = req.kind === 'node' && target?.node ? await this.role(target.node) : null;
    if (nodeRole === 0) throw new AppError('not_found', 'Not found');
    if (!scopes.has(req.scope)) throw new AppError('scope_required', `This action needs the "${req.scope}" scope`, { scope: req.scope });

    switch (req.kind) {
      case 'user':
        return 0;
      case 'org':
        if (!this.isOwner) throw new AppError('forbidden', 'Only owners can do this');
        return 4;
      case 'team': {
        if (this.isOwner) return 4;
        if (req.allowMaintainer && target?.teamId && (await this.isTeamMaintainer(target.teamId))) return 4;
        throw new AppError('forbidden', 'Only owners or team maintainers can do this');
      }
      case 'node': {
        const node = target?.node;
        if (node === null || node === undefined) {
          if (this.isOwner) return 4;
          throw new AppError('forbidden', 'Only owners can change the top level');
        }
        const role = nodeRole ?? (await this.role(node));
        if (role < req.minRole) {
          throw new AppError('forbidden', `This action needs ${roleName(req.minRole)} access`, {
            required: roleName(req.minRole),
            have: roleName(role),
          });
        }
        return role;
      }
    }
  }
}
