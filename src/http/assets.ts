import { Hono } from 'hono';
import { getAsset } from '../registry/assets';
import { runOp } from '../registry/run';
import { AppError } from '../lib/errors';
import { errorResponse, resolveActor, type AppEnv } from './context';

/** /a/:id streams an image after the same authorize() path as get_asset (viewer + published-only rule). */
export function assetApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/a/:id', async (c) => {
    try {
      const actor = await resolveActor(c);
      if (!actor) throw new AppError('unauthenticated', 'Sign in required');
      const meta = (await runOp(getAsset, { id: c.req.param('id'), include_data: false }, { env: c.env, actor, waitUntil: (p) => c.executionCtx.waitUntil(p) })) as {
        mime: string;
        r2_key?: string;
      };
      if (!meta.r2_key) throw new AppError('not_found', 'Not found');
      const obj = await c.env.BUCKET.get(meta.r2_key);
      if (!obj) throw new AppError('not_found', 'Not found');
      return new Response(obj.body, {
        headers: {
          'content-type': meta.mime,
          'content-disposition': 'inline',
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=300',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    } catch (e) {
      return errorResponse(e);
    }
  });
  return app;
}
