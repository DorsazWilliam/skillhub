import { Hono } from 'hono';
import type { AppEnv } from './http/context';
import { restApp } from './http/rest';
import { uiApp } from './http/ui';
import { assetApp } from './http/assets';
import { prototypeApp } from './http/prototypes';
import { authApp } from './auth/routes';
import { devApp } from './auth/dev';

/** Everything that is not /mcp and not an OAuth protocol endpoint. */
export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/healthz', (c) => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));
  app.route('/', devApp());
  app.route('/', authApp());
  app.route('/', assetApp());
  app.route('/', prototypeApp());
  app.route('/api/v1/ui', uiApp());
  app.route('/api/v1', restApp());
  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));
  app.all('*', async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });
  return app;
}
