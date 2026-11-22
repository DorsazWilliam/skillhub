import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Ic } from '../lib/icons';
import { ago } from '../lib/util';
import { Empty, Spinner } from '../ui/common';
import { goNode } from '../actions';
import { navigate } from '../router';
import { showUsageOnGraph } from './Graph';

/**
 * What agents actually use (owners): per published skill and documentation page, loads, people, a daily bar chart,
 * times shown in results, and notes for things agents do not find. Informative only: nothing here blocks anything.
 */

export type UsageItem = Awaited<ReturnType<typeof api.get_usage>>['items'][number];
export type UsageF = { kind: 'all' | 'skill' | 'doc'; days: 7 | 30 | 90; attn: boolean; sort: 'name' | 'loads' | 'people' | 'shown' | 'last'; dir: 'asc' | 'desc' };
export const USAGE_F0: UsageF = { kind: 'all', days: 30, attn: false, sort: 'loads', dir: 'desc' };

export function useUsage(days: number, enabled = true) {
  return useQuery({ queryKey: ['usage', days], enabled, staleTime: 60_000, queryFn: () => api.get_usage({ days }) });
}

type Note = { tone: '' | 'warn' | 'bad'; label: string; tip: string };

export function usageNotes(it: UsageItem): Note[] {
  const out: Note[] = [];
  if (!it.loads && !it.shown) out.push({ tone: 'bad', label: 'Never found', tip: 'No agent search returned it in this period. Its name or description may not match how people ask.' });
  else if (!it.loads) out.push({ tone: 'warn', label: 'Shown, never opened', tip: `Came back in results ${it.shown} times and was never loaded. The description may not say when to use it.` });
  else if (it.shown >= 12 && it.loads / it.shown < 0.15) out.push({ tone: 'warn', label: 'Rarely picked', tip: `Shown ${it.shown} times, loaded ${it.loads}. Agents usually choose something else.` });
  if (it.kind === 'doc' && !it.links_in) out.push({ tone: '', label: 'No links in', tip: 'Nothing links here, so agents only reach it through search.' });
  return out;
}

export function usageRows(items: UsageItem[], F: UsageF): { it: UsageItem; notes: Note[] }[] {
  const rows = items
    .filter((it) => F.kind === 'all' || it.kind === F.kind)
    .map((it) => ({ it, notes: usageNotes(it) }))
    .filter((r) => !F.attn || r.notes.some((n) => n.tone));
  const key = (it: UsageItem): number => (F.sort === 'last' ? (it.last_load_at ?? 0) : F.sort === 'name' ? 0 : it[F.sort]);
  rows.sort((a, b) => {
    const v = F.sort === 'name' ? a.it.name.localeCompare(b.it.name) : key(a.it) - key(b.it);
    return (F.dir === 'asc' ? v : -v) || a.it.name.localeCompare(b.it.name);
  });
  return rows;
}

/** Daily loads as small bars. Zero days get a thin baseline so the range stays readable. */
export function Spark({ days, w = 120, h = 24 }: { days: number[]; w?: number; h?: number }): ReactElement {
  const max = Math.max(1, ...days);
  const bw = w / Math.max(1, days.length);
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {days.map((d, i) => {
        const bh = d ? Math.max(2, (d / max) * (h - 2)) : 1;
        return <rect key={i} x={i * bw + 0.5} y={h - bh} width={Math.max(1, bw - 1.2)} height={bh} rx={1} className={d ? '' : 'z'} />;
      })}
    </svg>
  );
}

const sparkDays = (daily: number[], days: number): number[] => {
  // 90 days of bars do not fit a cell: fold them into weeks.
  if (days <= 30) return daily;
  const out: number[] = [];
  for (let i = daily.length; i > 0; i -= 7) out.unshift(daily.slice(Math.max(0, i - 7), i).reduce((a, b) => a + b, 0));
  return out;
};

export function UsageStats({ items, people }: { items: UsageItem[]; people: number }): ReactElement {
  const loads = items.reduce((s, it) => s + it.loads, 0);
  const used = items.filter((it) => it.loads > 0).length;
  const unused = items.length - used;
  return (
    <div className="ustats">
      <div>
        <b className="num">{loads}</b>
        <span>loads by agents</span>
      </div>
      <div>
        <b className="num">
          {used}
          <small>/{items.length}</small>
        </b>
        <span>skills and docs used</span>
      </div>
      <div>
        <b className="num">{people}</b>
        <span>people whose agents loaded something</span>
      </div>
      <div className={unused ? 'warn' : ''}>
        <b className="num">{unused}</b>
        <span>not loaded once</span>
      </div>
    </div>
  );
}

