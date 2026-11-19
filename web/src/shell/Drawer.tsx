import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactElement } from 'react';
import { api } from '../api/client';
import { useGraph, useLinks, useNode, useUsers, useTeams, useVersions, useMe, role, type NodeT } from '../api/hooks';
import { Ic } from '../lib/icons';
import { ago, AREA_KEYS, areaKey, LINK_RULE, ROLES, RICON, ROLE_N, OPI, OPL, VIA, type AreaKey } from '../lib/util';
import { Av, TeamAv, IB, Empty } from '../ui/common';
import { setUI, useUI, type DrawerTab } from '../state';
import { goNode } from '../actions';
import { navigate } from '../router';
import { useDocModel, useDraftInfo, viewFor } from '../pages/docModel';
import { useUserName } from '../pages/Doc';

type GraphData = Awaited<ReturnType<typeof api.get_graph>>;
type GNode = GraphData['nodes'][number];
type GEdge = GraphData['edges'][number];

const gIcon = (o: GNode): string => (o.kind === 'skill' ? 'sparkles' : 'file');
const cut = (s: string): string => (s.length > 14 ? s.slice(0, 13) + '…' : s);

/** Local link graph around one node (prototype localGraph), as plain SVG. */
function LocalGraph({ k, D }: { k: string; D: GraphData }): ReactElement | null {
  const by = new Map(D.nodes.map((x) => [x.id, x]));
  const me = by.get(k);
  if (!me) return null;
  const nb = new Map<string, GEdge>();
  for (const e of D.edges) {
    if (e.from === k) nb.set(e.to, e);
    else if (e.to === k) nb.set(e.from, e);
  }
  const list = [...nb.keys()].filter((id) => by.has(id)).slice(0, 14);
  const W = 360;
  const H = 250;
  const cx = W / 2;
  const cy = H / 2 - 6;
  const n = list.length;
  const R = n < 5 ? 72 : 94;
  const pos = list.map((id, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / Math.max(n, 1);
    return { o: by.get(id)!, e: nb.get(id)!, x: cx + Math.cos(a) * R * 1.55, y: cy + Math.sin(a) * R, up: Math.sin(a) < -0.2 };
  });
  const ak = (o: GNode): AreaKey => areaKey(o.area);
  return (
    <svg className="lg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Local graph">
      {pos.map((p) => (
        <line key={'l' + p.o.id} x1={cx} y1={cy} x2={p.x.toFixed(1)} y2={p.y.toFixed(1)} className={(p.e.status === 'wrong_direction' ? 'bad ' : '') + (p.e.contains ? 'dash' : '')} />
      ))}
      {pos.map((p) => (
        <g key={'n' + p.o.id} className="lgn" onClick={() => void goNode(p.o.open_id)}>
          <title>{p.o.label}</title>
          <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={5.5} className={'f-' + ak(p.o)} />
          <text x={p.x.toFixed(1)} y={(p.up ? p.y - 10 : p.y + 18).toFixed(1)}>
            {cut(p.o.label)}
          </text>
        </g>
      ))}
      <g className="lgn me">
        <circle cx={cx} cy={cy} r={12} className={'halo f-' + ak(me)} />
        <circle cx={cx} cy={cy} r={8} className={'f-' + ak(me)} />
        <text x={cx} y={cy + 24}>
          {cut(me.label)}
        </text>
      </g>
    </svg>
  );
}

function Sec({ icon, label, n }: { icon: string; label: string; n: number }): ReactElement {
  return (
    <div className="sec row-flex" style={{ gap: 6 }}>
      <Ic n={icon} s={12} />
      <span>{label}</span>
      <span className="cnt">{n}</span>
    </div>
  );
}

