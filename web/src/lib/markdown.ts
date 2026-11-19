/**
 * Markdown to a safe render tree. This module is the only place markdown is interpreted for display.
 *
 * Safety model: the output is plain data (no HTML strings). Raw HTML in the source is never interpreted, it is kept
 * as visible text. Links survive only for http, https, mailto and same-origin app paths; everything else
 * (javascript:, data:, vbscript:, protocol-relative, unknown schemes) becomes plain text. Images survive only when they
 * point at our asset proxy (asset://<id> or /a/<id>); anything else renders as an empty placeholder.
 * [[canonical links]] become link chips whose status comes from the API, matched by index.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, PhrasingContent, RootContent, Table } from 'mdast';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'link'; href: string; internal: boolean; c: Inline[] }
  | { t: 'img'; src: string | null; alt: string }
  | { t: 'wl'; path: string; label: string | null; idx: number };

export type Block =
  | { t: 'h'; depth: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number | null; items: { checked: boolean | null; c: Block[] }[] }
  | { t: 'pre'; v: string; lang: string | null }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'table'; align: ('left' | 'right' | 'center' | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'figure'; src: string | null; alt: string };

export const WL = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
const ASSET_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** Distinct [[link]] paths in order of first appearance: the same indexing the API uses for `links[]`. */
export function linkIndex(md: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of stripCode(md).matchAll(WL)) {
    const p = (m[1] ?? '').trim();
    if (p && !out.has(p)) out.set(p, out.size);
  }
  return out;
}

/** Returns a safe href, or null when the link must be dropped. Internal app paths are returned as-is. */
export function safeHref(raw: string): { href: string; internal: boolean } | null {
  // Remove whitespace and control characters that browsers ignore inside a scheme ("java\tscript:").
  const href = raw.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!href) return null;
  if (/^\/(?![/\\])/.test(href)) return { href, internal: true };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!scheme) return null;
  const s = scheme[1]!.toLowerCase();
  if (s === 'http' || s === 'https') {
    if (!/^https?:\/\/[^/\\]/i.test(href)) return null;
    return { href, internal: false };
  }
  if (s === 'mailto') return { href, internal: false };
  return null;
}

/** Images only from our asset proxy. */
export function safeImg(raw: string): string | null {
  const u = raw.trim();
  let m = /^asset:\/\/([^/?#]+)$/.exec(u);
  if (m && ASSET_ID.test(m[1]!)) return '/a/' + m[1];
  m = /^\/a\/([^/?#]+)$/.exec(u);
  if (m && ASSET_ID.test(m[1]!)) return '/a/' + m[1];
  return null;
}

function splitWikiLinks(v: string, index: Map<string, number>): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of v.matchAll(WL)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', v: v.slice(last, at) });
    const path = (m[1] ?? '').trim();
    out.push({ t: 'wl', path, label: m[2] ? m[2].trim() : null, idx: index.get(path) ?? -1 });
    last = at + m[0].length;
  }
  if (last < v.length) out.push({ t: 'text', v: v.slice(last) });
  return out;
}

function textOf(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  if ('children' in n) return (n.children as Nodes[]).map(textOf).join('');
  return '';
}

function inlines(nodes: PhrasingContent[], index: Map<string, number>): Inline[] {
  const out: Inline[] = [];
  // Adjacent text nodes are merged first so a [[link]] split by the parser is still recognised.
  let buf = '';
  const flush = (): void => {
    if (buf) out.push(...splitWikiLinks(buf, index));
    buf = '';
  };
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        buf += n.value;
        continue;
      case 'html':
        // Raw HTML is shown as text, never interpreted.
        buf += n.value;
        continue;
    }
    flush();
    switch (n.type) {
      case 'strong':
        out.push({ t: 'strong', c: inlines(n.children, index) });
        break;
      case 'emphasis':
        out.push({ t: 'em', c: inlines(n.children, index) });
        break;
      case 'delete':
        out.push({ t: 'del', c: inlines(n.children, index) });
        break;
      case 'inlineCode':
        out.push({ t: 'code', v: n.value });
        break;
      case 'break':
        out.push({ t: 'br' });
        break;
      case 'link': {
        const kids = inlines(n.children, index);
        const safe = safeHref(n.url);
        if (safe) out.push({ t: 'link', href: safe.href, internal: safe.internal, c: kids });
        else out.push(...kids);
        break;
      }
      case 'image':
        out.push({ t: 'img', src: safeImg(n.url), alt: n.alt ?? '' });
        break;
      case 'linkReference':
      case 'footnoteReference':
        out.push({ t: 'text', v: textOf(n) });
        break;
      case 'imageReference':
        out.push({ t: 'text', v: n.alt ?? '' });
        break;
      default:
        out.push({ t: 'text', v: textOf(n as Nodes) });
    }
  }
  flush();
  return out;
}

