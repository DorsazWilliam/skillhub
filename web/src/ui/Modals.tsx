import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, uiOnly } from '../api/client';
import { useNode, useVersions, useWarnings, useUsers, useTeams, useMe, useSkill, usePrototype, fetchChildren, invalidate, invalidateContent, role, qc, type NodeT, type Item } from '../api/hooks';
import { Ic } from '../lib/icons';
import { ROLES, RICON, ROLE_N, ROLE_KEY, SCOPES, areaKey } from '../lib/util';
import { Av, IB, Empty, nodeIcon } from './common';
import { Confirm, toast, errorToast, copyText } from './feedback';
import { setUI, useUI, getUI, toggleTheme, type Modal } from '../state';
import { doCommit, publishVersion, unpublish, publishSkill, publishPrototype, moveNode, renameNode, exportTree, goNode, openCommit, editorCtl, isMobile } from '../actions';
import { navigate } from '../router';
import { DiffTable, Stat, parsePatch, addAll, type Op } from './diff';
import { pendingFiles } from '../pages/docModel';
import { usePrincipalName, useExplain, useGrants, teamCountOf, PAv } from '../shell/Drawer';
import { canDrop } from '../shell/Tree';
import { useDebounced } from '../shell/search';

/** Dialogs (prototype modalHtml). Centered on desktop, bottom sheets with detents on the phone. */

const closeModal = (): void => setUI({ modal: null });

function CloseBtn(): ReactElement {
  return <IB className="ib sm" icon="x" s={16} tip="Close" onClick={closeModal} />;
}

function Wrap({ size, children, label, detent }: { size?: 'lg' | 'sm' | 'pal' | ''; children: ReactNode; label?: string; detent?: boolean }): ReactElement {
  const det = useUI((s) => s.det);
  const mob = isMobile();
  const cls = 'modal' + (size ? ' ' + size : '') + (mob && detent ? ' detent' + (det !== 'm' ? ' l' : '') : '');
  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={closeModal} />
      <div className={cls} role="dialog" aria-label={label}>
        {mob ? <div className="grab" aria-label="Resize" role="button" onClick={() => setUI((s) => ({ det: s.det === 'l' ? 'm' : 'l' }))} /> : null}
        {children}
      </div>
    </div>
  );
}

/** Diff between two sides of a document, through diff_versions (or one version against nothing). */
export function useDiff(doc: string | null, from: number | 'draft' | 'published' | 'head', to: number | 'draft' | 'published' | 'head', enabled = true) {
  return useQuery({
    queryKey: ['diff', doc, from, to],
    enabled: !!doc && enabled,
    queryFn: async (): Promise<{ ops: Op[]; add: number; del: number }> => {
      if (from === 0) {
        const text = to === 'draft' ? ((await api.get_draft({ doc: doc! })).draft?.content ?? '') : typeof to === 'number' ? (await api.get_version({ doc: doc!, version: to })).content : '';
        const ops = text ? addAll(text) : [];
        return { ops, add: ops.length, del: 0 };
      }
      const d = await api.diff_versions({ doc: doc!, from, to });
      return { ops: parsePatch(d.patch), add: d.added, del: d.removed };
    },
  });
}

