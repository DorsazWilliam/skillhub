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
import { rulesBundle } from '../registry/skills';

export interface McpProps {
  userId: string;
  clientName?: string;
}

interface ResourceCtx extends ExecutionContext {
  props: McpProps;
  auth?: { scope: string[]; clientId?: string };
}

const INSTRUCTIONS = `${brand.name} holds your organization's rules, skills and documentation. The rules below always apply. Before a task, call find_skills with the task at hand, then get_skill to read the best match (it lists the skill's files; read them with get_skill too) and follow its [[links]] into documentation when needed. Never execute a skill's files unless the skill tells you to and the human agrees. Never publish without showing the diff to the human unless told to.`;

/** Base instructions plus the published rules the user can read, capped at 8 KB (SPEC deviation, see DECISIONS). */
export async function instructionsFor(az: Authz): Promise<string> {
  const rules = await rulesBundle(az);
  return rules.text ? `${INSTRUCTIONS}\n\n# Rules\n\n${rules.text}` : INSTRUCTIONS;
}

/** True when the JSON-RPC body (one message or a batch) contains an initialize request. */
async function isInitialize(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.some((m) => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize');
  } catch {
    return false;
  }
}

/** MCP tools visible to a token: only those whose scope it holds. */
export function visibleOps(scopes: Set<string>): AnyOp[] {
  return OPS.filter((op) => op.mcp && scopes.has(op.scope));
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** JSON text plus structured content. An `image_base64` field (render_prototype) is sent as an image block instead. */
export function toolResult(value: unknown): { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean } {
  if (value && typeof value === 'object' && typeof (value as { image_base64?: unknown }).image_base64 === 'string') {
    const { image_base64, ...rest } = value as Record<string, unknown> & { image_base64: string; mime?: string };
    const out = { ...rest, image_base64: null };
    return {
      content: [
        { type: 'image', data: image_base64, mimeType: typeof rest.mime === 'string' ? rest.mime : 'image/png' },
        { type: 'text', text: JSON.stringify(out) },
      ],
      structuredContent: out,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function toolError(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const err = e instanceof AppError ? e : new AppError('internal', 'Internal error');
  return { content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }], isError: true };
}

export async function buildServer(env: Env, actor: Actor, waitUntil: (p: Promise<unknown>) => void, withRules = true): Promise<Server> {
  const az = new Authz(env.DB, actor);
  // Rules are only needed for initialize; other requests skip the query.
  const instructions = withRules ? await instructionsFor(az) : INSTRUCTIONS;
  const server = new Server(
    { name: brand.name, version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } }, instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
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
    const server = await buildServer(env, actor, (p) => ctx.waitUntil(p), await isInitialize(request));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    ctx.waitUntil(server.close().catch(() => undefined));
    return res;
  },
};
