import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import brand from '../../brand.json';
import { flag, type Env } from '../env';
import { Authz, type Actor } from '../authz/authorize';
import { mcpMaxScopes, parseScopes } from '../authz/scopes';
import { getUser } from '../auth/users';
import { AppError } from '../lib/errors';
import { OPS } from '../registry';
import { runOp } from '../registry/run';
import type { AnyOp } from '../registry/types';
import { opSchemas } from '../http/schema';
import { findSkillsDescription } from './catalog';

export interface McpProps {
  userId: string;
  clientName?: string;
}

interface ResourceCtx extends ExecutionContext {
  props: McpProps;
  auth?: { scope: string[]; clientId?: string };
}

const INSTRUCTIONS = `${brand.name} holds your organization's agent skills. Call find_skills with the task at hand, then get_skill to read the best match before acting. Never publish without showing the diff to the human unless told to.`;

/** MCP tools visible to a token: only those whose scope it holds. */
export function visibleOps(scopes: Set<string>): AnyOp[] {
  return OPS.filter((op) => op.mcp && scopes.has(op.scope));
}

function toolResult(value: unknown): { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function toolError(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const err = e instanceof AppError ? e : new AppError('internal', 'Internal error');
  return { content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }], isError: true };
}

export async function buildServer(env: Env, actor: Actor, waitUntil: (p: Promise<unknown>) => void): Promise<Server> {
  const az = new Authz(env.DB, actor);
  const server = new Server(
    { name: brand.name, version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    for (const op of visibleOps(actor.scopes)) {
      let description = op.summary;
      if (op.name === 'find_skills' && flag(env.CATALOG_IN_TOOL_DESC)) description = await findSkillsDescription(env.OAUTH_KV, az, op.summary);
      tools.push({
        name: op.mcp!.tool,
        description,
        inputSchema: opSchemas(op).input as Tool['inputSchema'],
        annotations: { readOnlyHint: op.mcp!.readOnly ?? false, destructiveHint: op.mcp!.destructive ?? false, openWorldHint: false },
      });
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = OPS.find((o) => o.mcp?.tool === req.params.name);
    if (!op) return toolError(new AppError('not_found', `Unknown tool ${req.params.name}`));
    try {
      const out = await runOp(op, req.params.arguments ?? {}, { env, actor, az, waitUntil });
      return toolResult(out);
    } catch (e) {
      return toolError(e);
    }
  });

  return server;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The OAuth-protected /mcp handler. Stateless streamable HTTP: a fresh server per request. */
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rctx = ctx as ResourceCtx;
    const props = rctx.props;
    if (!props?.userId) return jsonError(401, 'unauthenticated', 'Missing grant');
    const user = await getUser(env.DB, props.userId);
    if (!user || user.status !== 'active') return jsonError(403, 'forbidden', 'Account suspended');
    const granted = parseScopes(rctx.auth?.scope ?? []);
    const cap = mcpMaxScopes(env);
    const scopes = new Set([...granted].filter((s) => cap.has(s)));
    const actor: Actor = { user, scopes, via: 'mcp', client: props.clientName ?? rctx.auth?.clientId ?? null };

    if (request.method === 'GET' || request.method === 'DELETE') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    const server = await buildServer(env, actor, (p) => ctx.waitUntil(p));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    ctx.waitUntil(server.close().catch(() => undefined));
    return res;
  },
};
