import { $node, $remark, $view, $inputRule, $prose } from '@milkdown/kit/utils';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { ICONS } from '../lib/icon-paths';
import { safeImg } from '../lib/markdown';

/**
 * Milkdown extensions for SkillHub:
 *  - [[canonical links]] as an inline atom node, parsed from and written back to markdown verbatim (no escaping),
 *    rendered as the prototype's chips with a status that follows the server's warnings;
 *  - typing [[path]] turns into a chip; a [[ query opens the autocomplete (state reported to React);
 *  - images keep their markdown src (asset://id) and display through the /a/ proxy.
 */

const WL = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  path?: string;
  label?: string | null;
}

function splitText(v: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of v.matchAll(WL)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', value: v.slice(last, at) });
    out.push({ type: 'wikiLink', path: (m[1] ?? '').trim(), label: m[2] ? m[2].trim() : null });
    last = at + m[0].length;
  }
  if (last < v.length) out.push({ type: 'text', value: v.slice(last) });
  return out;
}

function transform(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const c of node.children) {
    if (c.type === 'text' && typeof c.value === 'string') {
      const prev = next[next.length - 1];
      // Merge adjacent text first so a link split by the parser is still found.
      if (prev && prev.type === 'text') prev.value = (prev.value ?? '') + c.value;
      else next.push({ ...c });
    } else {
      transform(c);
      next.push(c);
    }
  }
  node.children = next.flatMap((c) => (c.type === 'text' && typeof c.value === 'string' && c.value.includes('[[') ? splitText(c.value) : [c]));
}

export const wikiRemark = $remark('wikiLinkRemark', () => {
  return function (this: { data: () => Record<string, unknown[] | undefined> }) {
    const data = this.data();
    const handlers = {
      handlers: {
        wikiLink: (node: MdNode) => `[[${node.path ?? ''}${node.label ? '|' + node.label : ''}]]`,
      },
    };
    data['toMarkdownExtensions'] = [...(data['toMarkdownExtensions'] ?? []), handlers];
    return (tree: MdNode) => transform(tree);
  } as never;
});

export const wikiNode = $node('wikiLink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { path: { default: '' }, label: { default: null } },
  parseDOM: [
    {
      tag: 'span[data-wl]',
      getAttrs: (dom: HTMLElement) => ({ path: dom.getAttribute('data-path') ?? '', label: dom.getAttribute('data-label') }),
    },
  ],
  toDOM: (node: PMNode) => ['span', { 'data-wl': '1', 'data-path': node.attrs['path'] as string, class: 'wl' }, (node.attrs['label'] as string | null) || String(node.attrs['path']).split('/').pop() || ''],
  parseMarkdown: {
    match: (n) => n.type === 'wikiLink',
    runner: (state, n, type) => {
      state.addNode(type, { path: String(n['path'] ?? ''), label: (n['label'] as string | null) ?? null });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikiLink',
    runner: (state, node) => {
      state.addNode('wikiLink', undefined, undefined, { path: node.attrs['path'] as string, label: (node.attrs['label'] as string | null) ?? null });
    },
  },
}));

/** Link status per path, fed from the server's warnings (link-direction, link-broken, link-locked). */
export type WlStatus = 'ok' | 'warn' | 'broken' | 'locked';
export const wlState = { status: new Map<string, WlStatus>(), icons: new Map<string, string>(), views: new Set<() => void>(), rule: '' };

export function setLinkIcons(icons: Map<string, string>): void {
  wlState.icons = icons;
  for (const f of wlState.views) f();
}

export function setLinkStatus(status: Map<string, WlStatus>, rule: string): void {
  wlState.status = status;
  wlState.rule = rule;
  for (const f of wlState.views) f();
}

function svgIcon(name: string, size: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ class: 'i', width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }))
    svg.setAttribute(k, v);
  for (const m of (ICONS[name] ?? '').matchAll(/<(path|circle|rect|line|polyline|polygon)\s+([^>]*?)\/>/g)) {
    const el = document.createElementNS(ns, m[1]!);
    for (const a of (m[2] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) el.setAttribute(a[1]!, a[2]!);
    svg.append(el);
  }
  return svg;
}

const areaClass = (p: string): string => {
  const a = p.split('/')[0];
  return a === 'rules' ? 'a-rules' : a === 'skills' ? 'a-skills' : 'a-docs';
};

