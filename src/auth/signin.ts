import { all, one, stmt, type UserRow } from '../db/d1';
import { auditStmt } from '../db/audit';
import { csv, type Env } from '../env';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ulid';
import { invitesEnabled, type Identity } from './providers';

/**
 * Who gets in. Every provider produces an Identity; this decides:
 * - known user (same tid, oid): signs in if active;
 * - new member (the provider says they belong to the organization): account created, owner if in OWNER_EMAILS;
 * - anyone else: only with a pending invitation for that verified email. They become an external user, never an owner.
 * Pending invitations for the user's email are applied at every sign-in.
 */

export interface InvitationRow {
  id: string;
  email: string;
  token_hash: string;
  access: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  revoked_at: number | null;
}

export interface InviteAccess {
  grants: { node: string; role: number }[];
  teams: string[];
}

export async function pendingInvites(db: D1Database, email: string | null, now = Date.now()): Promise<InvitationRow[]> {
  if (!email) return [];
  return all<InvitationRow>(
    db,
    'SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at',
    email.toLowerCase(),
    now,
  );
}

/** Grants and team memberships from invitations, marked accepted, in one batch. */
async function applyInvites(env: Env, user: UserRow, invites: InvitationRow[]): Promise<void> {
  if (!invites.length) return;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const inv of invites) {
    let access: InviteAccess;
    try {
      access = JSON.parse(inv.access) as InviteAccess;
    } catch {
      access = { grants: [], teams: [] };
    }
    for (const g of access.grants ?? []) {
      stmts.push(
        stmt(
          env.DB,
          `INSERT INTO grants (id, node_id, principal_type, principal_id, role, created_by, created_at) VALUES (?,?,'user',?,?,?,?)
           ON CONFLICT(node_id, principal_type, principal_id) DO UPDATE SET role = CASE WHEN excluded.role > grants.role THEN excluded.role ELSE grants.role END`,
          ulid(),
          g.node,
          user.id,
          g.role,
          inv.invited_by,
          now,
        ),
      );
    }
    for (const t of access.teams ?? []) {
      stmts.push(
        stmt(env.DB, "INSERT INTO team_members (team_id, user_id, role, added_by, created_at) VALUES (?,?, 'member', ?,?) ON CONFLICT(team_id, user_id) DO NOTHING", t, user.id, inv.invited_by, now),
      );
    }
    stmts.push(stmt(env.DB, 'UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL', now, user.id, inv.id));
    stmts.push(auditStmt(env.DB, { actorId: user.id, via: 'ui', client: null, op: 'accept_invitation', nodeId: null, version: null, ok: true, detail: { invitation: inv.id, invited_by: inv.invited_by } }));
  }
  await env.DB.batch(stmts);
}

export interface SignInOpts {
  /** Hash of the invitation token the person arrived with: it must be pending and for this email. */
  inviteHash?: string | null;
}

export async function signIn(env: Env, id: Identity, opts: SignInOpts = {}): Promise<UserRow> {
  const now = Date.now();
  const email = id.email?.toLowerCase() ?? null;
  const invites = invitesEnabled(env) ? await pendingInvites(env.DB, email, now) : [];
  if (opts.inviteHash) {
    const inv = await one<InvitationRow>(env.DB, 'SELECT * FROM invitations WHERE token_hash = ?', opts.inviteHash);
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= now) throw new AppError('forbidden', 'invite_used');
    if (!email || inv.email !== email) throw new AppError('forbidden', 'invite_mismatch');
  }

  const existing = await one<UserRow>(env.DB, 'SELECT * FROM users WHERE tid = ? AND oid = ?', id.tid, id.oid);
  if (existing) {
    if (existing.status !== 'active') throw new AppError('forbidden', 'Your account is suspended');
    await stmt(env.DB, 'UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?', email, id.name ?? existing.name, now, existing.id).run();
    const user = { ...existing, email, name: id.name ?? existing.name, last_login_at: now };
    await applyInvites(env, user, invites);
    return user;
  }

  if (!id.member && !invites.length) throw new AppError('forbidden', 'not_allowed');
  const owners = csv(env.OWNER_EMAILS).map((e) => e.toLowerCase());
  const user: UserRow = {
    id: ulid(),
    tid: id.tid,
    oid: id.oid,
    email,
    name: id.name,
    org_role: id.member && email && owners.includes(email) ? 'owner' : 'member',
    status: 'active',
    created_at: now,
    last_login_at: now,
    is_external: id.member ? 0 : 1,
  };
  await stmt(
    env.DB,
    'INSERT INTO users (id, tid, oid, email, name, org_role, status, created_at, last_login_at, is_external) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tid, oid) DO NOTHING',
    user.id,
    user.tid,
    user.oid,
    user.email,
    user.name,
    user.org_role,
    user.status,
    user.created_at,
    user.last_login_at,
    user.is_external,
  ).run();
  const saved = (await one<UserRow>(env.DB, 'SELECT * FROM users WHERE tid = ? AND oid = ?', id.tid, id.oid)) ?? user;
  await applyInvites(env, saved, invites);
  return saved;
}