export function UsageBar({ F, setF, mobile }: { F: UsageF; setF: (f: UsageF) => void; mobile?: boolean }): ReactElement {
  return (
    <div className={mobile ? 'm-pad row-flex' : 'bar'} style={{ flexWrap: 'wrap' }}>
      <div className="seg" role="group" aria-label="Kind">
        {(
          [
            ['all', 'All'],
            ['skill', 'Skills'],
            ['doc', 'Docs'],
          ] as const
        ).map(([v, l]) => (
          <button key={v} className={F.kind === v ? 'on' : ''} onClick={() => setF({ ...F, kind: v })}>
            {l}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Range">
        {([7, 30, 90] as const).map((d) => (
          <button key={d} className={F.days === d ? 'on' : ''} onClick={() => setF({ ...F, days: d })}>
            {d}d
          </button>
        ))}
      </div>
      <button className={'btn' + (mobile ? '' : ' sm') + (F.attn ? ' on' : '')} aria-pressed={F.attn} onClick={() => setF({ ...F, attn: !F.attn })}>
        <Ic n="alert" s={14} />
        <span>Needs a look</span>
      </button>
      {mobile ? null : (
        <>
          <div className="grow" />
          <button
            className="btn sm"
            onClick={() => {
              showUsageOnGraph(true);
              navigate('/graph');
            }}
          >
            <Ic n="graph" s={14} />
            <span>See on graph</span>
          </button>
        </>
      )}
    </div>
  );
}

const Notes = ({ notes }: { notes: Note[] }): ReactElement => (
  <>
    {notes.map((n) => (
      <span key={n.label} className={'chip ' + n.tone} data-tip={n.tip}>
        {n.label}
      </span>
    ))}
  </>
);

export function UsagePage(): ReactElement {
  const [F, setF] = useState<UsageF>(USAGE_F0);
  const q = useUsage(F.days);
  const items = q.data?.items ?? [];
  const rows = usageRows(items, F);
  const max = Math.max(1, ...rows.map((r) => r.it.loads));
  const sort = (k: UsageF['sort']): void => setF({ ...F, sort: k, dir: F.sort === k ? (F.dir === 'asc' ? 'desc' : 'asc') : k === 'name' ? 'asc' : 'desc' });
  const th = (k: UsageF['sort'] | null, label: string, tip?: string): ReactElement => (
    <th className={k ? 'sortable' : ''} data-tip={tip} aria-sort={k && F.sort === k ? (F.dir === 'asc' ? 'ascending' : 'descending') : undefined} onClick={k ? () => sort(k) : undefined}>
      {label}
      {k && F.sort === k ? <Ic n="chev-d" s={11} c={'sdir' + (F.dir === 'asc' ? ' up' : '')} /> : null}
    </th>
  );
  const sw = F.days === 7 ? 70 : 120;
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>Usage</h1>
        <div className="grow" />
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <>
          <UsageStats items={items} people={q.data?.totals.people ?? 0} />
          <UsageBar F={F} setF={setF} />
          <div className="tw-scroll">
            <table className="t ut">
              <thead>
                <tr>
                  {th('name', 'Skill or doc')}
                  {th('loads', 'Loads', 'Times an agent read it')}
                  {th('people', 'People')}
                  <th>{F.days <= 30 ? `Last ${F.days} days` : 'By week'}</th>
                  {th('shown', 'Shown', 'Times it came back from find_skills or search, then how many loads')}
                  {th('last', 'Last loaded')}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ it, notes }) => (
                  <tr key={it.id} className="click" onClick={() => void goNode(it.id)}>
                    <td>
                      <div className="row-flex">
                        <span className={it.kind === 'skill' ? 'ac-skills' : 'ac-docs'} style={{ display: 'inline-flex' }}>
                          <Ic n={it.kind === 'skill' ? 'sparkles' : 'file'} s={15} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="ell" style={{ fontWeight: 500 }}>
                            {it.name}
                          </div>
                          <div className="faint ell" style={{ fontSize: 11.5 }}>
                            {it.path.split('/').slice(1, -1).join(' / ')}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="num">
                      <span className="ubar">
                        <span style={{ width: ((it.loads / max) * 100).toFixed(1) + '%' }} />
                      </span>
                      <b>{it.loads}</b>
                    </td>
                    <td className="num">{it.people || <span className="faint">0</span>}</td>
                    <td>
                      <Spark days={sparkDays(it.daily, F.days)} w={sw} />
                    </td>
                    <td className="num">
                      {it.shown ? (
                        <>
                          {it.shown} <span className="faint">&rarr; {it.loads}</span>
                        </>
                      ) : (
                        <span className="faint">0</span>
                      )}
                    </td>
                    <td className="num">{it.last_load_at ? ago(it.last_load_at) : <span className="faint">never</span>}</td>
                    <td>
                      <Notes notes={notes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length ? null : <Empty icon="check" />}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
            Agent reads only, kept 90 days. Rules are not listed: every agent gets them when it connects.
          </div>
        </>
      )}
    </div>
  );
}

/** Phone body for the Usage screen. */
export function UsageMobile(): ReactElement {
  const [F, setF] = useState<UsageF>(USAGE_F0);
  const q = useUsage(F.days);
  const items = q.data?.items ?? [];
  const rows = usageRows(items, F);
  if (q.isLoading) return <Spinner />;
  return (
    <>
      <div className="m-pad">
        <UsageStats items={items} people={q.data?.totals.people ?? 0} />
      </div>
      <UsageBar F={F} setF={setF} mobile />
      {rows.length ? (
        <div className="m-group">
          {rows.map(({ it, notes }) => (
            <button key={it.id} className="m-row" onClick={() => void goNode(it.id)}>
              <span className={'m-ic sm ' + (it.kind === 'skill' ? 'a-skills' : 'a-docs')}>
                <Ic n={it.kind === 'skill' ? 'sparkles' : 'file'} s={16} />
              </span>
              <span className="m-tx">
                <span className="m-t">{it.name}</span>
                <span className="m-s">
                  {it.loads} loads · {it.people} people{notes.length ? ' · ' + notes.map((n) => n.label).join(', ') : ''}
                </span>
              </span>
              <Spark days={sparkDays(it.daily, F.days)} w={F.days === 7 ? 44 : 72} h={22} />
            </button>
          ))}
        </div>
      ) : (
        <Empty icon="check" />
      )}
    </>
  );
}
