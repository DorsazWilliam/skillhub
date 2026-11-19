import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref, safeImg, type Block, type Inline } from '../web/src/lib/markdown';

/**
 * Hostile markdown against the SPA renderer (web/src/lib/markdown.ts). The renderer produces plain data that React
 * renders as text; these tests check that nothing executable survives: no raw HTML, no script-capable URLs, images only
 * from the asset proxy.
 */

const ULID = '01HZX3K9Q7W8E5R2T4Y6U8I0PA'.replace(/[IOUL]/g, 'A');

function walk(bs: Block[], out: { links: string[]; imgs: (string | null)[]; text: string[] } = { links: [], imgs: [], text: [] }) {
  const inl = (xs: Inline[]): void => {
    for (const x of xs) {
      if (x.t === 'text' || x.t === 'code') out.text.push(x.v);
      else if (x.t === 'link') {
        out.links.push(x.href);
        inl(x.c);
      } else if (x.t === 'img') out.imgs.push(x.src);
      else if ('c' in x) inl(x.c);
    }
  };
  for (const b of bs) {
    if (b.t === 'h' || b.t === 'p') inl(b.c);
    else if (b.t === 'list') for (const i of b.items) walk(i.c, out);
    else if (b.t === 'quote') walk(b.c, out);
    else if (b.t === 'pre') out.text.push(b.v);
    else if (b.t === 'table') for (const r of [b.head, ...b.rows]) for (const c of r) inl(c);
    else if (b.t === 'figure') out.imgs.push(b.src);
  }
  return out;
}

function allowed(href: string): boolean {
  return /^(https?:\/\/[^/\\]|mailto:|\/(?![/\\]))/i.test(href);
}

describe('markdown sanitizer', () => {
  it('keeps script tags and HTML blocks as inert text', () => {
    const r = walk(parseMarkdown('<script>alert(1)</script>\n\nhello <img src=x onerror=alert(1)> <b onclick="x()">b</b>\n\n<div><iframe src="https://evil"></iframe></div>'));
    expect(r.links).toEqual([]);
    expect(r.imgs).toEqual([]);
    // The tags survive only as text, which React escapes.
    expect(r.text.join(' ')).toContain('<script>alert(1)</script>');
    expect(r.text.join(' ')).toContain('onerror=alert(1)');
  });

  it('drops javascript:, vbscript:, data: and obfuscated scheme links but keeps their text', () => {
    const md = [
      '[a](javascript:alert(1))',
      '[b](JaVaScRiPt:alert(1))',
      '[c](java\tscript:alert(1))',
      '[d](vbscript:msgbox(1))',
      '[e](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[f](//evil.example/x)',
      '[g](\\\\evil.example/x)',
      '[h](&#106;avascript:alert(1))',
      '<javascript:alert(1)>',
      '[i](file:///etc/passwd)',
    ].join('\n\n');
    const r = walk(parseMarkdown(md));
    expect(r.links).toEqual([]);
    const all = r.text.join(' ');
    for (const l of 'abcdefghi') expect(all).toContain(l);
  });

  it('keeps http, https, mailto and same-origin app links', () => {
    const r = walk(parseMarkdown('[a](https://example.com/x) [b](http://example.com) [c](mailto:a@b.c) [d](/n/abc) <https://auto.example>'));
    expect(r.links).toEqual(['https://example.com/x', 'http://example.com', 'mailto:a@b.c', '/n/abc', 'https://auto.example']);
    for (const l of r.links) expect(allowed(l)).toBe(true);
  });

  it('only loads images from the asset proxy', () => {
    const md = [
      `![ok](asset://${ULID})`,
      `![ok2](/a/${ULID})`,
      '![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
      '![remote](https://evil.example/pixel.png)',
      '![js](javascript:alert(1))',
      '![rel](../a/x)',
      `![traversal](/a/${ULID}/../../api/v1/me)`,
      '![svgfile](https://evil.example/x.svg)',
    ].join('\n\n');
    const r = walk(parseMarkdown(md));
    expect(r.imgs).toEqual([`/a/${ULID}`, `/a/${ULID}`, null, null, null, null, null, null]);
  });

  it('handles nested tricks: links inside emphasis, tables and quotes, and reference definitions', () => {
    const md = [
      '> **[x](javascript:alert(1))** and *[y](data:text/html,1)*',
      '',
      '| a | b |',
      '|---|---|',
      '| [z](javascript:void(0)) | <img src=x onerror=alert(1)> |',
      '',
      '[ref]: javascript:alert(1)',
      '',
      '[click][ref]',
      '',
      '- [ ] [task](vbscript:x)',
      '',
      '```html',
      '<script>alert(1)</script>',
      '```',
    ].join('\n');
    const r = walk(parseMarkdown(md));
    expect(r.links).toEqual([]);
    expect(r.imgs).toEqual([]);
    expect(r.text.join(' ')).toContain('<script>alert(1)</script>');
  });

  it('turns [[links]] into chips outside code only, indexed like the API', () => {
    const bs = parseMarkdown('See [[documentation/a]] and [[skills/b|B]] and `[[not/a/link]]` and [[documentation/a]] again.');
    const p = bs[0];
    expect(p?.t).toBe('p');
    const wl = p && p.t === 'p' ? p.c.filter((x) => x.t === 'wl') : [];
    expect(wl).toEqual([
      { t: 'wl', path: 'documentation/a', label: null, idx: 0 },
      { t: 'wl', path: 'skills/b', label: 'B', idx: 1 },
      { t: 'wl', path: 'documentation/a', label: null, idx: 0 },
    ]);
  });

  it('safeHref and safeImg reject edge cases directly', () => {
    expect(safeHref(' javascript:alert(1)')).toBeNull();
    expect(safeHref('\u0000javascript:alert(1)')).toBeNull();
    expect(safeHref('https:evil')).toBeNull();
    expect(safeHref('https://ok.example')).toEqual({ href: 'https://ok.example', internal: false });
    expect(safeImg('asset://not-an-id')).toBeNull();
    expect(safeImg(`asset://${ULID}`)).toBe(`/a/${ULID}`);
  });
});
