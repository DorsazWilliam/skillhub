import { z } from 'zod';
import { all } from '../db/d1';
import brand from '../../brand.json';
import { defineOp } from './types';

export const whoami = defineOp({
  name: 'whoami',
  summary: 'Who you are, your org role, teams, and the scopes this session or token carries.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({}),
  output: z.object({
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), org_role: z.enum(['owner', 'member']), external: z.boolean() }),
    teams: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['member', 'maintainer']) })),
    scopes: z.array(z.string()),
    via: z.string(),
    client: z.string().nullable(),
    brand: z.record(z.string(), z.unknown()),
    mcp_url: z.string(),
  }),
  rest: { method: 'GET', path: '/me' },
  mcp: { tool: 'whoami', readOnly: true },
  handler: async (ctx) => {
    const u = ctx.actor.user;
    const teams = await all<{ id: string; name: string; role: 'member' | 'maintainer' }>(
      ctx.db,
      'SELECT t.id, t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name',
      u.id,
    );
    return {
      user: { id: u.id, name: u.name, email: u.email, org_role: u.org_role, external: u.is_external === 1 },
      teams: [{ id: 'everyone', name: 'everyone', role: 'member' as const }, ...teams],
      scopes: [...ctx.actor.scopes],
      via: ctx.actor.via,
      client: ctx.actor.client,
      brand: brand as Record<string, unknown>,
      mcp_url: `${ctx.env.BASE_URL}/mcp`,
    };
  },
});

export const listApiTokens = defineOp({
  name: 'list_api_tokens',
  summary: 'List your personal access tokens (metadata only, never the secret).',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        scopes: z.array(z.string()),
        created_at: z.number(),
        expires_at: z.number().nullable(),
        last_used_at: z.number().nullable(),
        revoked_at: z.number().nullable(),
      }),
    ),
  }),
  rest: { method: 'GET', path: '/tokens' },
  mcp: { tool: 'list_api_tokens', readOnly: true },
  handler: async (ctx) => {
    const rows = await all<{ id: string; name: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null }>(
      ctx.db,
      'SELECT id, name, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
      ctx.actor.user.id,
    );
    return { items: rows.map((r) => ({ ...r, scopes: r.scopes.split(',').filter(Boolean) })) };
  },
});

const ConnOut = z.object({
  id: z.string(),
  client_id: z.string(),
  client_name: z.string().nullable(),
  client_uri: z.string().nullable(),
  scopes: z.array(z.string()),
  created_at: z.number(),
  expires_at: z.number().nullable(),
});

export const listMcpConnections = defineOp({
  name: 'list_mcp_connections',
  summary: 'List the MCP clients (Claude, ChatGPT, Copilot...) you have connected, with their scopes.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({}),
  output: z.object({ items: z.array(ConnOut) }),
  rest: { method: 'GET', path: '/connections' },
  mcp: { tool: 'list_mcp_connections', readOnly: true },
  handler: async (ctx) => {
    const helpers = ctx.env.OAUTH_PROVIDER;
    if (!helpers) return { items: [] };
    const items: z.infer<typeof ConnOut>[] = [];
    let cursor: string | undefined;
    do {
      const page = await helpers.listUserGrants(ctx.actor.user.id, cursor ? { cursor, limit: 100 } : { limit: 100 });
      for (const g of page.items) {
        let name: string | null = null;
        let uri: string | null = null;
        try {
          const c = await helpers.lookupClient(g.clientId);
          name = c?.clientName ?? null;
          uri = c?.clientUri ?? null;
        } catch {
          name = null;
        }
        items.push({ id: g.id, client_id: g.clientId, client_name: name, client_uri: uri, scopes: g.scope, created_at: g.createdAt, expires_at: g.expiresAt ?? null });
      }
      cursor = page.cursor;
    } while (cursor);
    return { items };
  },
});