function Palette({ m }: { m: Extract<Modal, { type: 'palette' }> }): ReactElement {
  const me = useMe();
  const recent = useUI((s) => s.recent);
  const q = useDebounced(m.q.trim(), 120);
  const res = useQuery({ queryKey: ['search', 'pal', q], enabled: !!q, queryFn: () => api.search({ q, limit: 12 }) });
  const owner = me.data?.user.org_role === 'owner';
  const ql = m.q.toLowerCase().trim();
  const acts: [string, string, () => void][] = [
    ['graph', 'Graph', () => navigate('/graph')],
    ['moon', 'Toggle theme', toggleTheme],
    ['key', 'API tokens', () => navigate('/settings/tokens')],
    ['plug', 'Connections', () => navigate('/settings/connections')],
  ];
  if (owner) acts.push(['user', 'People', () => navigate('/people')], ['users', 'Teams', () => navigate('/teams')], ['activity', 'Audit', () => navigate('/audit')]);
  type It = { icon: string; area: string | null; label: string; sub: string; go: () => void };
  const items: It[] = [];
  if (!ql) {
    for (const id of recent) {
      const n = qc.getQueryData<NodeT>(['node', id]);
      if (n) items.push({ icon: nodeIcon(n), area: areaKey(n.area), label: n.name === 'SKILL.md' ? (n.path.split('/').slice(-2)[0] ?? n.name) : n.name, sub: n.path.split('/').filter(Boolean).slice(0, -1).join(' / '), go: () => void goNode(n.id) });
    }
  } else {
    for (const h of res.data?.items ?? []) {
      const n = h.node;
      if (n.name === 'SKILL.md') continue;
      items.push({ icon: nodeIcon(n), area: areaKey(n.area), label: n.name, sub: n.path.split('/').filter(Boolean).slice(0, -1).join(' / '), go: () => void goNode(n.id) });
    }
    for (const [i, l, f] of acts) if (l.toLowerCase().includes(ql)) items.push({ icon: i, area: null, label: l, sub: '', go: f });
  }
  const list = items.slice(0, 12);
  const pick = (i: number): void => {
    const it = list[i];
    if (!it) return;
    setUI({ modal: null });
    it.go();
  };
  return (
    <Wrap size="pal" label="Quick open">
      <div className="pal-in">
        <Ic n="search" s={17} />
        <input
          id="pal"
          autoFocus
          value={m.q}
          placeholder="Jump to"
          autoComplete="off"
          onChange={(e) => setUI({ modal: { ...m, q: e.target.value, i: 0 } })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setUI({ modal: { ...m, i: Math.max(0, Math.min(list.length - 1, m.i + (e.key === 'ArrowDown' ? 1 : -1))) } });
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(m.i);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="pal-list">
        {list.length ? (
          list.map((it, i) => (
            <button key={i} className={'pi' + (i === m.i ? ' on' : '')} onClick={() => pick(i)}>
              <span className={it.area ? 'ac-' + it.area : ''}>
                <Ic n={it.icon} s={16} />
              </span>
              <span>{it.label}</span>
              <span className="ps">{it.sub}</span>
            </button>
          ))
        ) : (
          <div className="empty" style={{ padding: '24px 0' }}>
            <Ic n="search" s={18} />
          </div>
        )}
      </div>
    </Wrap>
  );
}

function CommitModal({ m }: { m: Extract<Modal, { type: 'commit' }> }): ReactElement {
  const n = useNode(m.id).data;
  const d = useDiff(m.id, 'head', 'draft');
  const w = useWarnings(m.id, 'draft');
  const head = n?.head_version ?? 0;
  const cp = role(n) >= 3;
  const chain = useSkill(m.id, 'draft');
  const skillId = chain.data?.skill_id ?? null;
  const lw = w.data?.warnings.length ?? 0;
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const go = (): void => void doCommit(m.id, msgRef.current?.value ?? '', m.pub, skillId);
  return (
    <Wrap label="Commit">
      <div className="mh">
        <h2>
          <Ic n="commit" s={17} />
          Commit v{head + 1}
        </h2>
        {lw ? (
          <span className="chip warn" data-tip="Fix or explain in the message">
            <Ic n="alert" s={11} />
            {lw}
          </span>
        ) : null}
        {d.data ? <Stat add={d.data.add} del={d.data.del} /> : null}
        <CloseBtn />
      </div>
      <div className="modal-body">
        <textarea
          className="input"
          id="commit-msg"
          ref={msgRef}
          rows={3}
          autoFocus
          placeholder="What changed?"
          style={{ width: '100%' }}
          defaultValue={m.msg}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              go();
            }
          }}
        />
        {cp ? (
          <label className="row-flex" style={{ marginTop: 12, cursor: 'pointer' }}>
            <span className="switch">
              <input type="checkbox" id="commit-pub" checked={m.pub} onChange={(e) => setUI({ modal: { ...m, pub: e.target.checked } })} />
              <span />
            </span>
            <Ic n="rocket" s={15} />
            <span>{skillId ? 'Publish skill' : 'Publish now'}</span>
          </label>
        ) : null}
      </div>
      <div className="mf">
        <span className="faint" style={{ fontSize: 12 }}>
          Ctrl Enter
        </span>
        <div className="grow" />
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" onClick={go}>
          <Ic n="commit" s={15} />
          <span>Commit</span>
        </button>
      </div>
    </Wrap>
  );
}

