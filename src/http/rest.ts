import { Hono } from 'hono';
import { OPS } from '../registry';
import { runOp } from '../registry/run';
import { AppError } from '../lib/errors';
import { toBase64 } from '../lib/crypto';
import { LIMITS } from '../lib/limits';
import type { AnyOp } from '../registry/types';
import { checkCsrf, errorResponse, resolveActor, type AppEnv, type Ctx } from './context';
import { openapi } from './openapi';
import { coerceQuery, pathParams } from './schema';

async function readInput(c: Ctx, op: AnyOp): Promise<Record<string, unknown>> {
  const rest = op.rest!;
  const rawParams: Record<string, string> = {};
  for (const name of pathParams(rest.path)) {
    const v = c.req.param(name);
    if (v !== undefined) rawParams[name] = v;
  }
  const params = coerceQuery(op, rawParams);
  if (rest.method === 'GET' || rest.method === 'DELETE') {
    return { ...coerceQuery(op, c.req.query()), ...params };
  }
  const type = c.req.header('content-type') ?? '';
  if (rest.multipart && type.startsWith('multipart/form-data')) {
    const len = Number(c.req.header('content-length') ?? '0');
    if (len > LIMITS.imageBytes + 64 * 1024) throw new AppError('invalid', 'Upload is larger than 5 MB');
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new AppError('invalid', 'Missing "file"');
    if (file.size > LIMITS.imageBytes) throw new AppError('invalid', 'Image is larger than 5 MB');
    const alt = form.get('alt');
    return { data_base64: toBase64(new Uint8Array(await file.arrayBuffer())), ...(typeof alt === 'string' ? { alt } : {}), ...params };
  }
  let body: unknown = {};
  const text = await c.req.text();
  if (text.length > LIMITS.docBytes * 2 + 4096 && !rest.multipart) throw new AppError('invalid', 'Request body too large');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppError('invalid', 'Body must be JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid', 'Body must be a JSON object');
  return { ...(body as Record<string, unknown>), ...params };
}

/** REST surface generated from the registry. */
export function restApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/openapi.json', (c) => c.json(openapi(c.env.BASE_URL)));

  for (const op of OPS) {
    if (!op.rest) continue;
    const route = op.rest.path.replace(/\{(\w+)\}/g, ':$1');
    app.on(op.rest.method, route, async (c) => {
      try {
        const actor = await resolveActor(c);
        if (!actor) throw new AppError('unauthenticated', 'Sign in required');
        checkCsrf(c, actor);
        const input = await readInput(c, op);
        const out = await runOp(op, input, { env: c.env, actor, waitUntil: (p) => c.executionCtx.waitUntil(p) });
        return c.json(out as object, 200, { 'cache-control': 'no-store' });
      } catch (e) {
        return errorResponse(e);
      }
    });
  }
  return app;
}
