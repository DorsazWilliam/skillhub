import { useState, type ReactElement } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, uiOnly } from '../api/client';
import { useMe, useTeams, useUsers, invalidate, invalidateContent } from '../api/hooks';
import { Ic } from '../lib/icons';
import { ago, fmtTime, ROLES, RICON, ROLE_N, VIA, DAY } from '../lib/util';
import { Av, TeamAv, ClientAv, IB, Empty, Spinner, scopeChips } from '../ui/common';
import { Confirm, toast, errorToast, copyText } from '../ui/feedback';
import { setUI } from '../state';
import { navigate } from '../router';
import { goNode, restoreNode } from '../actions';
import { useAudit } from '../shell/Drawer';
import { SetupGuide, GuideButton, useGuideOn } from './SetupGuide';

/** Owner pages (GitHub org People and Teams), audit, tokens, connections and trash (prototype admin & settings). */

export async function setUserStatus(id: string, name: string, status: 'active' | 'suspended'): Promise<void> {
  try {
    await api.set_user_status({ user: id, status });
    invalidate('users');
    toast(name + (status === 'active' ? ' reactivated' : ' suspended'), { icon: status === 'active' ? 'check' : 'ban' });
  } catch (e) {
    errorToast(e);
  }
}

export function PeoplePage(): ReactElement {
  const me = useMe();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = users.data ?? [];
  const list = all.filter((u) => !q || ((u.name ?? '') + ' ' + (u.email ?? '')).toLowerCase().includes(q.toLowerCase()));
  const myId = me.data?.user.id;
  const bulk = async (status: 'active' | 'suspended'): Promise<void> => {
    for (const id of sel) await api.set_user_status({ user: id, status }).catch(errorToast);
    toast(sel.size + (status === 'suspended' ? ' suspended' : ' reactivated'), { icon: status === 'suspended' ? 'ban' : 'check' });
    setSel(new Set());
    invalidate('users');
  };
  const selectable = list.filter((u) => u.id !== myId);
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>
          People <span className="count">{all.length}</span>
        </h1>
        <div className="grow" />
        <div className="qwrap">
          <Ic n="search" s={15} />
          <input className="input" id="people-q" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        </div>
      </div>
      {sel.size ? (
        <div className="bulk">
          <span className="grow">{sel.size} selected</span>
          <button className="btn sm" onClick={() => void bulk('suspended')}>
            <Ic n="ban" s={13} />
            <span>Suspend</span>
          </button>
          <button className="btn sm" onClick={() => void bulk('active')}>
            <Ic n="check" s={13} />
            <span>Reactivate</span>
          </button>
          <button className="btn sm" aria-label="Clear" onClick={() => setSel(new Set())}>
            <Ic n="x" s={13} />
          </button>
        </div>
      ) : null}
      {users.isLoading ? (
        <Spinner />
      ) : (
        <div className="tw-scroll">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    className="cb"
                    aria-label="Select all"
                    checked={!!sel.size && sel.size === selectable.length}
                    onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((u) => u.id)) : new Set())}
                  />
                </th>
                <th>Name</th>
                <th>Teams</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => {
                const self = u.id === myId;
                const name = u.name ?? u.email ?? u.id;
                return (
                  <tr key={u.id} className={sel.has(u.id) ? 'selr' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        className="cb"
                        aria-label="Select"
                        disabled={self}
                        checked={sel.has(u.id)}
                        onChange={(e) =>
                          setSel((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(u.id);
                            else n.delete(u.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <div className="row-flex">
                        <Av name={name} s={30} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 500 }}>
                            {name}
                            {self ? (
                              <>
                                {' '}
                                <span className="faint" style={{ fontWeight: 400 }}>
                                  you
                                </span>
                              </>
                            ) : null}
                          </div>
                          <div className="muted ell" style={{ fontSize: 12.5 }}>
                            {u.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="row-flex" style={{ flexWrap: 'wrap', gap: 4 }}>
                        {u.teams?.length ? (
                          u.teams.map((t) => (
                            <span key={t.id} className="chip">
                              {t.name}
                            </span>
                          ))
                        ) : (
                          <span className="faint">-</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select bare"
                        aria-label="Role"
                        disabled={self}
                        value={u.org_role ?? 'member'}
                        onChange={async (e) => {
                          const role = e.target.value as 'owner' | 'member';
                          try {
                            await api.set_user_role({ user: u.id, role });
                            invalidate('users');
                            toast(name + ' is now ' + (role === 'owner' ? 'an owner' : 'a member'), { icon: 'crown' });
                          } catch (err) {
                            errorToast(err);
                          }
                        }}
                      >
                        <option value="member">Member</option>
                        <option value="owner">Owner</option>
                      </select>
                    </td>
                    <td>
                      {u.status !== 'suspended' ? (
                        <span className="row-flex" style={{ gap: 6 }}>
                          <span className="stat-dot on" />
                          Active
                        </span>
                      ) : (
                        <span className="chip bad">
                          <Ic n="ban" s={11} />
                          Suspended
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {ago(u.last_login_at)}{' '}
                      {self ? null : u.status !== 'suspended' ? (
                        <Confirm className="ib xs" label="Suspend" tip="Suspend" style={{ float: 'right' }} onConfirm={() => void setUserStatus(u.id, name, 'suspended')}>
                          <Ic n="ban" s={14} />
                        </Confirm>
                      ) : (
                        <IB className="ib xs" icon="undo" s={14} tip="Reactivate" onClick={() => void setUserStatus(u.id, name, 'active')} data-float="right" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function useTeamDetails(ids: string[]) {
  const members = useQueries({ queries: ids.map((id) => ({ queryKey: ['teamMembers', id], queryFn: () => api.list_team_members({ team: id, limit: 100 }) })) });
  const access = useQueries({ queries: ids.map((id) => ({ queryKey: ['teamAccess', id], queryFn: () => api.list_team_access({ team: id }) })) });
  return { members, access };
}

export async function createTeam(name: string): Promise<string | null> {
  const nm = name.trim();
  if (!nm) return null;
  try {
    const t = await api.create_team({ name: nm });
    invalidate('teams');
    return t.id;
  } catch (e) {
    toast(e instanceof Error && /exists|taken|unique/i.test(e.message) ? 'Name taken' : e instanceof Error ? e.message : 'Failed', { icon: 'alert', kind: 'bad' });
    return null;
  }
}

export function TeamsPage(): ReactElement {
  const teams = useTeams();
  const users = useUsers();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const list = (teams.data?.items ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  const { members, access } = useTeamDetails(list.map((t) => t.id));
  const active = (users.data ?? []).filter((u) => u.status !== 'suspended');
  const create = async (): Promise<void> => {
    const id = await createTeam(name);
    if (id) {
      setAdding(false);
      navigate('/teams/' + id);
    }
  };
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>
          Teams <span className="count">{teams.data?.items.length ?? ''}</span>
        </h1>
        <div className="grow" />
        <div className="qwrap">
          <Ic n="search" s={15} />
          <input className="input" id="teams-q" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        </div>
        <button
          className="btn primary"
          onClick={() => {
            setAdding(true);
            setName('');
          }}
        >
          <Ic n="plus" s={15} />
          <span>Team</span>
        </button>
      </div>
      {adding ? (
        <div className="card row-flex" style={{ marginBottom: 12 }}>
          <TeamAv id="x" name="x" s={30} />
          <input
            className="input grow"
            id="newteam"
            placeholder="Team name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button className="btn primary" onClick={() => void create()}>
            <Ic n="check" s={15} />
            <span>Create</span>
          </button>
          <IB icon="x" s={16} tip="Cancel" onClick={() => setAdding(false)} />
        </div>
      ) : null}
      <div className="tw-scroll">
        <table className="t">
          <thead>
            <tr>
              <th>Team</th>
              <th>Members</th>
              <th>Folders</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t, i) => {
              const ev = t.id === 'everyone';
              const mem = ev ? active.map((u) => u.name ?? u.email ?? '') : (members[i]?.data?.items ?? []).map((m) => m.name ?? m.email ?? '');
              return (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/teams/' + t.id)}>
                  <td>
                    <div className="row-flex">
                      <TeamAv id={t.id} name={t.name} s={30} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }} className="row-flex">
                          {ev ? 'Everyone' : t.name}
                          {t.builtin ? (
                            <span className="faint" data-tip="Built in">
                              <Ic n="lock" s={12} />
                            </span>
                          ) : null}
                        </div>
                        <div className="muted ell" style={{ fontSize: 12.5 }}>
                          {t.description ?? ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="row-flex">
                      <span className="stack">
                        {mem.slice(0, 4).map((n, j) => (
                          <Av key={j} name={n} s={22} />
                        ))}
                      </span>
                      <span className="num">{ev ? mem.length : t.member_count}</span>
                    </div>
                  </td>
                  <td className="num">{access[i]?.data?.items.length ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TeamBody({ id, tab, mobile }: { id: string; tab: 'members' | 'folders' | 'settings'; mobile?: boolean }): ReactElement {
  const teams = useTeams();
  const t = teams.data?.items.find((x) => x.id === id);
  const ev = id === 'everyone';
  const users = useUsers();
  const mem = useQuery({ queryKey: ['teamMembers', id], queryFn: () => api.list_team_members({ team: id, limit: 100 }) });
  const acc = useQuery({ queryKey: ['teamAccess', id], queryFn: () => api.list_team_access({ team: id }) });
  const [addQ, setAddQ] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  const members = ev
    ? (users.data ?? []).filter((u) => u.status !== 'suspended').map((u) => ({ id: u.id, name: u.name, email: u.email, role: 'member' as const }))
    : (mem.data?.items ?? []);
  const refresh = (): void => invalidate('teamMembers', 'teams', 'users');
  if (tab === 'members')
    return (
      <>
        {ev ? null : (
          <div className="addrow" style={{ marginBottom: 12, maxWidth: 420 }}>
            <div className="qwrap" style={{ maxWidth: 'none' }}>
              <Ic n="user-plus" s={15} />
              <input className="input" id="add-member-q" placeholder="Add member" value={addQ} autoComplete="off" onChange={(e) => setAddQ(e.target.value)} />
            </div>
            {addQ ? (
              <div className="sugg">
                {(() => {
                  const c = (users.data ?? []).filter((u) => !members.some((m) => m.id === u.id) && ((u.name ?? '') + (u.email ?? '')).toLowerCase().includes(addQ.toLowerCase()));
                  return c.length ? (
                    c.map((u) => (
                      <button
                        key={u.id}
                        className="mi"
                        onClick={async () => {
                          try {
                            await api.add_team_member({ team: id, user: u.id, role: 'member' });
                            toast((u.name ?? '') + ' added', { icon: 'user-plus' });
                            setAddQ('');
                            refresh();
                          } catch (e) {
                            errorToast(e);
                          }
                        }}
                      >
                        <Av name={u.name} s={22} />
                        <span>{u.name}</span>
                        <span className="r">{u.email}</span>
                      </button>
                    ))
                  ) : (
                    <div className="mi faint">No one</div>
                  );
                })()}
              </div>
            ) : null}
          </div>
        )}
        <div className="tw-scroll">
          <table className="t">
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="row-flex">
                      <Av name={m.name ?? m.email} s={28} />
                      <div>
                        <div style={{ fontWeight: 500 }}>{m.name}</div>
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {m.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ width: mobile ? undefined : 160 }}>
                    {ev ? (
                      <span className="faint">Member</span>
                    ) : (
                      <select
                        className="select bare"
                        aria-label="Team role"
                        value={m.role}
                        onChange={async (e) => {
                          const role = e.target.value as 'member' | 'maintainer';
                          try {
                            await api.add_team_member({ team: id, user: m.id, role });
                            toast((m.name ?? '').split(' ')[0] + ' is ' + role, { icon: 'check' });
                            refresh();
                          } catch (err) {
                            errorToast(err);
                          }
                        }}
                      >
                        <option value="member">Member</option>
                        <option value="maintainer">Maintainer</option>
                      </select>
                    )}
                  </td>
                  <td style={{ width: 44 }}>
                    {ev ? null : (
                      <Confirm
                        className="ib xs"
                        label="Remove"
                        tip="Remove"
                        onConfirm={async () => {
                          try {
                            await api.remove_team_member({ team: id, user: m.id });
                            refresh();
                            toast((m.name ?? '') + ' removed', {
                              icon: 'user-minus',
                              undo: async () => {
                                await api.add_team_member({ team: id, user: m.id, role: m.role }).catch(errorToast);
                                refresh();
                              },
                            });
                          } catch (e) {
                            errorToast(e);
                          }
                        }}
                      >
                        <Ic n="x" s={14} />
                      </Confirm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  if (tab === 'folders') {
    const items = acc.data?.items ?? [];
    return items.length ? (
      <div className="tw-scroll">
        <table className="t">
          <tbody>
            {items.map((g) => (
              <tr key={g.folder.id} style={{ cursor: 'pointer' }} onClick={() => void goNode(g.folder.id)}>
                <td>
                  <div className="row-flex">
                    <Ic n="folder" s={16} />
                    <span>{g.folder.path}</span>
                  </div>
                </td>
                <td style={{ width: 140 }}>
                  <span className="chip">
                    <Ic n={RICON[ROLE_N[g.role]] ?? 'eye'} s={12} />
                    {ROLES[ROLE_N[g.role]]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="empty">
        <Ic n="folder" s={22} />
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 480 }}>
      <div className="field">
        <label htmlFor="team-name">Name</label>
        <input className="input" id="team-name" value={name ?? t?.name ?? ''} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="team-desc">Description</label>
        <textarea className="input" id="team-desc" rows={2} value={desc ?? t?.description ?? ''} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <button
        className="btn primary"
        onClick={async () => {
          try {
            await api.rename_team({ team: id, ...(name != null ? { name: name.trim() || t?.name } : {}), ...(desc != null ? { description: desc.trim() } : {}) });
            invalidate('teams');
            toast('Saved', { icon: 'check' });
          } catch (e) {
            errorToast(e);
          }
        }}
      >
        <Ic n="check" s={15} />
        <span>Save</span>
      </button>
      <div className="danger-zone">
        <div className="grow">
          <div style={{ fontWeight: 500 }}>Delete team</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Removes its grants on {acc.data?.items.length ?? 0} folders
          </div>
        </div>
        <Confirm
          className="btn danger"
          onConfirm={async () => {
            try {
              await api.delete_team({ team: id });
              invalidate('teams');
              invalidateContent();
              toast('Deleted ' + (t?.name ?? ''), { icon: 'trash' });
              navigate('/teams');
            } catch (e) {
              errorToast(e);
            }
          }}
        >
          <Ic n="trash" s={14} />
          <span>Delete</span>
        </Confirm>
      </div>
    </div>
  );
}

export function TeamPage({ id }: { id: string }): ReactElement {
  const teams = useTeams();
  const t = teams.data?.items.find((x) => x.id === id);
  const [tab, setTab] = useState<'members' | 'folders' | 'settings'>('members');
  const mem = useQuery({ queryKey: ['teamMembers', id], queryFn: () => api.list_team_members({ team: id, limit: 100 }) });
  const acc = useQuery({ queryKey: ['teamAccess', id], queryFn: () => api.list_team_access({ team: id }) });
  const users = useUsers();
  const ev = id === 'everyone';
  if (!t) return <div className="page wide">{teams.isLoading ? <Spinner /> : <Empty icon="users" />}</div>;
  const count = ev ? (users.data ?? []).filter((u) => u.status !== 'suspended').length : (mem.data?.items.length ?? t.member_count);
  return (
    <div className="page wide">
      <div className="ph1">
        <IB icon="back" tip="Teams" onClick={() => navigate('/teams')} />
        <TeamAv id={t.id} name={t.name} s={36} />
        <div>
          <h1 style={{ fontSize: 22 }}>{ev ? 'Everyone' : t.name}</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {t.description ?? ''}
          </div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button className={tab === 'members' ? 'on' : ''} role="tab" aria-selected={tab === 'members'} onClick={() => setTab('members')}>
          <Ic n="users" s={15} />
          Members <span className="cnt">{count}</span>
        </button>
        <button className={tab === 'folders' ? 'on' : ''} role="tab" aria-selected={tab === 'folders'} onClick={() => setTab('folders')}>
          <Ic n="folder" s={15} />
          Folders <span className="cnt">{acc.data?.items.length ?? ''}</span>
        </button>
        {ev ? null : (
          <button className={tab === 'settings' ? 'on' : ''} role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
            <Ic n="cog" s={15} />
            Settings
          </button>
        )}
      </div>
      <TeamBody id={id} tab={tab} />
    </div>
  );
}

export type AuditF = { actor: string; op: string; via: '' | 'ui' | 'rest' | 'mcp'; range: '24h' | '7d' | '30d' | 'all'; q: string };
const RANGE: Record<AuditF['range'], number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: 1e15 };

export function useAuditRows(F: AuditF, limit = 300) {
  // The range is coarse (minute) so the query key is stable while the page is open.
  const from = F.range === 'all' ? undefined : Math.floor((Date.now() - RANGE[F.range]) / 60000) * 60000;
  const q = useAudit({ ...(F.actor ? { actor: F.actor } : {}), ...(F.op ? { op: F.op } : {}), ...(F.via ? { via: F.via } : {}), ...(from ? { from } : {}) }, true, limit);
  const ql = F.q.toLowerCase();
  const rows = (q.data?.items ?? []).filter((a) => !ql || (a.node_name ?? '').toLowerCase().includes(ql));
  return { q, rows };
}

export function auditCsv(rows: ReturnType<typeof useAuditRows>['rows'], email: (id: string | null) => string): string {
  const q = (s: unknown): string => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  return (
    'ts,actor,via,client,op,node,version,ok\n' +
    rows.map((a) => [new Date(a.ts).toISOString(), email(a.actor_id), a.via, a.client ?? '', a.op, a.node_name ?? '', a.version ?? '', a.ok ? 1 : 0].map(q).join(',')).join('\n')
  );
}

export function AuditPage(): ReactElement {
  const [F, setF] = useState<AuditF>({ actor: '', op: '', via: '', range: '7d', q: '' });
  const users = useUsers();
  const { q, rows } = useAuditRows(F);
  const ops = [...new Set((q.data?.items ?? []).map((a) => a.op).concat(F.op ? [F.op] : []))].sort();
  const email = (id: string | null): string => users.data?.find((u) => u.id === id)?.email ?? '';
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>
          Audit <span className="count">{rows.length}</span>
        </h1>
        <div className="grow" />
        <button className="btn" onClick={() => setUI({ modal: { type: 'csv', csv: auditCsv(rows, email), n: rows.length } })}>
          <Ic n="download" s={15} />
          <span>CSV</span>
        </button>
      </div>
      <div className="bar">
        <div className="qwrap">
          <Ic n="folder" s={15} />
          <input className="input" id="audit-q" placeholder="Path" value={F.q} onChange={(e) => setF({ ...F, q: e.target.value })} aria-label="Path" />
        </div>
        <select className="select" aria-label="Person" value={F.actor} onChange={(e) => setF({ ...F, actor: e.target.value })}>
          <option value="">Anyone</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Operation" value={F.op} onChange={(e) => setF({ ...F, op: e.target.value })}>
          <option value="">Any operation</option>
          {ops.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="Source">
          {(
            [
              ['', 'All'],
              ['ui', 'Web'],
              ['rest', 'API'],
              ['mcp', 'Agent'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={F.via === v ? 'on' : ''} aria-label={l} data-tip={l} onClick={() => setF({ ...F, via: v })}>
              {v ? <Ic n={VIA[v]![0]} s={14} /> : 'All'}
            </button>
          ))}
        </div>
        <div className="seg">
          {(['24h', '7d', '30d', 'all'] as const).map((r) => (
            <button key={r} className={F.range === r ? 'on' : ''} aria-label={r === 'all' ? 'All time' : r} onClick={() => setF({ ...F, range: r })}>
              {r === 'all' ? <Ic n="clock" s={14} /> : r}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="tw-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th />
                <th>Operation</th>
                <th>Target</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 120).map((a) => (
                <tr key={a.id}>
                  <td className="num mono" style={{ fontSize: 12 }}>
                    {fmtTime(a.ts)}
                  </td>
                  <td>
                    <div className="row-flex">
                      <Av name={a.actor_name} s={20} />
                      <span className="ell">{a.actor_name ?? ''}</span>
                    </div>
                  </td>
                  <td>
                    <span className="faint" data-tip={(VIA[a.via] ?? VIA['ui']!)[1] + (a.client ? ': ' + a.client : '')} style={{ display: 'inline-flex' }}>
                      <Ic n={(VIA[a.via] ?? VIA['ui']!)[0]} s={14} />
                    </span>
                  </td>
                  <td>
                    <code style={{ fontSize: 12 }}>{a.op}</code>
                    {a.version ? <span className="faint"> v{a.version}</span> : null}
                  </td>
                  <td className="ell" style={{ maxWidth: 280 }}>
                    {a.node_name ? a.node_name : <span className="muted">{detailText(a.detail)}</span>}
                  </td>
                  <td>
                    {a.ok ? (
                      <span style={{ color: 'var(--ok)' }}>
                        <Ic n="check" s={14} />
                      </span>
                    ) : (
                      <span style={{ color: 'var(--danger)' }} data-tip={detailText(a.detail) || 'Failed'}>
                        <Ic n="ban" s={14} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const c = d['code'] ?? d['error'] ?? d['detail'];
  if (typeof c === 'string') return c;
  return '';
}

export function useTokens() {
  return useQuery({ queryKey: ['tokens'], queryFn: () => api.list_api_tokens({}) });
}

export async function revokeToken(id: string, name: string): Promise<void> {
  try {
    await uiOnly.revoke_api_token({ id });
    invalidate('tokens');
    toast('Revoked ' + name, { icon: 'key' });
  } catch (e) {
    errorToast(e);
  }
}

export function TokensPage(): ReactElement {
  const t = useTokens();
  const items = (t.data?.items ?? []).filter((x) => !x.revoked_at);
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>API tokens</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setUI({ modal: { type: 'mint' } })}>
          <Ic n="plus" s={15} />
          <span>Token</span>
        </button>
      </div>
      {t.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <div className="tw-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div className="row-flex">
                      <Ic n="key" s={15} />
                      <span style={{ fontWeight: 500 }}>{k.name}</span>
                    </div>
                  </td>
                  <td>{scopeChips(k.scopes)}</td>
                  <td className="num">{k.last_used_at ? ago(k.last_used_at) : '-'}</td>
                  <td className="num">{k.expires_at ? new Date(k.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}</td>
                  <td style={{ width: 44 }}>
                    <Confirm className="ib xs" label="Revoke" tip="Revoke" onConfirm={() => void revokeToken(k.id, k.name)}>
                      <Ic n="trash" s={14} />
                    </Confirm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="key" />
      )}
    </div>
  );
}

export function useConns() {
  return useQuery({ queryKey: ['conns'], queryFn: () => api.list_mcp_connections({}) });
}

export async function revokeConn(id: string, name: string): Promise<void> {
  try {
    await uiOnly.revoke_mcp_connection({ id });
    invalidate('conns');
    toast(name + ' disconnected', { icon: 'plug' });
  } catch (e) {
    errorToast(e);
  }
}

export const connName = (c: { client_name: string | null; client_id: string }): string => c.client_name ?? c.client_id;

export function ConnectionsPage(): ReactElement {
  const me = useMe();
  const c = useConns();
  const url = me.data?.mcp_url ?? '';
  const items = c.data?.items ?? [];
  const guide = useGuideOn();
  return (
    <div className="page wide">
      <div className="ph1">
        <h1>Connections</h1>
        <div className="grow" />
        <GuideButton />
      </div>
      {guide ? <SetupGuide /> : null}
      <div className="connect" hidden={guide}>
        <span className="cic">
          <Ic n="plug" s={19} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>MCP server</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Claude, ChatGPT, Copilot Studio
          </div>
        </div>
        <div className="urlbox">
          <span id="mcp-url">{url}</span>
          <IB className="ib sm" icon="copy" s={15} tip="Copy" onClick={() => copyText(url)} />
        </div>
      </div>
      {c.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <div className="tw-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>Client</th>
                <th>Scopes</th>
                <th>Expires</th>
                <th>Connected</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <div className="row-flex">
                      <ClientAv name={connName(x)} />
                      <span style={{ fontWeight: 500 }}>{connName(x)}</span>
                    </div>
                  </td>
                  <td>{scopeChips(x.scopes)}</td>
                  <td className="num">{x.expires_at ? ago(x.expires_at) : '-'}</td>
                  <td className="num">{ago(x.created_at)}</td>
                  <td style={{ width: 44 }}>
                    <Confirm className="ib xs" label="Revoke" tip="Revoke" onConfirm={() => void revokeConn(x.id, connName(x))}>
                      <Ic n="trash" s={14} />
                    </Confirm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="plug" />
      )}
    </div>
  );
}

export function useTrash() {
  return useQuery({ queryKey: ['trash'], queryFn: () => api.list_trash({ limit: 100 }) });
}

export function TrashPage(): ReactElement {
  const t = useTrash();
  const items = t.data?.items ?? [];
  return (
    <div className="page">
      <div className="ph1">
        <h1>
          <Ic n="trash" s={20} /> Trash
        </h1>
      </div>
      {t.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <div className="items">
          {items.map((n) => (
            <div key={n.id} className="item" style={{ gridTemplateColumns: '20px minmax(0,1fr) auto 32px', cursor: 'default' }}>
              <span className="faint">
                <Ic n={n.kind === 'folder' ? 'folder' : 'file'} s={17} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="t ell">{n.name}</div>
              </div>
              <span className="w">{ago(n.deleted_at)}</span>
              <IB className="ib xs" icon="undo" s={14} tip="Restore" onClick={() => void restoreNode(n.id, n.name)} />
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="trash" />
      )}
    </div>
  );
}
