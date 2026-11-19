import { useMemo, type ReactElement, type ReactNode } from 'react';
import { parseMarkdown, linkIndex, type Block, type Inline } from '../lib/markdown';
import { Ic } from '../lib/icons';
import { areaKey, LINK_RULE, type AreaKey, type AreaName } from '../lib/util';
import { navigate } from '../router';
import type { Skill } from '../api/hooks';

/** Renders the safe tree from lib/markdown.ts as React elements. React escapes every string; no innerHTML. */

export type LinkInfo = Skill['links'][number];

export function areaOfCanon(p: string | null | undefined): AreaKey {
  const a = (p ?? '').split('/')[0] as AreaName;
  return areaKey(a);
}

export const kindIcon = (k: LinkInfo['kind']): string => (k === 'skill' ? 'sparkles' : k === 'folder' ? 'folder' : k === 'file' ? 'file-code' : 'file');

export function WikiChip({ path, label, info, src }: { path: string; label: string | null; info: LinkInfo | undefined; src: AreaKey }): ReactElement {
  const tail = path.split('/').pop() ?? path;
  const st = info?.status ?? 'broken';
  if (st === 'broken')
    return (
      <span className="wl broken" data-tip="Not found">
        <Ic n="link-off" s={12} />
        <span>{label || tail}</span>
      </span>
    );
  if (st === 'locked')
    return (
      <span className="wl locked" data-tip="No access" aria-label="Locked link">
        <Ic n="lock" s={12} />
      </span>
    );
  const canon = info?.canonical_path ?? path;
  const lbl = label || (canon.split('/').pop() ?? canon).replace(/\.md$/, '');
  const go = (e: React.MouseEvent): void => {
    e.preventDefault();
    if (info?.id) navigate('/n/' + info.id);
  };
  if (st === 'wrong_direction')
    return (
      <a className="wl warn" href={info?.id ? '/n/' + info.id : undefined} onClick={go} data-tip={LINK_RULE[src]}>
        <Ic n="alert" s={12} />
        <span>{lbl}</span>
      </a>
    );
  return (
    <a className={'wl a-' + areaOfCanon(canon)} href={info?.id ? '/n/' + info.id : undefined} onClick={go} data-tip={canon}>
      <Ic n={kindIcon(info?.kind ?? 'doc')} s={12} />
      <span>{lbl}</span>
    </a>
  );
}

interface Ctx {
  links: LinkInfo[];
  src: AreaKey;
}

function renderInline(xs: Inline[], ctx: Ctx, key = ''): ReactNode[] {
  return xs.map((x, i) => {
    const k = key + i;
    switch (x.t) {
      case 'text':
        return x.v;
      case 'strong':
        return <strong key={k}>{renderInline(x.c, ctx, k)}</strong>;
      case 'em':
        return <em key={k}>{renderInline(x.c, ctx, k)}</em>;
      case 'del':
        return <del key={k}>{renderInline(x.c, ctx, k)}</del>;
      case 'code':
        return <code key={k}>{x.v}</code>;
      case 'br':
        return <br key={k} />;
      case 'img':
        return x.src ? <img key={k} src={x.src} alt={x.alt} style={{ maxHeight: '1.4em', verticalAlign: 'middle' }} /> : x.alt;
      case 'link':
        return x.internal ? (
          <a
            key={k}
            href={x.href}
            onClick={(e) => {
              e.preventDefault();
              navigate(x.href);
            }}
          >
            {renderInline(x.c, ctx, k)}
          </a>
        ) : (
          <a key={k} href={x.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(x.c, ctx, k)}
          </a>
        );
      case 'wl':
        // Named links match by path; locked links (href null) match by their index among distinct links.
        return <WikiChip key={k} path={x.path} label={x.label} info={ctx.links.find((l) => l.href === x.path) ?? (x.idx >= 0 ? ctx.links[x.idx] : undefined)} src={ctx.src} />;
    }
  });
}

function renderBlocks(bs: Block[], ctx: Ctx, key = ''): ReactNode[] {
  return bs.map((b, i) => {
    const k = key + i;
    switch (b.t) {
      case 'h': {
        const H = ('h' + Math.min(b.depth, 4)) as 'h1';
        return <H key={k}>{renderInline(b.c, ctx, k)}</H>;
      }
      case 'p':
        return <p key={k}>{renderInline(b.c, ctx, k)}</p>;
      case 'list': {
        const items = b.items.map((it, j) => {
          // Tight list items hold one paragraph: render its inline content directly, like the prototype.
          const only = it.c.length === 1 && it.c[0]!.t === 'p' ? it.c[0] : null;
          return (
            <li key={j}>
              {it.checked !== null ? <input type="checkbox" className="cb" checked={it.checked} disabled readOnly style={{ verticalAlign: '-2px', marginRight: 6 }} /> : null}
              {only && only.t === 'p' ? renderInline(only.c, ctx, k + 'l' + j) : renderBlocks(it.c, ctx, k + 'l' + j)}
            </li>
          );
        });
        return b.ordered ? (
          <ol key={k} start={b.start && b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'pre':
        return (
          <pre key={k}>
            <code>{b.v}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.c, ctx, k)}</blockquote>;
      case 'hr':
        return <hr key={k} />;
      case 'table':
        return (
          <div className="tbl" key={k}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                      {renderInline(c, ctx, k + 'h' + j)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, x) => (
                      <td key={x} style={b.align[x] ? { textAlign: b.align[x]! } : undefined}>
                        {renderInline(c, ctx, k + 'r' + j + 'c' + x)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'figure':
        return (
          <figure key={k}>
            {b.src ? (
              <img src={b.src} alt={b.alt} />
            ) : (
              <div className="ph">
                <Ic n="image" s={22} />
              </div>
            )}
            {b.alt ? <figcaption>{b.alt}</figcaption> : null}
          </figure>
        );
    }
  });
}

/** Markdown body. `skipH1` drops a leading H1 (mobile shows it as the large title). */
export function Markdown({ src, full, links, area, skipH1 }: { src: string; full?: string; links: LinkInfo[]; area: AreaKey; skipH1?: boolean }): ReactElement {
  const blocks = useMemo(() => {
    // Indexes follow the whole document as stored (frontmatter included), like the API.
    const bs = parseMarkdown(src, linkIndex(full ?? src));
    if (skipH1 && bs[0]?.t === 'h' && bs[0].depth === 1) return bs.slice(1);
    return bs;
  }, [src, full, skipH1]);
  return <article className="md">{renderBlocks(blocks, { links, src: area })}</article>;
}

export function firstH1(src: string): string | null {
  const bs = parseMarkdown(src);
  const b = bs[0];
  if (b && b.t === 'h' && b.depth === 1) {
    return b.c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.t === 'wl' ? (x.label ?? x.path) : '')).join('');
  }
  return null;
}
