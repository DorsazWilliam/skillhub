import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { devApp, devLoginEnabled, DEV_TID } from '../src/auth/dev';
import { fetchSelf } from './helpers';

describe('dev login guard', () => {
  it('is off unless DEV_LOGIN is exactly "true"', () => {
    expect(devLoginEnabled({ BASE_URL: 'http://localhost:8787' })).toBe(false);
    expect(devLoginEnabled({ BASE_URL: 'http://localhost:8787', DEV_LOGIN: 'false' })).toBe(false);
    expect(devLoginEnabled({ BASE_URL: 'http://localhost:8787', DEV_LOGIN: '1' })).toBe(false);
  });

  it('is off unless BASE_URL is localhost or 127.0.0.1', () => {
    expect(devLoginEnabled({ BASE_URL: 'https://skills.test', DEV_LOGIN: 'true' })).toBe(false);
    expect(devLoginEnabled({ BASE_URL: 'https://localhost.evil.com', DEV_LOGIN: 'true' })).toBe(false);
    expect(devLoginEnabled({ BASE_URL: 'https://skills.example.com', DEV_LOGIN: 'true' })).toBe(false);
    expect(devLoginEnabled({ BASE_URL: 'not a url', DEV_LOGIN: 'true' })).toBe(false);
  });

  it('is on for localhost with DEV_LOGIN true', () => {
    expect(devLoginEnabled({ BASE_URL: 'http://localhost:8787', DEV_LOGIN: 'true' })).toBe(true);
    expect(devLoginEnabled({ BASE_URL: 'http://127.0.0.1:8787', DEV_LOGIN: 'true' })).toBe(true);
  });

  it('routes answer 404 in the test environment (not localhost, no DEV_LOGIN)', async () => {
    expect((await fetchSelf('/auth/dev-login')).status).toBe(404);
    const post = await fetchSelf('/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-skillhub-csrf': '1', origin: 'https://skills.test' },
      body: JSON.stringify({ as: 'owner' }),
    });
    expect(post.status).toBe(404);
    expect(post.headers.get('set-cookie')).toBeNull();
  });

  it('routes answer 404 for localhost when DEV_LOGIN is not set', async () => {
    const app = devApp();
    const res = await app.request('/auth/dev-login', {}, { ...env, BASE_URL: 'http://localhost:8787', DEV_LOGIN: undefined });
    expect(res.status).toBe(404);
  });

  it('signs in on localhost only with the CSRF header and same origin', async () => {
    const app = devApp();
    const e = { ...env, BASE_URL: 'http://localhost:8787', DEV_LOGIN: 'true' };
    const list = await app.request('/auth/dev-login', {}, e);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { users: { key: string }[] }).users.map((u) => u.key)).toEqual(['owner', 'publisher', 'viewer']);

    const body = JSON.stringify({ as: 'owner' });
    const noCsrf = await app.request('/auth/dev-login', { method: 'POST', headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' }, body }, e);
    expect(noCsrf.status).toBe(403);
    const badOrigin = await app.request(
      '/auth/dev-login',
      { method: 'POST', headers: { origin: 'http://evil.test', 'x-skillhub-csrf': '1', 'content-type': 'application/json' }, body },
      e,
    );
    expect(badOrigin.status).toBe(403);
    const ok = await app.request(
      '/auth/dev-login',
      { method: 'POST', headers: { origin: 'http://localhost:8787', 'x-skillhub-csrf': '1', 'content-type': 'application/json' }, body },
      e,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('__Host-skillhub_session=');
    const row = await env.DB.prepare('SELECT org_role FROM users WHERE tid = ? AND oid = ?').bind(DEV_TID, 'dev-owner').first<{ org_role: string }>();
    expect(row?.org_role).toBe('owner');
  });
});