function PublishModal({ m }: { m: Extract<Modal, { type: 'publish' }> }): ReactElement {
  const n = useNode(m.id).data;
  const vs = useVersions(m.id);
  const p = n?.published_version ?? null;
  const v = m.v;
  const d = useDiff(m.id, p ? p : 0, v);
  return (
    <Wrap size="lg" label="Publish" detent>
      <div className="mh">
        <h2>
          <Ic n="rocket" s={17} />
          Publish
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="vchips">
          {(vs.data?.items ?? []).map((x) => (
            <button key={x.n} className={'vchip' + (x.n === v ? ' on' : '')} onClick={() => setUI({ modal: { ...m, v: x.n } })}>
              v{x.n}
              {x.n === p ? <Ic n="check" s={13} /> : null}
            </button>
          ))}
        </div>
        {n?.has_draft ? (
          <div className="note">
            <Ic n="alert" s={14} />
            <span className="grow">Draft changes are not included</span>
            <button className="btn sm" onClick={() => void openCommit(m.id)}>
              Commit
            </button>
          </div>
        ) : null}
        <div className="row-flex muted" style={{ fontSize: 12.5, margin: '6px 0 8px' }}>
          {p ? 'v' + p : <Ic n="eye-off" s={13} />}
          <Ic n="arrow" s={13} />v{v}
          <div className="grow" />
          {d.data ? <Stat add={d.data.add} del={d.data.del} /> : null}
        </div>
        {d.data ? <DiffTable ops={d.data.ops} /> : <Empty icon="loader" pad="30px 0" eic={false} />}
      </div>
      <div className="mf">
        {p ? (
          <Confirm className="btn ghost danger" tip="Unpublish" label="Unpublish" onConfirm={() => void unpublish(m.id)}>
            <Ic n="eye-off" s={15} />
          </Confirm>
        ) : null}
        <div className="grow" />
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={v === p} onClick={() => void publishVersion(m.id, v)}>
          <Ic n={v < (p ?? 0) ? 'undo' : 'rocket'} s={15} />
          <span>{v === p ? 'Published' : v < (p ?? 0) ? 'Roll back to v' + v : 'Publish v' + v}</span>
        </button>
      </div>
    </Wrap>
  );
}

function DiffModal({ m }: { m: Extract<Modal, { type: 'diff' }> }): ReactElement {
  const n = useNode(m.id).data;
  const vs = useVersions(m.id);
  const d = useDiff(m.id, m.a === 0 ? 0 : m.a, m.b);
  const opts: [string, string][] = [...(n?.has_draft ? [['draft', 'Draft'] as [string, string]] : []), ...(vs.data?.items ?? []).map((x) => [String(x.n), 'v' + x.n] as [string, string])];
  const sel = (val: number | 'draft', on: (v: number | 'draft') => void): ReactElement => (
    <select className="select" value={String(val)} onChange={(e) => on(e.target.value === 'draft' ? 'draft' : Number(e.target.value))} aria-label="Version">
      {opts.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
          {Number(v) === n?.published_version ? ' (published)' : ''}
        </option>
      ))}
    </select>
  );
  return (
    <Wrap size="lg" label="Compare" detent>
      <div className="mh">
        <h2>
          <Ic n="diff" s={17} />
          Compare
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          {m.a === 0 ? <span className="chip">Empty</span> : sel(m.a, (a) => setUI({ modal: { ...m, a } }))}
          <Ic n="arrow" s={14} />
          {sel(m.b, (b) => setUI({ modal: { ...m, b } }))}
          <div className="grow" />
          {d.data ? <Stat add={d.data.add} del={d.data.del} /> : null}
        </div>
        {d.data ? <DiffTable ops={d.data.ops} /> : <Empty icon="loader" pad="30px 0" eic={false} />}
      </div>
    </Wrap>
  );
}

