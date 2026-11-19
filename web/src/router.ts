import { useSyncExternalStore } from 'react';

/** Deep-linkable routes. Every page has a URL; transient state (menus, sheets, the viewed version) does not. */
export type Route =
  | { name: 'home' }
  | { name: 'node'; id: string }
  | { name: 'graph'; focus: string | null }
  | { name: 'search'; q: string }
  | { name: 'people' }
  | { name: 'teams' }
  | { name: 'team'; id: string }
  | { name: 'audit' }
  | { name: 'tokens' }
  | { name: 'connections' }
  | { name: 'trash' }
  | { name: 'account' }
  | { name: 'login'; error: string | null }
  | { name: 'notfound' };

export function parse(pathname: string, search: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(search);
  let m: RegExpExecArray | null;
  if (p === '/') return { name: 'home' };
  if ((m = /^\/n\/(.+)$/.exec(p))) return { name: 'node', id: decodeURIComponent(m[1]!) };
  if (p === '/graph') return { name: 'graph', focus: q.get('focus') };
  if (p === '/search') return { name: 'search', q: q.get('q') ?? '' };
  if (p === '/people') return { name: 'people' };
  if (p === '/teams') return { name: 'teams' };
  if ((m = /^\/teams\/([^/]+)$/.exec(p))) return { name: 'team', id: decodeURIComponent(m[1]!) };
  if (p === '/audit') return { name: 'audit' };
  if (p === '/settings/tokens') return { name: 'tokens' };
  if (p === '/settings/connections') return { name: 'connections' };
  if (p === '/trash') return { name: 'trash' };
  if (p === '/account') return { name: 'account' };
  if (p === '/login') return { name: 'login', error: q.get('error') };
  return { name: 'notfound' };
}

export function href(r: Route): string {
  switch (r.name) {
    case 'home':
      return '/';
    case 'node':
      return '/n/' + r.id.split('/').map(encodeURIComponent).join('/');
    case 'graph':
      return r.focus ? '/graph?focus=' + encodeURIComponent(r.focus) : '/graph';
    case 'search':
      return r.q ? '/search?q=' + encodeURIComponent(r.q) : '/search';
    case 'team':
      return '/teams/' + encodeURIComponent(r.id);
    case 'tokens':
      return '/settings/tokens';
    case 'connections':
      return '/settings/connections';
    case 'login':
      return '/login';
    case 'notfound':
      return '/';
    default:
      return '/' + r.name;
  }
}

const subs = new Set<() => void>();
let current = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
let cached: Route = parse(window.location.pathname, window.location.search);

function sync(): void {
  const now = window.location.pathname + window.location.search;
  if (now === current) return;
  current = now;
  cached = parse(window.location.pathname, window.location.search);
  for (const f of subs) f();
}

window.addEventListener('popstate', sync);

export function navigate(to: string | Route, opts: { replace?: boolean } = {}): void {
  const url = typeof to === 'string' ? to : href(to);
  if (url === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  sync();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cached,
  );
}

export function currentRoute(): Route {
  return cached;
}
