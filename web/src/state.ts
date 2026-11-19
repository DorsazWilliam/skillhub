import { useSyncExternalStore } from 'react';

/** Tiny global UI store (the prototype's S), read with useUI(selector). Server data lives in React Query. */

export type DrawerTab = 'links' | 'history' | 'access' | 'activity';
export type Viewing = number | 'draft' | null;

export interface MenuState {
  type: string;
  id: string;
  x?: number;
  y?: number;
  right?: number;
}

export type Modal =
  | { type: 'palette'; q: string; i: number }
  | { type: 'commit'; id: string; msg: string; pub: boolean }
  | { type: 'publish'; id: string; v: number }
  | { type: 'diff'; id: string; a: number | 'draft'; b: number | 'draft' }
  | { type: 'skill-publish'; id: string; open: string | null }
  | { type: 'share'; id: string }
  | { type: 'move'; id: string; dest: string | null }
  | { type: 'export' }
  | { type: 'mint' }
  | { type: 'reveal'; name: string; token: string }
  | { type: 'rename'; id: string }
  | { type: 'new'; parent: string; kind: 'doc' | 'folder' | 'skill' }
  | { type: 'csv'; csv: string; n: number }
  | { type: 'conflict'; id: string; theirs: string | null; by: string | null };

export interface UIState {
  open: Set<string>;
  drawer: DrawerTab | null;
  viewing: Viewing;
  editing: string | null;
  menu: MenuState | null;
  modal: Modal | null;
  renaming: string | null;
  mTree: boolean;
  q: string;
  searchOpen: boolean;
  sIdx: number;
  recent: string[];
  det: 'm' | 'l';
  theme: 'light' | 'dark' | null;
  dragging: string | null;
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function initialTheme(): 'light' | 'dark' | null {
  const t = store.get('sh-theme');
  return t === 'dark' || t === 'light' ? t : null;
}

function initialRecent(): string[] {
  try {
    const v: unknown = JSON.parse(store.get('sh-recent') ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

const wideMQ = typeof window !== 'undefined' ? window.matchMedia('(min-width:1280px)') : null;
export const isWide = (): boolean => !!wideMQ?.matches;

let state: UIState = {
  open: new Set(),
  drawer: isWide() ? 'links' : null,
  viewing: null,
  editing: null,
  menu: null,
  modal: null,
  renaming: null,
  mTree: false,
  q: '',
  searchOpen: false,
  sIdx: 0,
  recent: initialRecent(),
  det: 'l',
  theme: initialTheme(),
  dragging: null,
};

const subs = new Set<() => void>();

export function getUI(): UIState {
  return state;
}

export function setUI(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.theme !== undefined) {
    if (p.theme) store.set('sh-theme', p.theme);
    applyTheme();
  }
  if (p.recent) store.set('sh-recent', JSON.stringify(p.recent));
  for (const f of subs) f();
}

export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => sel(state),
  );
}

export function applyTheme(): void {
  const t = state.theme;
  if (t) document.documentElement.dataset['theme'] = t;
  else delete document.documentElement.dataset['theme'];
}

export function isDark(): boolean {
  const t = state.theme;
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function toggleTheme(): void {
  setUI({ theme: isDark() ? 'light' : 'dark', menu: null });
}

export function toggleOpen(id: string, force?: boolean): void {
  setUI((s) => {
    const open = new Set(s.open);
    const on = force ?? !open.has(id);
    if (on) open.add(id);
    else open.delete(id);
    return { open };
  });
}

export function openMany(ids: string[]): void {
  setUI((s) => {
    if (ids.every((i) => s.open.has(i))) return {};
    const open = new Set(s.open);
    for (const i of ids) open.add(i);
    return { open };
  });
}

export function pushRecent(id: string): void {
  setUI((s) => (s.recent[0] === id ? {} : { recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 8) }));
}

/** Position a desktop popover menu next to the element that opened it (prototype openMenu). */
export function openMenu(type: string, el: Element | null, id: string, at?: { x: number; y: number }): void {
  const W = window.innerWidth;
  const m: MenuState = { type, id };
  if (at) {
    m.x = Math.min(at.x, W - 240);
    m.y = Math.min(at.y, window.innerHeight - 300);
  } else if (el) {
    const r = el.getBoundingClientRect();
    if (r.left > W / 2) m.right = Math.max(8, W - r.right);
    else m.x = r.left;
    m.y = r.bottom + 6;
  }
  const cur = state.menu;
  const justClosed = lastClosed && lastClosed.type === type && lastClosed.id === id && Date.now() - lastClosed.at < 400;
  if ((cur && cur.type === type && cur.id === id) || justClosed) setUI({ menu: null });
  else setUI({ menu: m });
  lastClosed = null;
}

let lastClosed: { type: string; id: string; at: number } | null = null;

/** Outside click closes the open menu; a click on the same trigger right after must not reopen it. */
export function closeMenuFromOutside(): void {
  const m = state.menu;
  if (!m) return;
  lastClosed = { type: m.type, id: m.id, at: Date.now() };
  setUI({ menu: null });
}