function LinksTab({ node }: { node: NodeT }): ReactElement {
  const m = useDocModel(node.id);
  const g = useGraph();
  const k = m.skillId ?? node.id;
  const links = useLinks(k);
  const D = g.data;
  if (!D) return <Empty icon="loader" pad="40px 0" eic={false} />;
  const by = new Map(D.nodes.map((x) => [x.id, x]));
  const outE = D.edges.filter((e) => e.from === k);
  const inE = D.edges.filter((e) => e.to === k);
  const out = links.data?.outgoing ?? [];
  const locked = out.filter((l) => l.status === 'locked').length;
  const broken = out.filter((l) => l.status === 'broken').length;
  const row = (e: GEdge, o: GNode): ReactElement => (
    <button key={o.id + (e.from === k ? 'o' : 'i')} className="lrow" onClick={() => void goNode(o.open_id)}>
      <span className={'ac-' + areaKey(o.area)}>
        <Ic n={gIcon(o)} s={15} />
      </span>
      <span className="grow ell">{o.label}</span>
      {e.contains ? (
        <span className="faint" data-tip="Sub-skill">
          <Ic n="layers" s={13} />
        </span>
      ) : null}
      {e.status === 'wrong_direction' ? (
        <span className="warn-i" data-tip={LINK_RULE[areaKey(by.get(e.from)?.area)]}>
          <Ic n="alert" s={13} />
        </span>
      ) : null}
    </button>
  );
  const grp = (list: GEdge[], side: 'out' | 'in'): ReactElement[] =>
    AREA_KEYS.flatMap((a) =>
      list
        .map((e) => ({ e, o: by.get(side === 'out' ? e.to : e.from) }))
        .filter((x): x is { e: GEdge; o: GNode } => !!x.o && areaKey(x.o.area) === a)
        .map((x) => row(x.e, x.o)),
    );
  const none = (
    <div className="lrow faint" style={{ cursor: 'default' }}>
      <Ic n="minus" s={14} />
    </div>
  );
  return (
    <>
      <LocalGraph k={k} D={D} />
      <Sec icon="arrow" label="Links to" n={outE.length} />
      {outE.length ? grp(outE, 'out') : none}
      {locked || broken ? (
        <div className="row-flex lhid">
          {locked ? (
            <span className="chip" data-tip="Links you cannot open">
              <Ic n="lock" s={11} />
              {locked}
            </span>
          ) : null}
          {broken ? (
            <span className="chip bad" data-tip="Links to nothing">
              <Ic n="link-off" s={11} />
              {broken}
            </span>
          ) : null}
        </div>
      ) : null}
      <Sec icon="arrow-in" label="Linked from" n={inE.length} />
      {inE.length ? grp(inE, 'in') : none}
      <div style={{ padding: '12px 8px 4px' }}>
        <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate('/graph?focus=' + encodeURIComponent(k))}>
          <Ic n="graph" s={15} />
          <span>Open in graph</span>
        </button>
      </div>
    </>
  );
}

