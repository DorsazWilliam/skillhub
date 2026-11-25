import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import brand from '../../brand.json';
import type { UserRow } from '../db/d1';
import type { Scope } from '../authz/scopes';

const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SCOPE_TEXT: Record<Scope, string> = {
  read: 'Read published skills',
  write: 'Edit drafts and commit versions',
  publish: 'Publish and unpublish',
  manage: 'Share, move and delete',
  admin: 'Administer users, teams and audit',
};

export interface ConsentScope {
  scope: Scope;
  checked: boolean;
  disabled: boolean;
}

export function consentPage(p: { details: ConsentDescription; handle: string; user: UserRow; scopes: ConsentScope[]; nonce: string }): string {
  const d = p.details;
  const name = esc(d.clientName || 'Unknown app');
  const origin = d.clientDomain ? `<span class="v">${esc(d.clientDomain)}</span>` : '<span class="u">unverified</span>';
  const rows = p.scopes
    .map(
      (s) => `<label class="row${s.disabled ? ' off' : ''}"><input type="checkbox" name="scope" value="${s.scope}"${s.checked ? ' checked' : ''}${s.disabled ? ' disabled' : ''}${s.scope === 'read' ? ' required' : ''}><span><b>${s.scope}</b><i>${esc(SCOPE_TEXT[s.scope])}</i></span></label>`,
    )
    .join('');
  const primary = /^#[0-9a-f]{6}$/i.test(brand.primary) ? brand.primary : '#2563eb';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${name}</title>
<style nonce="${p.nonce}">
:root{--p:${primary};--bg:#fff;--fg:#0f172a;--mu:#64748b;--bd:#e2e8f0;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--fg:#e5e7eb;--mu:#94a3b8;--bd:#1f2937;--card:#111827}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
.c{width:100%;max-width:400px;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:24px}
h1{font-size:18px;margin:0 0 4px}.m{color:var(--mu);font-size:13px;margin:0 0 16px}
.e{margin:0}.v{color:var(--fg);font-weight:600}.u{color:#b45309;font-weight:600}
.w{background:#fef3c7;color:#92400e;border-radius:8px;padding:8px 10px;font-size:12px;margin:0 0 12px}
.who{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--bd);border-radius:10px;margin:0 0 16px}
.av{width:28px;height:28px;border-radius:50%;background:var(--p);color:#fff;display:grid;place-items:center;font-weight:600;font-size:12px}
.row{display:flex;gap:10px;align-items:flex-start;padding:8px 2px;cursor:pointer}.row span{display:flex;flex-direction:column}.row i{font-style:normal;color:var(--mu);font-size:12px}
.row.off{opacity:.45;cursor:not-allowed}input[type=checkbox]{margin-top:3px;accent-color:var(--p);width:16px;height:16px}
.b{display:flex;gap:8px;margin-top:20px}button{flex:1;height:38px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--bd);background:transparent;color:var(--fg)}
button.y{background:var(--p);border-color:var(--p);color:#fff}
</style></head><body>
<form class="c" method="post" action="/authorize">
<h1>Connect ${name}</h1>
<p class="m">${origin} &middot; to ${esc(d.redirectHost)}</p>
${d.redirectIsLoopback ? '<p class="w">Sends access to an app on this computer. Continue only if you just started connecting from it.</p>' : ''}
<div class="who"><div class="av">${esc((p.user.name ?? p.user.email ?? '?').slice(0, 1).toUpperCase())}</div><div><div>${esc(p.user.name ?? '')}</div><div class="m e">${esc(p.user.email ?? '')}</div></div></div>
<input type="hidden" name="handle" value="${esc(p.handle)}">
${rows}
<div class="b"><button type="submit" name="decision" value="deny">Deny</button><button class="y" type="submit" name="decision" value="approve">Allow</button></div>
</form></body></html>`;
}

export function errorPage(message: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(brand.name)}</title>
<style nonce="${nonce}">body{font:14px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;color:#0f172a}@media (prefers-color-scheme:dark){body{background:#0b0f17;color:#e5e7eb}}p{max-width:360px;text-align:center}</style>
</head><body><p>${esc(message)}</p></body></html>`;
}

/** A one-button page that posts a token back (email sign-in links: a click, so mail scanners do not use the link up). */
export function confirmPage(p: { title: string; text: string; action: string; token: string; button: string; nonce: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title)}</title>
<style nonce="${p.nonce}">body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;color:#0f172a;background:#f6f7f9}@media (prefers-color-scheme:dark){body{background:#0a0c10;color:#e6e9ef}}.c{text-align:center;max-width:340px}h1{font-size:20px;margin:0 0 8px}p{color:#64748b;margin:0 0 20px}button{font:600 15px system-ui,sans-serif;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:11px 22px;cursor:pointer}</style></head>
<body><form class="c" method="post" action="${esc(p.action)}"><h1>${esc(p.title)}</h1><p>${esc(p.text)}</p><input type="hidden" name="token" value="${esc(p.token)}"><button type="submit">${esc(p.button)}</button></form></body></html>`;
}