export const wikiView = $view(wikiNode, () => (initial) => {
  let node = initial;
  const dom = document.createElement('span');
  dom.setAttribute('contenteditable', 'false');
  const render = (): void => {
    const path = String(node.attrs['path']);
    const label = node.attrs['label'] as string | null;
    const st = wlState.status.get(path) ?? 'ok';
    const tail = path.split('/').pop() ?? path;
    dom.setAttribute('data-wl', '1');
    dom.setAttribute('data-path', path);
    dom.replaceChildren();
    if (st === 'broken') {
      dom.className = 'wl broken';
      dom.setAttribute('data-tip', 'Not found');
      dom.append(svgIcon('link-off', 12));
    } else if (st === 'locked') {
      dom.className = 'wl locked';
      dom.setAttribute('data-tip', 'No access');
      dom.append(svgIcon('lock', 12));
      return;
    } else if (st === 'warn') {
      dom.className = 'wl warn';
      dom.setAttribute('data-tip', wlState.rule);
      dom.append(svgIcon('alert', 12));
    } else {
      dom.className = 'wl ' + areaClass(path);
      dom.setAttribute('data-tip', path);
      dom.append(svgIcon(wlState.icons.get(path) ?? (path.startsWith('skills/') && path.split('/').length === 2 ? 'sparkles' : /\.(sh|py|sql|js|ts|json|ya?ml|toml|txt|csv|ps1)$/i.test(path) ? 'file-code' : 'file'), 12));
    }
    const s = document.createElement('span');
    s.textContent = label || tail;
    dom.append(s);
  };
  render();
  wlState.views.add(render);
  return {
    dom,
    update: (n: PMNode) => {
      if (n.type !== node.type) return false;
      node = n;
      render();
      return true;
    },
    ignoreMutation: () => true,
    destroy: () => {
      wlState.views.delete(render);
    },
  };
});

export const wikiInputRule = $inputRule((ctx) => {
  void ctx;
  return new InputRule(/\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]$/, (state, match, start, end) => {
    const type = state.schema.nodes['wikiLink'];
    if (!type) return null;
    return state.tr.replaceWith(start, end, type.create({ path: (match[1] ?? '').trim(), label: match[2] ? match[2].trim() : null }));
  });
});

/** [[ autocomplete: reports the query and caret rect to React; keys are routed to it while open. */
export interface AcState {
  open: boolean;
  q: string;
  from: number;
  to: number;
  rect: { left: number; top: number; bottom: number } | null;
}
export const acBridge: {
  onChange: (s: AcState) => void;
  onKey: (key: string) => boolean;
  view: EditorView | null;
} = { onChange: () => undefined, onKey: () => false, view: null };

const AC_RE = /\[\[([^[\]|\n]{0,60})$/;

export const acPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('wikiAutocomplete'),
      view: (view) => {
        acBridge.view = view;
        const check = (v: EditorView): void => {
          const sel = v.state.selection;
          if (!sel.empty || !v.hasFocus()) return acBridge.onChange({ open: false, q: '', from: 0, to: 0, rect: null });
          const $from = sel.$from;
          if ($from.parent.type.name === 'code_block') return acBridge.onChange({ open: false, q: '', from: 0, to: 0, rect: null });
          const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 64), $from.parentOffset, undefined, '￼');
          const m = AC_RE.exec(before);
          if (!m) return acBridge.onChange({ open: false, q: '', from: 0, to: 0, rect: null });
          const to = sel.from;
          const from = to - m[0].length;
          const c = v.coordsAtPos(to);
          acBridge.onChange({ open: true, q: m[1] ?? '', from, to, rect: { left: c.left, top: c.top, bottom: c.bottom } });
        };
        check(view);
        return {
          update: (v) => check(v),
          destroy: () => {
            acBridge.view = null;
            acBridge.onChange({ open: false, q: '', from: 0, to: 0, rect: null });
          },
        };
      },
      props: {
        handleKeyDown: (_view, e) => acBridge.onKey(e.key),
      },
    }),
);

/** Insert a link chip in place of the typed [[query. */
export function insertWikiLink(view: EditorView, from: number, to: number, path: string): void {
  const type = view.state.schema.nodes['wikiLink'];
  if (!type) return;
  const tr = view.state.tr.replaceWith(from, to, [type.create({ path, label: null }), view.state.schema.text(' ')]);
  view.dispatch(tr);
  view.focus();
}

/** Images keep src="asset://id" in markdown and display through the asset proxy; anything else shows nothing. */
export const imageView = $view(imageSchema.node, () => (initial) => {
  let node = initial;
  const dom = document.createElement('figure');
  dom.setAttribute('contenteditable', 'false');
  const render = (): void => {
    dom.replaceChildren();
    const src = safeImg(String(node.attrs['src'] ?? ''));
    const alt = String(node.attrs['alt'] ?? '');
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      dom.append(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.append(svgIcon('image', 22));
      dom.append(ph);
    }
    if (alt) {
      const cap = document.createElement('figcaption');
      cap.textContent = alt;
      dom.append(cap);
    }
  };
  render();
  return {
    dom,
    update: (n: PMNode) => {
      if (n.type !== node.type) return false;
      node = n;
      render();
      return true;
    },
    ignoreMutation: () => true,
  };
});