function SkillPublishModal({ m }: { m: Extract<Modal, { type: 'skill-publish' }> }): ReactElement {
  const folder = useNode(m.id).data;
  // The same dialog publishes a skill or a prototype: both list their files with versions.
  const skill = useSkill(m.proto ? null : m.id, null);
  const proto = usePrototype(m.proto ? m.id : null);
  const head = m.proto ? proto : skill;
  const files = pendingFiles(m.proto ? (proto.data ? { files: proto.data.files } : undefined) : skill.data);
  const diffs = useQueries({
    queries: files.map((f) => ({
      queryKey: ['diff', f.id, f.published_version ?? 0, 'head'],
      queryFn: async () => {
        if (!f.published_version) {
          const v = await api.get_version({ doc: f.id, version: f.head_version ?? 1 });
          const ops = addAll(v.content);
          return { ops, add: ops.length, del: 0 };
        }
        const d = await api.diff_versions({ doc: f.id, from: 'published', to: 'head' });
        return { ops: parsePatch(d.patch), add: d.added, del: d.removed };
      },
    })),
  });
  const kids = useQuery({ queryKey: ['children', m.id], queryFn: () => fetchChildren(m.id) });
  const drafts = (kids.data ?? []).filter((k) => k.kind === 'doc' && k.has_draft).length;
  const openIdx = Math.max(0, files.findIndex((f) => f.id === m.open));
  const od = diffs[openIdx]?.data;
  return (
    <Wrap size="lg" label={m.proto ? 'Publish prototype' : 'Publish skill'} detent>
      <div className="mh">
        <h2>
          <span className={m.proto ? 'ac-protos' : 'ac-skills'}>
            <Ic n={m.proto ? 'app-window' : 'sparkles'} s={17} />
          </span>
          <span className="ell">{folder?.name ?? ''}</span>
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        {head.isLoading ? (
          <Empty icon="loader" pad="30px 0" eic={false} />
        ) : files.length ? (
          <>
            <div className="pfl">
              {files.map((f, i) => (
                <button key={f.id} className={'pf' + (i === openIdx ? ' on' : '')} onClick={() => setUI({ modal: { ...m, open: f.id } })}>
                  <Ic n={f.kind === 'file' ? 'file-code' : 'file'} s={15} />
                  <span className="grow ell" style={{ textAlign: 'left' }}>
                    {f.path}
                  </span>
                  <span className="pfv">
                    {f.published_version ? 'v' + f.published_version : <Ic n="plus" s={12} />}
                    <Ic n="arrow" s={12} />v{f.head_version}
                  </span>
                  {diffs[i]?.data ? <Stat add={diffs[i]!.data!.add} del={diffs[i]!.data!.del} /> : null}
                </button>
              ))}
            </div>
            {drafts ? (
              <div className="note">
                <Ic n="pencil" s={14} />
                <span className="grow">
                  {drafts} {drafts === 1 ? 'draft' : 'drafts'} not included
                </span>
              </div>
            ) : null}
            <div style={{ marginTop: 10 }}>{od ? <DiffTable ops={od.ops} /> : null}</div>
          </>
        ) : (
          <div className="empty" style={{ padding: '30px 0' }}>
            <Ic n="check" s={20} />
            <span>Up to date</span>
          </div>
        )}
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={!files.length} onClick={() => void (m.proto ? publishPrototype(m.id) : publishSkill(m.id))}>
          <Ic n="rocket" s={15} />
          <span>
            Publish {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        </button>
      </div>
    </Wrap>
  );
}

function ShareModal({ m }: { m: Extract<Modal, { type: 'share' }> }): ReactElement {
  const f = useNode(m.id).data;
  const parent = useNode(f?.parent_id ?? null).data;
  const grants = useGrants(m.id);
  const users = useUsers();
  const teams = useTeams();
  const pn = usePrincipalName();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<{ type: 'user' | 'team' | 'invite'; id: string } | null>(null);
  const [newRole, setNewRole] = useState(1);
  const [cq, setCq] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  const chk = useExplain(check ? m.id : null, check);
  const ql = q.toLowerCase();
  const cands = ql
    ? [
        ...(teams.data?.items ?? []).map((t) => ({ type: 'team' as const, id: t.id, name: t.id === 'everyone' ? 'Everyone' : t.name, sub: t.member_count + ' members' })),
        ...(users.data ?? []).filter((u) => u.status !== 'suspended').map((u) => ({ type: 'user' as const, id: u.id, name: u.name ?? u.email ?? u.id, sub: u.email ?? '' })),
      ]
        .filter((c) => (c.name + ' ' + c.sub).toLowerCase().includes(ql))
        .slice(0, 6)
    : [];
  // An email address with no account: offer an invitation (they get this folder when they sign in).
  const inviteEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim()) && !(users.data ?? []).some((u) => (u.email ?? '').toLowerCase() === ql.trim()) ? q.trim().toLowerCase() : null;
  const all = grants.data?.grants ?? [];
  const direct = all.filter((g) => !g.inherited_from);
  const inh = all.filter((g) => g.inherited_from);
  const refresh = (): void => {
    invalidate('grants', 'access', 'children', 'node', 'graph', 'teamAccess');
  };
  const grant = async (): Promise<void> => {
    if (!pick) return;
    if (pick.type === 'invite') {
      try {
        const r = await api.create_invitation({ email: pick.id, access: [{ folder: m.id, role: ROLE_KEY[newRole] as 'viewer' }] });
        if (r.emailed) toast('Invitation sent to ' + pick.id, { icon: 'user-plus' });
        else {
          copyText(r.link);
          toast('Invitation link copied', { icon: 'link', sub: 'Send it to ' + pick.id });
        }
        setPick(null);
        setQ('');
        invalidate('invitations');
      } catch (e) {
        errorToast(e);
      }
      return;
    }
    try {
      await api.grant_access({ folder: m.id, principal_type: pick.type, principal: pick.id, role: ROLE_KEY[newRole] as 'viewer' });
      toast('Shared with ' + pn(pick.type, pick.id), { icon: 'user-plus' });
      setPick(null);
      setQ('');
      refresh();
    } catch (e) {
      errorToast(e);
    }
  };
  const roleSel = (val: number, on: (v: string) => void, rm: boolean, style?: React.CSSProperties): ReactElement => (
    <select className="select bare" aria-label="Role" value={String(val)} onChange={(e) => on(e.target.value)} style={style}>
      {[1, 2, 3, 4].map((r) => (
        <option key={r} value={r}>
          {ROLES[r]}
        </option>
      ))}
      {rm ? (
        <>
          <option disabled>──────</option>
          <option value="remove">Remove</option>
        </>
      ) : null}
    </select>
  );
  const ckCands = cq && !check ? (users.data ?? []).filter((u) => ((u.name ?? '') + (u.email ?? '')).toLowerCase().includes(cq.toLowerCase())).slice(0, 5) : [];
  const checkUser = users.data?.find((u) => u.id === check);
  return (
    <Wrap label="Share">
      <div className="mh">
        <h2>
          <Ic n="folder" s={17} />
          <span className="ell">Share {f?.name ?? ''}</span>
        </h2>
        <IB className="ib sm" icon="link" s={16} tip="Copy link" onClick={() => copyText(window.location.origin + '/n/' + m.id)} />
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="addrow">
          {pick ? (
            <div className="picked">
              {pick.type === 'invite' ? <Ic n="user-plus" s={18} /> : <PAv type={pick.type} id={pick.id} name={pn(pick.type, pick.id)} s={24} />}
              <span className="grow ell">{pick.type === 'invite' ? 'Invite ' + pick.id : pn(pick.type, pick.id)}</span>
              <IB className="ib xs" icon="x" s={13} tip="Clear" onClick={() => setPick(null)} />
            </div>
          ) : (
            <input
              className="input"
              id="share-q"
              autoFocus={!isMobile()}
              placeholder="Add people or teams"
              value={q}
              autoComplete="off"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cands[0]) {
                  e.preventDefault();
                  setPick({ type: cands[0].type, id: cands[0].id });
                } else if (e.key === 'Enter' && inviteEmail) {
                  e.preventDefault();
                  setPick({ type: 'invite', id: inviteEmail });
                }
              }}
            />
          )}
          {roleSel(newRole, (v) => setNewRole(Number(v)), false, { border: '1px solid var(--border-2)', height: 34 })}
          <button className="btn primary" disabled={!pick} onClick={() => void grant()}>
            {pick?.type === 'invite' ? 'Invite' : 'Add'}
          </button>
          {(cands.length || inviteEmail) && !pick ? (
            <div className="sugg">
              {inviteEmail ? (
                <button className="mi" data-invite="1" onClick={() => setPick({ type: 'invite', id: inviteEmail })}>
                  <Ic n="user-plus" s={18} />
                  <span>Invite {inviteEmail}</span>
                  <span className="r">by email</span>
                </button>
              ) : null}
              {cands.map((c) => (
                <button key={c.type + c.id} className="mi" onClick={() => setPick({ type: c.type, id: c.id })}>
                  <PAv type={c.type} id={c.id} name={c.name} s={24} />
                  <span>{c.name}</span>
                  <span className="r">{c.sub}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="sec" style={{ marginLeft: 0 }}>
          People with access
        </div>
        {direct.map((g) => {
          const name = pn(g.principal_type, g.principal_id, g.principal_name);
          return (
            <div key={g.id} className="prow" style={{ paddingLeft: 0 }}>
              <PAv type={g.principal_type} id={g.principal_id} name={name} s={32} />
              <div className="grow">
                <div className="pn">{name}</div>
                <div className="ps">{g.principal_type === 'team' ? teamCountOf(teams.data, g.principal_id) + ' members' : (g.principal_email ?? '')}</div>
              </div>
              {roleSel(
                ROLE_N[g.role],
                async (v) => {
                  try {
                    if (v === 'remove') {
                      await api.revoke_access({ folder: m.id, principal_type: g.principal_type, principal_id: g.principal_id });
                      toast('Removed ' + name, {
                        icon: 'user-minus',
                        undo: async () => {
                          await api.grant_access({ folder: m.id, principal_type: g.principal_type, principal: g.principal_id, role: g.role }).catch(errorToast);
                          refresh();
                        },
                      });
                    } else await api.grant_access({ folder: m.id, principal_type: g.principal_type, principal: g.principal_id, role: ROLE_KEY[Number(v)] as 'viewer' });
                    refresh();
                  } catch (e) {
                    errorToast(e);
                  }
                },
                true,
              )}
            </div>
          );
        })}
        {inh.map((g) => {
          const name = pn(g.principal_type, g.principal_id, g.principal_name);
          return (
            <div key={g.id} className="prow inh" style={{ paddingLeft: 0 }} data-tip={'Change it on ' + (g.inherited_from?.name ?? '')}>
              <PAv type={g.principal_type} id={g.principal_id} name={name} s={32} />
              <div className="grow">
                <div className="pn">{name}</div>
                <div className="ps">from {g.inherited_from?.name ?? ''}</div>
              </div>
              <span className="rl" style={{ paddingRight: 10 }}>
                {ROLES[ROLE_N[g.role]]}
              </span>
            </div>
          );
        })}
        {grants.data && !all.length ? (
          <div className="prow faint" style={{ paddingLeft: 0 }}>
            <Ic n="lock" s={16} />
            <span>Owners only</span>
          </div>
        ) : null}
        {parent && !f?.is_area ? (
          <label className="row-flex" style={{ marginTop: 14, padding: '10px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <span className="switch">
              <input
                type="checkbox"
                aria-label="Inherit access"
                checked={grants.data?.inherit ?? f?.inherit !== false}
                onChange={async (e) => {
                  const on = e.target.checked;
                  try {
                    await api.set_inherit({ folder: m.id, inherit: on });
                    refresh();
                    if (!on)
                      toast('Stopped inheriting from ' + parent.name, {
                        icon: 'link-off',
                        undo: async () => {
                          await api.set_inherit({ folder: m.id, inherit: true }).catch(errorToast);
                          refresh();
                        },
                      });
                  } catch (err) {
                    errorToast(err);
                  }
                }}
              />
              <span />
            </span>
            <span className="grow">Inherit from {parent.name}</span>
            {(grants.data?.inherit ?? f?.inherit) === false ? (
              <span className="chip warn">
                <Ic n="link-off" s={11} />
              </span>
            ) : null}
          </label>
        ) : null}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: parent && !f?.is_area ? 0 : 14, position: 'relative' }}>
          <div className="qwrap" style={{ maxWidth: 'none' }}>
            <Ic n="user-check" s={15} />
            <input
              className="input"
              id="check-q"
              placeholder="Check access for"
              value={cq}
              autoComplete="off"
              onChange={(e) => {
                setCq(e.target.value);
                setCheck(null);
              }}
            />
          </div>
          {cq && !check ? (
            <div className="sugg" style={{ top: 50 }}>
              {ckCands.length ? (
                ckCands.map((u) => (
                  <button
                    key={u.id}
                    className="mi"
                    onClick={() => {
                      setCheck(u.id);
                      setCq(u.name ?? u.email ?? '');
                    }}
                  >
                    <Av name={u.name} s={22} />
                    <span>{u.name}</span>
                  </button>
                ))
              ) : (
                <div className="mi faint">No one</div>
              )}
            </div>
          ) : null}
          {check && chk.q.data ? (
            <div className="prow" style={{ paddingLeft: 0, marginTop: 8 }}>
              <Av name={checkUser?.name} s={32} />
              <div className="grow">
                <div className="pn">{checkUser?.name}</div>
                <div className="ps">{chk.why}</div>
              </div>
              <span className={'chip ' + (chk.r ? 'acc' : 'bad')}>
                <Ic n={RICON[chk.r] ?? 'ban'} s={12} />
                {ROLES[chk.r]}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </Wrap>
  );
}

/** Every folder of an area, for the move picker (breadth first, cached per folder). */
function useAreaFolders(area: string | null | undefined) {
  return useQuery({
    queryKey: ['moveTargets', area],
    enabled: !!area,
    queryFn: async () => {
      const roots = await fetchChildren(null);
      const root = roots.find((r) => r.area === area && r.is_area);
      if (!root) return [];
      const out: (Item & { depth: number })[] = [{ ...root, depth: 0 }];
      let frontier = [{ id: root.id, depth: 0 }];
      for (let level = 0; level < 8 && frontier.length; level++) {
        const next: { id: string; depth: number }[] = [];
        const lists = await Promise.all(frontier.map((f) => fetchChildren(f.id).then((k) => ({ f, k }))));
        for (const { f, k } of lists)
          for (const c of k)
            if (c.kind === 'folder') {
              out.push({ ...c, depth: f.depth + 1 });
              next.push({ id: c.id, depth: f.depth + 1 });
            }
        frontier = next;
      }
      return out;
    },
  });
}

function MoveModal({ m }: { m: Extract<Modal, { type: 'move' }> }): ReactElement {
  const n = useNode(m.id).data;
  const fs = useAreaFolders(n?.area);
  const list = (fs.data ?? []).filter((f) => role(f) >= 4 && (f.id === n?.parent_id || canDrop(m.id, f.id))).sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return (
    <Wrap label="Move">
      <div className="mh">
        <h2>
          <Ic n="move" s={17} />
          Move {n?.name ?? ''}
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        {fs.isLoading ? <Empty icon="loader" pad="30px 0" eic={false} /> : null}
        {list.map((f) => {
          const cur = f.id === n?.parent_id;
          return (
            <button
              key={f.id}
              className={'mi' + (m.dest === f.id ? ' on' : '')}
              disabled={cur}
              style={{ paddingLeft: 10 + f.depth * 18, ...(cur ? { opacity: 0.45 } : {}) }}
              onClick={() => setUI({ modal: { ...m, dest: f.id } })}
            >
              <Ic n="folder" s={15} />
              <span>{f.name}</span>
              {cur ? (
                <span className="r">
                  <Ic n="check" s={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!m.dest}
          onClick={() => {
            setUI({ modal: null });
            if (m.dest) void moveNode(m.id, m.dest);
          }}
        >
          <Ic n="move" s={15} />
          <span>Move</span>
        </button>
      </div>
    </Wrap>
  );
}

function ExportModal(): ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <Wrap size="sm" label="Export">
      <div className="mh">
        <h2>
          <Ic n="download" s={17} />
          Export
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Published versions as a zip with relative image links.
        </div>
        <div className="tokbox">
          <Ic n="file" s={15} />
          <span className="grow">library-{new Date().toISOString().slice(0, 10)}.zip</span>
        </div>
      </div>
      <div className="mf">
        <div className="grow" />
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await exportTree();
            setBusy(false);
          }}
        >
          <Ic n={busy ? 'loader' : 'download'} s={15} c={busy ? 'spin' : ''} />
          <span>Download</span>
        </button>
      </div>
    </Wrap>
  );
}

function MintModal(): ReactElement {
  const me = useMe();
  const owner = me.data?.user.org_role === 'owner';
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set(['read']));
  const [exp, setExp] = useState('90');
  const mint = async (): Promise<void> => {
    try {
      const t = await uiOnly.mint_api_token({ name: name.trim(), scopes: SCOPES.map((s) => s[0]).filter((s) => scopes.has(s)) as ('read' | 'write')[], expires_in_days: exp === '0' ? null : Number(exp) });
      invalidate('tokens');
      setUI({ modal: { type: 'reveal', name: t.name, token: t.token } });
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Wrap size="sm" label="New token">
      <div className="mh">
        <h2>
          <Ic n="key" s={17} />
          New token
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="field">
          <label htmlFor="mint-name">Name</label>
          <input className="input" id="mint-name" autoFocus placeholder="ci-sync" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Scopes</label>
          <div className="scopes">
            {SCOPES.map(([k, i, t, d]) => {
              const dis = k === 'admin' && !owner;
              const on = scopes.has(k);
              return (
                <label key={k} className={'scope' + (on ? ' on' : '') + (dis ? ' dis' : '')}>
                  <span className="sic">
                    <Ic n={i} s={15} />
                  </span>
                  <div className="grow">
                    <div className="st">{t}</div>
                    <div className="sd">{d}</div>
                  </div>
                  <input
                    type="checkbox"
                    className="cb"
                    checked={on}
                    disabled={dis}
                    onChange={(e) =>
                      setScopes((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(k);
                        else n.delete(k);
                        return n;
                      })
                    }
                  />
                </label>
              );
            })}
          </div>
        </div>
        <div className="field">
          <label htmlFor="mint-exp">Expires</label>
          <select className="select" id="mint-exp" value={exp} onChange={(e) => setExp(e.target.value)}>
            {[
              ['30', '30 days'],
              ['90', '90 days'],
              ['365', '1 year'],
              ['0', 'Never'],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name.trim() || !scopes.size} onClick={() => void mint()}>
          <Ic n="key" s={15} />
          <span>Create</span>
        </button>
      </div>
    </Wrap>
  );
}

function RevealModal({ m }: { m: Extract<Modal, { type: 'reveal' }> }): ReactElement {
  return (
    <Wrap size="sm" label="Token">
      <div className="mh">
        <h2>
          <Ic n="key" s={17} />
          {m.name}
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <div className="tokbox">
          <span className="grow">{m.token}</span>
          <IB className="ib sm" icon="copy" s={15} tip="Copy" onClick={() => copyText(m.token)} />
        </div>
        <div className="note" style={{ marginTop: 12 }}>
          <Ic n="eye-off" s={14} />
          <span>Shown once</span>
        </div>
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </Wrap>
  );
}

function RenameModal({ m }: { m: Extract<Modal, { type: 'rename' }> }): ReactElement {
  const n = useNode(m.id).data;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [n?.name]);
  const done = (): void => {
    const v = ref.current?.value ?? '';
    setUI({ modal: null });
    void renameNode(m.id, v);
  };
  return (
    <Wrap size="sm" label="Rename">
      <div className="mh">
        <h2>
          <Ic n="type" s={17} />
          <span className="ell faint">{n?.name ?? ''}</span>
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <input
          className="input"
          id="rn"
          ref={ref}
          defaultValue={n?.name ?? ''}
          key={n?.name ?? ''}
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%' }}
          onKeyDown={(e) => e.key === 'Enter' && done()}
        />
      </div>
      <div className="mf">
        <div className="grow" />
        <button className="btn primary" aria-label="Save" onClick={done}>
          <Ic n="check" s={16} />
        </button>
      </div>
    </Wrap>
  );
}

function CsvModal({ m }: { m: Extract<Modal, { type: 'csv' }> }): ReactElement {
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([m.csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <Wrap size="lg" label="audit.csv" detent>
      <div className="mh">
        <h2>
          <Ic n="download" s={17} />
          audit.csv
        </h2>
        <CloseBtn />
      </div>
      <div className="modal-body">
        <textarea className="input mono" id="csv" rows={12} readOnly style={{ width: '100%', fontSize: 12, whiteSpace: 'pre' }} value={m.csv} />
      </div>
      <div className="mf">
        <span className="faint" style={{ fontSize: 12 }}>
          {m.n} rows
        </span>
        <div className="grow" />
        <button className="btn" onClick={download}>
          <Ic n="download" s={15} />
          <span>Download</span>
        </button>
        <button className="btn primary" onClick={() => copyText(m.csv)}>
          <Ic n="copy" s={15} />
          <span>Copy</span>
        </button>
      </div>
    </Wrap>
  );
}

/** Calm conflict sheet: someone else saved the shared draft since this editor loaded it. */
function ConflictModal({ m }: { m: Extract<Modal, { type: 'conflict' }> }): ReactElement {
  const users = useUsers();
  const by = users.data?.find((u) => u.id === m.by)?.name ?? 'Someone';
  return (
    <Wrap size="sm" label="Draft changed">
      <div className="mh">
        <h2>
          <Ic n="history" s={17} />
          Draft changed
        </h2>
      </div>
      <div className="modal-body">
        <div className="prow" style={{ paddingLeft: 0 }}>
          <Av name={by} s={32} />
          <div className="grow">
            <div className="pn">{by}</div>
            <div className="ps">saved this draft while you were editing</div>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Nothing is lost. Keep your text to replace theirs, or load theirs and continue from it.
        </div>
      </div>
      <div className="mf">
        <button className="btn" onClick={() => editorCtl.resolve?.('theirs')}>
          <Ic n="download" s={15} />
          <span>Load theirs</span>
        </button>
        <div className="grow" />
        <button className="btn primary" onClick={() => editorCtl.resolve?.('mine')}>
          <Ic n="check" s={15} />
          <span>Keep mine</span>
        </button>
      </div>
    </Wrap>
  );
}

export function ModalHost(): ReactElement | null {
  const m = useUI((s) => s.modal);
  useMemo(() => getUI, []);
  if (!m) return null;
  switch (m.type) {
    case 'palette':
      return <Palette m={m} />;
    case 'commit':
      return <CommitModal m={m} />;
    case 'publish':
      return <PublishModal m={m} />;
    case 'diff':
      return <DiffModal m={m} />;
    case 'skill-publish':
      return <SkillPublishModal m={m} />;
    case 'share':
      return <ShareModal m={m} />;
    case 'move':
      return <MoveModal m={m} />;
    case 'export':
      return <ExportModal />;
    case 'mint':
      return <MintModal />;
    case 'reveal':
      return <RevealModal m={m} />;
    case 'rename':
      return <RenameModal m={m} />;
    case 'csv':
      return <CsvModal m={m} />;
    case 'conflict':
      return <ConflictModal m={m} />;
    default:
      return null;
  }
}

export { invalidateContent };
