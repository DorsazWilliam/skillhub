import type { z } from 'zod';
import type { Env } from '../env';
import type { Actor, Authz } from '../authz/authorize';
import type { Scope } from '../authz/scopes';
import type { NodeRow } from '../db/d1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TargetSpec =
  /** A node named by an input field (id or path). Absent means the top level when `nullable` (owner: only owners act there; any: anyone may read it). */
  | { kind: 'node'; field: string; minRole: number; nodeKind?: 'doc' | 'folder'; nullable?: 'owner' | 'any'; deleted?: boolean }
  /** Org owners only. */
  | { kind: 'org' }
  /** Owners, or maintainers of the team named by an input field when allowMaintainer. */
  | { kind: 'team'; field: string; allowMaintainer: boolean }
  /** Any active user. Results are filtered through Authz by the handler's queries. */
  | { kind: 'user' };

export interface AuditInfo {
  nodeId?: string | null;
  version?: number | null;
  detail?: Record<string, unknown>;
}

export interface OpContext {
  env: Env;
  db: D1Database;
  az: Authz;
  actor: Actor;
  /** Resolved target for node ops (null = top level). */
  node: NodeRow | null;
  /** The actor's effective role on the target node (0 when not a node op). */
  role: number;
  audit: AuditInfo;
  waitUntil: (p: Promise<unknown>) => void;
}

export interface OpDef<I extends z.ZodObject, O extends z.ZodType> {
  name: string;
  summary: string;
  scope: Scope;
  target: TargetSpec;
  input: I;
  output: O;
  rest?: { method: HttpMethod; path: string; multipart?: boolean };
  mcp?: { tool: string; readOnly?: boolean; destructive?: boolean };
  handler: (ctx: OpContext, input: z.output<I>) => Promise<z.input<O>>;
}

/** Type-erased operation stored in the registry. */
export interface AnyOp {
  name: string;
  summary: string;
  scope: Scope;
  target: TargetSpec;
  input: z.ZodObject;
  output: z.ZodType;
  rest?: { method: HttpMethod; path: string; multipart?: boolean };
  mcp?: { tool: string; readOnly?: boolean; destructive?: boolean };
  handler: (ctx: OpContext, input: Record<string, unknown>) => Promise<unknown>;
}

export function defineOp<I extends z.ZodObject, O extends z.ZodType>(def: OpDef<I, O>): AnyOp {
  // The handler receives input already parsed by `def.input`, so widening its parameter type is sound.
  return def as unknown as AnyOp;
}

/** The complete list of UI-only operations (SPEC 10.3). Enforced by scripts/check-parity.mjs. */
export const UI_ONLY_OPS = ['login', 'logout', 'mint_api_token', 'revoke_api_token', 'revoke_mcp_connection'] as const;
