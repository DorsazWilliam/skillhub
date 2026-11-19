import { createElement, type CSSProperties, type ReactElement } from 'react';
import { ICONS } from './icon-paths';

/** Icon geometry parsed once from the static Lucide markup, so icons render as React elements (no innerHTML). */
type Shape = { tag: string; attrs: Record<string, string> };
const SHAPES = new Map<string, Shape[]>();
const ATTR_KEYS: Record<string, string> = { 'stroke-width': 'strokeWidth' };

function parse(markup: string): Shape[] {
  const out: Shape[] = [];
  for (const m of markup.matchAll(/<(path|circle|rect|line|polyline|polygon)\s+([^>]*?)\/>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[ATTR_KEYS[a[1]!] ?? a[1]!] = a[2]!;
    out.push({ tag: m[1]!, attrs });
  }
  return out;
}

function shapes(name: string): Shape[] {
  let s = SHAPES.get(name);
  if (!s) {
    s = parse(ICONS[name] ?? '');
    SHAPES.set(name, s);
  }
  return s;
}

export function Ic({ n, s = 16, c = '', style }: { n: string; s?: number; c?: string; style?: CSSProperties }): ReactElement {
  return (
    <svg
      className={'i' + (c ? ' ' + c : '')}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {shapes(n).map((sh, i) => createElement(sh.tag, { key: i, ...sh.attrs }))}
    </svg>
  );
}

/** Microsoft four-square logo for the sign-in button (brand mark, not an icon font). */
export function MsLogo(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
