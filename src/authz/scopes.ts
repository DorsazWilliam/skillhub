import { csv } from '../env';

export const SCOPES = ['read', 'write', 'publish', 'manage', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];
export const ALL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

export function parseScopes(input: string | string[] | null | undefined): Set<Scope> {
  const list = Array.isArray(input) ? input : (input ?? '').split(/[\s,]+/);
  return new Set(list.filter(isScope));
}

/** Org-wide cap on what MCP can ever be granted. */
export function mcpMaxScopes(env: { MCP_MAX_SCOPES?: string }): Set<Scope> {
  const raw = env.MCP_MAX_SCOPES === undefined ? 'read,write,publish,manage' : env.MCP_MAX_SCOPES;
  return parseScopes(csv(raw));
}

export const DEFAULT_CONSENT: ReadonlySet<Scope> = new Set(['read', 'write']);
