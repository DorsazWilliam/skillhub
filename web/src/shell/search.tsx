import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Ic } from '../lib/icons';
import { reEsc, areaKey, AREAS, type AreaKey } from '../lib/util';
import { nodeIcon } from '../ui/common';

/** Search shared by the desktop dropdown, the search page and the phone search tab. */

export interface SearchRow {
  id: string;
  icon: string;
  area: AreaKey;
  title: string;
  desc: string | null;
  snippet: string | null;
  path: string;
  mono: boolean;
}

export function useDebounced<T>(v: T, ms = 160): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const parentPath = (p: string): string => p.split('/').filter(Boolean).slice(0, -1).join(' / ');

export function useSearch(q: string) {
  const dq = useDebounced(q.trim());
  return useQuery({
    queryKey: ['search', dq],
    enabled: dq.length > 0,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const [skills, hits] = await Promise.all([api.find_skills({ task: dq, limit: 7 }).catch(() => ({ skills: [] })), api.search({ q: dq, limit: 20 })]);
      const rows: SearchRow[] = [];
      const seen = new Set<string>();
      for (const s of skills.skills) {
        seen.add(s.id);
        rows.push({ id: s.id, icon: 'sparkles', area: 'skills', title: s.name, desc: s.description, snippet: null, path: parentPath(s.path), mono: true });
      }
      const names: SearchRow[] = [];
      for (const h of hits.items) {
        const n = h.node;
        if (seen.has(n.id) || n.is_area) continue;
        if (n.name === 'SKILL.md' && n.parent_id && seen.has(n.parent_id)) continue;
        seen.add(n.id);
        const a = areaKey(n.area);
        if (h.match === 'content')
          rows.push({
            id: n.id,
            icon: n.kind === 'folder' && n.is_skill ? 'sparkles' : AREAS[a].icon,
            area: a,
            title: n.name,
            desc: null,
            snippet: h.snippet,
            path: parentPath(n.path),
            mono: true,
          });
        else names.push({ id: n.id, icon: nodeIcon(n), area: a, title: n.name, desc: null, snippet: null, path: parentPath(n.path), mono: false });
      }
      return { rows: rows.slice(0, 7), names: names.slice(0, 6), toks: dq.toLowerCase().split(/\s+/).filter(Boolean) };
    },
  });
}

/** Highlight query tokens in plain text (React text nodes, no HTML). */
export function Hl({ text, toks }: { text: string; toks: string[] }): ReactElement {
  if (!toks.length) return <>{text}</>;
  const re = new RegExp('(' + toks.map(reEsc).join('|') + ')', 'gi');
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(<mark key={i++}>{m[0]}</mark>);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function SearchResults({ q, sIdx, onPick }: { q: string; sIdx: number; onPick: (id: string) => void }): ReactElement | null {
  const r = useSearch(q);
  const d = r.data;
  if (!d) return null;
  const items = [...d.rows, ...d.names];
  if (!items.length)
    return (
      <div className="sres">
        <div className="empty" style={{ padding: '24px 0' }}>
          <Ic n="search" s={18} />
          <span>No matches</span>
        </div>
      </div>
    );
  return (
    <div className="sres" role="listbox">
      {items.map((it, i) => (
        <button
          key={it.id}
          className={'sr' + (i === sIdx ? ' on' : '')}
          role="option"
          aria-selected={i === sIdx}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(it.id)}
        >
          <span className={(it.mono ? 'sk ' : '') + 'ac-' + it.area}>
            <Ic n={it.icon} s={15} />
          </span>
          <div className="grow">
            {it.mono ? (
              <>
                <div className="st">
                  <Hl text={it.title} toks={d.toks} />
                </div>
                {it.desc ? (
                  <div className="sd">
                    <Hl text={it.desc} toks={d.toks} />
                  </div>
                ) : null}
                {it.snippet ? (
                  <div className="sp">
                    <Hl text={it.snippet} toks={d.toks} />
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 13 }}>
                <Hl text={it.title} toks={d.toks} />
              </div>
            )}
          </div>
          <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
            {it.path}
          </span>
        </button>
      ))}
    </div>
  );
}

export function searchIds(q: string, data: ReturnType<typeof useSearch>['data']): string[] {
  void q;
  return data ? [...data.rows, ...data.names].map((x) => x.id) : [];
}