function tableBlock(n: Table, index: Map<string, number>): Block {
  const rows = n.children.map((r) => r.children.map((c) => inlines(c.children, index)));
  return { t: 'table', align: (n.align ?? []).map((a) => a ?? null), head: rows[0] ?? [], rows: rows.slice(1) };
}

function blocks(nodes: RootContent[], index: Map<string, number>): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'heading':
        out.push({ t: 'h', depth: n.depth, c: inlines(n.children, index) });
        break;
      case 'paragraph': {
        // A paragraph that is only an image is a figure, like the prototype.
        const only = n.children.length === 1 ? n.children[0] : null;
        if (only && only.type === 'image') out.push({ t: 'figure', src: safeImg(only.url), alt: only.alt ?? '' });
        else out.push({ t: 'p', c: inlines(n.children, index) });
        break;
      }
      case 'list':
        out.push({
          t: 'list',
          ordered: !!n.ordered,
          start: n.ordered ? (n.start ?? 1) : null,
          items: n.children.map((li) => ({ checked: typeof li.checked === 'boolean' ? li.checked : null, c: blocks(li.children, index) })),
        });
        break;
      case 'code':
        out.push({ t: 'pre', v: n.value, lang: n.lang ?? null });
        break;
      case 'blockquote':
        out.push({ t: 'quote', c: blocks(n.children, index) });
        break;
      case 'thematicBreak':
        out.push({ t: 'hr' });
        break;
      case 'table':
        out.push(tableBlock(n, index));
        break;
      case 'html':
        // Raw HTML blocks are shown as text.
        out.push({ t: 'p', c: [{ t: 'text', v: n.value }] });
        break;
      case 'definition':
      case 'footnoteDefinition':
      case 'yaml':
        break;
      default: {
        const v = textOf(n as Nodes);
        if (v.trim()) out.push({ t: 'p', c: [{ t: 'text', v }] });
      }
    }
  }
  return out;
}

export function parseMarkdown(src: string, index?: Map<string, number>): Block[] {
  const tree = fromMarkdown(src.replace(/\r/g, ''), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return blocks(tree.children, index ?? linkIndex(src));
}

/** Plain text of a block list (used for titles and tests). */
export function plainText(bs: Block[]): string {
  const inl = (xs: Inline[]): string =>
    xs.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.t === 'wl' ? (x.label ?? x.path) : 'c' in x ? inl(x.c) : x.t === 'img' ? x.alt : '')).join('');
  return bs
    .map((b) =>
      b.t === 'h' || b.t === 'p'
        ? inl(b.c)
        : b.t === 'list'
          ? b.items.map((i) => plainText(i.c)).join('\n')
          : b.t === 'quote'
            ? plainText(b.c)
            : b.t === 'pre'
              ? b.v
              : b.t === 'table'
                ? [b.head, ...b.rows].map((r) => r.map(inl).join(' ')).join('\n')
                : b.t === 'figure'
                  ? b.alt
                  : '',
    )
    .join('\n');
}
