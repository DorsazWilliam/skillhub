import { z } from 'zod';
import { all, one, stmt } from '../db/d1';
import { AppError, invalid, notFound } from '../lib/errors';
import { randomToken, sha256Hex } from '../lib/crypto';
import { ulid } from '../lib/ulid';
import { ROLE } from '../authz/roles';
import { invitesEnabled } from '../auth/providers';
import { emailConfigured, inviteMail, sendMail } from '../auth/email';
import type { InvitationRow, InviteAccess } from '../auth/signin';
import { defineOp } from './types';
import { NodeRef, RoleEnum, getNodesByIds, resolveRef } from './shared';

/**
 * Invitations: access for an email address, applied when that person signs in (with any enabled method).
 * People from outside the organization get in only this way, as external users (never owners).
 * Off with ALLOW_INVITES=false.
 */

const DAY = 86400 * 1000;
const TTL = 14 * DAY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_N = { viewer: ROLE.viewer, editor: ROLE.editor, publisher: ROLE.publisher, manager: ROLE.manager } as const;
const ROLE_NAME = ['', 'viewer', 'editor', 'publisher', 'manager'] as const;

const InviteOut = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invited_by: z.string(),
  inviter_name: z.string().nullable(),
  created_at: z.number(),
  expires_at: z.number(),
  accepted_at: z.number().nullable(),
  access: z.array(z.object({ folder: z.string(), name: z.string().nullable(), role: RoleEnum })),
  teams: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
});

function statusOf(i: InvitationRow, now = Date.now()): 'pending' | 'accepted' | 'revoked' | 'expired' {
  return i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : i.expires_at <= now ? 'expired' : 'pending';
}

export const createInvitation = defineOp({
  name: 'create_invitation',
  summary:
    'Invite someone by email, with access attached: folder roles (you must manage each folder) and teams (owner or team maintainer). They get it when they sign in, with any enabled method. Returns the link; it is emailed when email is configured.',
  scope: 'manage',
  target: { kind: 'user' },
  input: z.object({
    email: z.string().min(3).max(254),
    access: z.array(z.object({ folder: NodeRef, role: RoleEnum })).max(20).default([]),
    teams: z.array(z.string().min(1).max(64)).max(10).default([]),
    send: z.boolean().default(true).describe('Email the invitation when email is configured'),
  }),
  output: z.object({ id: z.string(), email: z.string(), link: z.string(), expires_at: z.number(), emailed: z.boolean() }),
  rest: { method: 'POST', path: '/invitations' },
  mcp: { tool: 'create_invitation' },
  handler: async (ctx, input) => {
    if (!invitesEnabled(ctx.env)) throw invalid('Invitations are turned off on this hub');
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw invalid('Enter an email address');
    if (!input.access.length && !input.teams.length) throw invalid('Give access to at least one folder or team');
    const grants: InviteAccess['grants'] = [];
    for (const a of input.access) {
      const node = await resolveRef(ctx.az, a.folder);
      if (!node || node.kind !== 'folder') throw new AppError('not_found', `Folder not found: ${a.folder}`);
      await ctx.az.authorize({ scope: 'manage', kind: 'node', minRole: ROLE.manager }, { node });
      grants.push({ node: node.id, role: ROLE_N[a.role] });
    }
    for (const t of input.teams) {
      if (t === 'everyone') throw invalid('Everyone is not a team you can invite to');
      await ctx.az.authorize({ scope: 'manage', kind: 'team', allowMaintainer: true }, { node: null, teamId: t });
      if (!(await one(ctx.db, 'SELECT id FROM teams WHERE id = ?', t))) throw new AppError('not_found', `Team not found: ${t}`);
    }
    const token = randomToken(32);
    const now = Date.now();
    const id = ulid();
    const access: InviteAccess = { grants, teams: input.teams };
    await stmt(
      ctx.db,
      'INSERT INTO invitations (id, email, token_hash, access, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      id,
      email,
      await sha256Hex(token),
      JSON.stringify(access),
      ctx.actor.user.id,
      now,
      now + TTL,
    ).run();
    const link = `${ctx.env.BASE_URL}/login?invite=${token}`;
    let emailed = false;
    if (input.send && emailConfigured(ctx.env)) {
      const names = (await getNodesByIds(ctx.db, grants.map((g) => g.node))).map((n) => n.name);
      const what = names.length ? `access to ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and more' : ''}` : '';
      try {
        await sendMail(ctx.env, inviteMail(email, ctx.actor.user.name ?? ctx.actor.user.email ?? 'Someone', what, link));
        emailed = true;
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'invitation email failed', err: String(e) }));
      }
    }
    ctx.audit.detail = { invitation: id, email, grants: grants.length, teams: input.teams.length, emailed };
    return { id, email, link, expires_at: now + TTL, emailed };
  },
});