function HistoryTab({ node }: { node: NodeT }): ReactElement {
  const vs = useVersions(node.id);
  const viewing = useUI((s) => s.viewing);
  const cur = viewFor(node, viewing);
  const d = useDraftInfo(node);
  const draftBy = useUserName(d.data?.draft?.updated_by);
  const p = node.published_version ?? null;
  const cp = role(node) >= 3;
  const items = vs.data?.items ?? [];
  const first = (s: string | null | undefined): string => (s ?? '').split(' ')[0] ?? '';
  if (!items.length && !node.has_draft) return <Empty icon="history" pad="40px 0" eic={false} />;
  return (
    <>
      {node.has_draft ? (
        <button className={'hrow' + (cur === 'draft' ? ' cur' : '')} onClick={() => setUI({ viewing: 'draft', editing: null })}>
          <span className="vn dr">
            <Ic n="pencil" s={12} />
          </span>
          <div className="hmain">
            <div className="ht">Draft</div>
            <div className="hs">
              <Av name={draftBy} s={16} />
              {first(draftBy)} · {ago(d.data?.draft?.updated_at)}
            </div>
          </div>
          <div className="hact">
            <span
              className="ib xs"
              role="button"
              data-tip={`Compare with v${node.head_version ?? 0}`}
              onClick={(e) => {
                e.stopPropagation();
                setUI({ modal: { type: 'diff', id: node.id, a: node.head_version ?? 0, b: 'draft' } });
              }}
            >
              <Ic n="diff" s={14} />
            </span>
          </div>
        </button>
      ) : null}
      {items.map((v) => (
        <div
          key={v.n}
          className={'hrow' + (cur === v.n ? ' cur' : '')}
          role="button"
          tabIndex={0}
          onClick={() => setUI({ viewing: v.n, editing: null })}
          onKeyDown={(e) => e.key === 'Enter' && setUI({ viewing: v.n, editing: null })}
        >
          <span className="vn">v{v.n}</span>
          <div className="hmain">
            <div className="ht">{v.message ?? 'Update'}</div>
            <div className="hs">
              <Av name={v.author_name} s={16} />
              {first(v.author_name)} · {ago(v.created_at)}
            </div>
          </div>
          <div className="hact">
            {v.n > 1 ? (
              <span
                className="ib xs"
                role="button"
                aria-label={`Compare with v${v.n - 1}`}
                data-tip={`Compare with v${v.n - 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setUI({ modal: { type: 'diff', id: node.id, a: v.n - 1, b: v.n } });
                }}
              >
                <Ic n="diff" s={14} />
              </span>
            ) : null}
            {cp && v.n !== p ? (
              <span
                className="ib xs"
                role="button"
                aria-label={`${v.n < (p ?? 0) ? 'Roll back to' : 'Publish'} v${v.n}`}
                data-tip={`${v.n < (p ?? 0) ? 'Roll back to' : 'Publish'} v${v.n}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setUI({ modal: { type: 'publish', id: node.id, v: v.n } });
                }}
              >
                <Ic n={v.n < (p ?? 0) ? 'undo' : 'rocket'} s={14} />
              </span>
            ) : null}
          </div>
          {v.n === p ? (
            <span className="hb" data-tip="Published">
              <Ic n="check" s={15} style={{ color: 'var(--ok)' }} />
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function usePrincipalName(): (type: 'user' | 'team', id: string, fallback?: string | null) => string {
  const users = useUsers();
  const teams = useTeams();
  return (type, id, fallback) => {
    if (type === 'team') return id === 'everyone' ? 'Everyone' : (teams.data?.items.find((t) => t.id === id)?.name ?? fallback ?? id);
    return users.data?.find((u) => u.id === id)?.name ?? fallback ?? id;
  };
}

export function teamCountOf(teams: ReturnType<typeof useTeams>['data'], id: string): number {
  return teams?.items.find((t) => t.id === id)?.member_count ?? 0;
}

/** Why a user has their role on a folder, in one line (prototype explain). */
export function useExplain(folder: string | null, user?: string | null) {
  const pn = usePrincipalName();
  const q = useQuery({
    queryKey: ['access', folder, user ?? null],
    enabled: !!folder,
    queryFn: () => api.effective_access({ node: folder!, ...(user ? { user } : {}) }),
  });
  const d = q.data;
  let why = '';
  let r = 0;
  if (d) {
    r = ROLE_N[d.role];
    if (d.owner) why = 'Org owner';
    else if (!d.via.length) why = 'No grant';
    else {
      const best = [...d.via].sort((a, b) => ROLE_N[b.role] - ROLE_N[a.role])[0]!;
      why = pn(best.principal_type, best.principal_id) + ' on ' + best.folder_name;
    }
  }
  return { q, why, r };
}

export function useGrants(folder: string | null, enabled = true) {
  return useQuery({ queryKey: ['grants', folder], enabled: !!folder && enabled, queryFn: () => api.list_grants({ folder: folder! }) });
}

export function PAv({ type, id, name, s }: { type: 'user' | 'team'; id: string; name: string; s: number }): ReactElement | null {
  return type === 'user' ? <Av name={name} s={s} /> : <TeamAv id={id} name={name} s={s} />;
}

function AccessTab({ node }: { node: NodeT }): ReactElement {
  const folderId = node.kind === 'doc' ? node.parent_id : node.id;
  const folder = useNode(folderId);
  const me = useMe();
  const r = role(node);
  const ex = useExplain(folderId);
  const grants = useGrants(folderId, r >= 4);
  const teams = useTeams();
  const pn = usePrincipalName();
  const f = folder.data;
  const rows = [...(grants.data?.grants ?? [])].sort((a, b) => (a.inherited_from ? 1 : 0) - (b.inherited_from ? 1 : 0) || ROLE_N[b.role] - ROLE_N[a.role]);
  return (
    <>
      <div className="prow" style={{ marginBottom: 6 }}>
        <Av name={me.data?.user.name} s={28} />
        <div className="grow">
          <div className="pn">You</div>
          <div className="ps">{ex.why}</div>
        </div>
        <span className="chip acc">
          <Ic n={RICON[r] ?? 'ban'} s={12} />
          {ROLES[r]}
        </span>
      </div>
      {r >= 4 && f ? (
        <>
          <div className="sec row-flex" style={{ justifyContent: 'space-between' }}>
            <span className="row-flex">
              <Ic n="folder" s={13} />
              {f.name}
            </span>
            {f.inherit === false ? (
              <span data-tip="Not inheriting">
                <Ic n="link-off" s={13} />
              </span>
            ) : null}
          </div>
          {rows.map((g) => {
            const name = pn(g.principal_type, g.principal_id, g.principal_name);
            return (
              <div key={g.id} className={'prow' + (g.inherited_from ? ' inh' : '')}>
                <PAv type={g.principal_type} id={g.principal_id} name={name} s={28} />
                <div className="grow">
                  <div className="pn">{name}</div>
                  <div className="ps">
                    {g.inherited_from ? 'from ' + (g.inherited_from.name ?? '') : g.principal_type === 'team' ? teamCountOf(teams.data, g.principal_id) + ' members' : (g.principal_email ?? '')}
                  </div>
                </div>
                <span className="rl">{ROLES[ROLE_N[g.role]]}</span>
              </div>
            );
          })}
          <div style={{ padding: '10px 8px' }}>
            <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setUI({ modal: { type: 'share', id: f.id } })}>
              <Ic n="user-plus" s={15} />
              <span>Share</span>
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

export function useAudit(filters: { node?: string; actor?: string; op?: string; via?: 'ui' | 'rest' | 'mcp' | 'system'; from?: number }, enabled = true, limit = 100) {
  return useQuery({ queryKey: ['audit', filters, limit], enabled, queryFn: () => api.list_audit({ ...filters, limit }) });
}

function ActivityTab({ node }: { node: NodeT }): ReactElement {
  const q = useAudit({ node: node.id }, true, 40);
  const rows = q.data?.items ?? [];
  if (!rows.length) return <Empty icon="activity" pad="40px 0" eic={false} />;
  return (
    <>
      {rows.map((a) => (
        <div key={a.id} className="arow">
          <span className={'aic ' + (a.ok ? (a.op === 'publish_version' || a.op === 'publish_skill' ? 'ok' : a.op === 'commit_version' ? 'acc' : '') : 'bad')}>
            <Ic n={a.ok ? (OPI[a.op] ?? 'activity') : 'ban'} s={14} />
          </span>
          <div className="grow">
            <div style={{ fontSize: 13 }} className="ell">
              <b style={{ fontWeight: 500 }}>{(a.actor_name ?? 'System').split(' ')[0]}</b>{' '}
              <span className="muted">
                {OPL[a.op] ?? a.op}
                {a.version ? ' v' + a.version : ''}
              </span>
            </div>
            <div className="hs">
              <span data-tip={(VIA[a.via] ?? VIA['ui']!)[1] + (a.client ? ': ' + a.client : '')} style={{ display: 'inline-flex' }}>
                <Ic n={(VIA[a.via] ?? VIA['ui']!)[0]} s={12} />
              </span>
              {a.client ? a.client + ' · ' : ''}
              {ago(a.ts)}
              {a.ok ? null : (
                <>
                  {' · '}
                  <span style={{ color: 'var(--danger)' }}>{String((a.detail as Record<string, unknown> | null)?.['code'] ?? 'failed')}</span>
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export function drawerTabs(node: NodeT, owner: boolean): [DrawerTab, string, string][] {
  const r = role(node);
  const tabs: [DrawerTab, string, string][] = [];
  if (node.kind === 'doc') tabs.push(['links', 'graph', 'Links']);
  if (node.kind === 'doc' && r >= 2) tabs.push(['history', 'history', 'History']);
  tabs.push(['access', 'users', 'Access']);
  // list_audit is an owner operation, so Activity is shown to owners (DECISIONS).
  if (r >= 2 && owner) tabs.push(['activity', 'activity', 'Activity']);
  return tabs;
}

export function DrawerContent({ id }: { id: string }): ReactElement | null {
  const nq = useNode(id);
  const me = useMe();
  const want = useUI((s) => s.drawer);
  const node = nq.data;
  if (!node) return null;
  const tabs = drawerTabs(node, me.data?.user.org_role === 'owner');
  let tab = want ?? tabs[0]![0];
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0]![0];
  return (
    <>
      <div className="dtabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t[0]}
            className={'t' + (t[0] === tab ? ' on' : '')}
            role="tab"
            aria-selected={t[0] === tab}
            aria-label={t[2]}
            data-tip={t[0] === tab ? undefined : t[2]}
            onClick={() => setUI({ drawer: t[0] })}
          >
            <Ic n={t[1]} s={16} />
            <span>{t[2]}</span>
          </button>
        ))}
        <div className="grow" />
        <IB className="ib sm" icon="x" s={16} tip="Close" onClick={() => setUI({ drawer: null })} />
      </div>
      <div className="drawer-body">
        <Fragment key={tab + id}>
          {tab === 'links' ? <LinksTab node={node} /> : tab === 'history' ? <HistoryTab node={node} /> : tab === 'access' ? <AccessTab node={node} /> : <ActivityTab node={node} />}
        </Fragment>
      </div>
    </>
  );
}