export const listInvitations = defineOp({
  name: 'list_invitations',
  summary: 'Invitations you sent (owners see all), newest first, with their status and the access they carry.',
  scope: 'manage',
  target: { kind: 'user' },
  input: z.object({ status: z.enum(['pending', 'all']).default('all') }),
  output: z.object({ items: z.array(InviteOut) }),
  rest: { method: 'GET', path: '/invitations' },
  mcp: { tool: 'list_invitations', readOnly: true },
  handler: async (ctx, input) => {
    const rows = ctx.az.isOwner
      ? await all<InvitationRow & { inviter_name: string | null }>(
          ctx.db,
          'SELECT i.*, u.name AS inviter_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC LIMIT 200',
        )
      : await all<InvitationRow & { inviter_name: string | null }>(
          ctx.db,
          'SELECT i.*, u.name AS inviter_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by WHERE i.invited_by = ? ORDER BY i.created_at DESC LIMIT 200',
          ctx.actor.user.id,
        );
    const now = Date.now();
    const shown = rows.filter((r) => input.status === 'all' || statusOf(r, now) === 'pending');
    const parsed = shown.map((r) => {
      try {
        return JSON.parse(r.access) as InviteAccess;
      } catch {
        return { grants: [], teams: [] };
      }
    });
    const nodes = new Map((await getNodesByIds(ctx.db, [...new Set(parsed.flatMap((p) => p.grants.map((g) => g.node)))])).map((n) => [n.id, n.name]));
    const teamIds = [...new Set(parsed.flatMap((p) => p.teams))];
    const teams = new Map<string, string>();
    for (const t of teamIds) {
      const row = await one<{ name: string }>(ctx.db, 'SELECT name FROM teams WHERE id = ?', t);
      if (row) teams.set(t, row.name);
    }
    return {
      items: shown.map((r, i) => ({
        id: r.id,
        email: r.email,
        status: statusOf(r, now),
        invited_by: r.invited_by,
        inviter_name: r.inviter_name,
        created_at: r.created_at,
        expires_at: r.expires_at,
        accepted_at: r.accepted_at,
        access: parsed[i]!.grants.map((g) => ({ folder: g.node, name: nodes.get(g.node) ?? null, role: ROLE_NAME[g.role] as z.infer<typeof RoleEnum> })),
        teams: parsed[i]!.teams.map((t) => ({ id: t, name: teams.get(t) ?? null })),
      })),
    };
  },
});

export const revokeInvitation = defineOp({
  name: 'revoke_invitation',
  summary: 'Cancel a pending invitation: its link stops working. Access already granted by an accepted invitation stays (remove it from sharing).',
  scope: 'manage',
  target: { kind: 'user' },
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ id: z.string(), revoked: z.boolean() }),
  rest: { method: 'DELETE', path: '/invitations/{id}' },
  mcp: { tool: 'revoke_invitation', destructive: true },
  handler: async (ctx, input) => {
    const inv = await one<InvitationRow>(ctx.db, 'SELECT * FROM invitations WHERE id = ?', input.id);
    if (!inv || (!ctx.az.isOwner && inv.invited_by !== ctx.actor.user.id)) throw notFound();
    if (statusOf(inv) !== 'pending') return { id: inv.id, revoked: false };
    await stmt(ctx.db, 'UPDATE invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL', Date.now(), inv.id).run();
    ctx.audit.detail = { invitation: inv.id, email: inv.email };
    return { id: inv.id, revoked: true };
  },
});
