import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Ic } from '../lib/icons';
import { Av, TeamAv, ClientAv, SkillMark, DocMark, Empty, Spinner, nodeIcon } from '../ui/common';
import { Confirm } from '../ui/feedback';
import { useRoute, navigate, type Route } from '../router';
import { useUI, setUI, openMenu, isDark, toggleTheme, getUI } from '../state';
import { useMe, useChildren, useChain, useNode, useUsers, useTeams, role, qc, type Item, type NodeT } from '../api/hooks';
import { goNode, leaveEdit, openCommit, discardDraft, logout, startEdit } from '../actions';
import { useResolvedNode } from '../shell/Main';
import { useDocModel } from '../pages/docModel';
import { SkillHead, Banner, DocBody, Pill, LintBtn } from '../pages/Doc';
import { AreaChip, RulesMeter, useAreaCounts } from '../pages/Folder';
import { DrawerContent } from '../shell/Drawer';
import { GraphPage } from '../pages/Graph';
import { useSearch, Hl } from '../shell/search';
import { TeamBody, useAuditRows, auditCsv, useTokens, useConns, useTrash, revokeToken, revokeConn, setUserStatus, connName, createTeam, detailText, type AuditF } from '../pages/Admin';
import { ago, AREAS, areaKey, OPI, OPL, VIA } from '../lib/util';
import { firstH1 } from '../ui/Markdown';
import { useSave } from '../editor/status';
import { restoreNode, deleteNode } from '../actions';
import { gestureHooks } from './gestures';

const Editor = lazy(() => import('../editor/Editor'));

/** iPhone layout (< 768 px): tab bar, one push stack per tab, inset grouped lists, sheets (docs/MOBILE.md). */

type Tab = 'home' | 'search' | 'graph' | 'more';
const MORE = new Set(['people', 'teams', 'team', 'audit', 'tokens', 'connections', 'trash', 'account']);
const tabOf = (r: Route): Tab => (r.name === 'search' ? 'search' : r.name === 'graph' ? 'graph' : MORE.has(r.name) ? 'more' : 'home');
const ROOT: Record<Tab, string> = { home: '/', search: '/search', graph: '/graph', more: '/account' };
const lastOf: Record<Tab, string> = { ...ROOT };

const mb = (icon: string, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, extra?: Record<string, string>): ReactElement => (
  <button className="mb" aria-label={label} onClick={onClick} {...extra}>
    <Ic n={icon} s={22} />
  </button>
);

function Screen({ anim, title, back, left, right, large = true, body, cls = '', onBack }: { anim: string; title: ReactNode; back?: boolean; left?: ReactNode; right?: ReactNode; large?: boolean; body: ReactNode; cls?: string; onBack?: () => void }): ReactElement {
  const nav = useRef<HTMLElement>(null);
  const sc = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = sc.current;
    const n = nav.current;
    if (!s || !n || !large) return;
    const lt = s.querySelector<HTMLElement>('.m-large');
    const f = (): void => {
      n.classList.toggle('scrolled', s.scrollTop > (lt ? lt.offsetHeight - 6 : 1));
    };
    s.addEventListener('scroll', f, { passive: true });
    f();
    return () => s.removeEventListener('scroll', f);
  }, [large]);
  return (
    <section className={'m-screen ' + anim + ' ' + cls}>
      <header className={'m-nav' + (large ? '' : ' compact')} id="mnav" ref={nav}>
        {left ?? (back ? (
          <button className="mb" data-back="1" aria-label="Back" onClick={onBack}>
            <Ic n="chev-l" s={28} />
          </button>
        ) : (
          <span className="mb-sp" />
        ))}
        <div className="mt">{title}</div>
        <div className="sp" />
        <div className="m-r">{right}</div>
      </header>
      <div className="m-scroll" id="mscroll" ref={sc}>
        {large ? <h1 className="m-large">{title}</h1> : null}
        {body}
      </div>
    </section>
  );
}

/** Back target (prototype mBack): a file of a skill goes back to its SKILL.md, SKILL.md to the folder holding the skill. */
function backOf(n: NodeT, chain: NodeT[]): string {
  const anc = chain.slice(0, -1);
  const sk = [...anc].reverse().find((x) => x.kind === 'folder' && !x.is_area && x.is_skill);
  if (sk && !(n.name === 'SKILL.md' && n.parent_id === sk.id)) return '/n/' + sk.id;
  const parentId = n.name === 'SKILL.md' ? (anc[anc.length - 2]?.id ?? null) : n.parent_id;
  return parentId ? '/n/' + parentId : '/';
}

function SwipeRow({ acts, children }: { acts: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="m-sw">
      {acts ? <div className="m-acts">{acts}</div> : null}
      {children}
    </div>
  );
}

function MRow({ n, parent }: { n: Item; parent: NodeT }): ReactElement {
  const sk = n.kind === 'folder' && !!n.is_skill;
  const pr = role(parent);
  const fixed = n.is_area || n.name === 'SKILL.md';
  let icon: ReactNode;
  let sub = '';
  let trail: ReactNode = null;
  if (n.kind === 'folder') {
    if (sk) {
      sub = n.skill?.description ?? '';
      icon = (
        <span className="m-ic sm a-skills">
          <Ic n="sparkles" s={16} />
        </span>
      );
      trail = <SkillMark n={n} />;
    } else {
      icon = (
        <span className="m-ic sm plain">
          <Ic n="folder" s={17} />
        </span>
      );
      trail = <span className="m-v">{n.children ?? ''}</span>;
    }
  } else {
    icon = (
      <span className="m-ic sm plain">
        <Ic n={nodeIcon(n)} s={17} />
      </span>
    );
    sub = ago(n.updated_at);
    trail = <DocMark n={n} />;
  }
  const acts = (
    <>
      {n.kind === 'folder' && role(n) >= 4 && !sk ? (
        <button className="sa sa-share" aria-label="Share" onClick={() => setUI({ modal: { type: 'share', id: n.id } })}>
          <Ic n="user-plus" s={20} />
        </button>
      ) : null}
      {pr >= 4 && !fixed ? (
        <>
          <button className="sa sa-move" aria-label="Move" onClick={() => setUI({ modal: { type: 'move', id: n.id, dest: null } })}>
            <Ic n="move" s={20} />
          </button>
          <button className="sa sa-del" aria-label="Delete" onClick={() => void deleteNode(n.id)}>
            <Ic n="trash" s={20} />
          </button>
        </>
      ) : null}
    </>
  );
  const hasActs = (n.kind === 'folder' && role(n) >= 4 && !sk) || (pr >= 4 && !fixed);
  return (
    <SwipeRow acts={hasActs ? acts : null}>
      <button className="m-row" data-lp={n.id} onClick={() => void goNode(n.id)}>
        {icon}
        <span className="m-tx">
          <span className="m-t">{n.name}</span>
          {sub ? <span className="m-s">{sub}</span> : null}
        </span>
        {trail}
        <Ic n="chev-r" s={17} c="m-chev" />
      </button>
    </SwipeRow>
  );
}

function HomeRoot({ anim }: { anim: string }): ReactElement {
  const roots = useChildren(null);
  const counts = useAreaCounts();
  return (
    <Screen
      anim={anim}
      title="Library"
      body={
        <div className="m-group">
          {(roots.data ?? []).map((f) => {
            const k = areaKey(f.area);
            return (
              <button key={f.id} className="m-row" onClick={() => void goNode(f.id)}>
                <span className={'m-ic a-' + k}>
                  <Ic n={AREAS[k].icon} s={18} />
                </span>
                <span className="m-tx">
                  <span className="m-t">{f.name}</span>
                  <span className="m-s">{AREAS[k].tip}</span>
                </span>
                <span className="m-v">{counts[k] ?? ''}</span>
                <Ic n="chev-r" s={17} c="m-chev" />
              </button>
            );
          })}
        </div>
      }
    />
  );
}

function FolderScreen({ f, anim, onBack }: { f: NodeT; anim: string; onBack: () => void }): ReactElement {
  const kids = useChildren(f.id);
  const r = role(f);
  const ar = f.is_area;
  const k = areaKey(f.area);
  const canNew = r >= 2 && (k !== 'rules' || ar);
  const items = kids.data ?? [];
  const right = (
    <>
      {canNew ? mb('plus', 'New', (e) => openMenu('new', e.currentTarget, f.id)) : null}
      {mb('info', 'Details', () => setUI({ drawer: 'access' }))}
      {!ar && r >= 2 ? mb('more', 'More', (e) => openMenu('ctx', e.currentTarget, f.id)) : null}
    </>
  );
  const meta = (
    <>
      {ar ? <AreaChip k={k} /> : null}
      {f.inherit === false ? (
        <span className="chip warn">
          <Ic n="link-off" s={12} />
          Isolated
        </span>
      ) : null}
      <LintBtn node={f} v={null} />
    </>
  );
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title={f.name}
      right={right}
      body={
        <>
          <div className="m-meta">{meta}</div>
          {ar && f.area === 'rules' ? (
            <div className="m-pad">
              <RulesMeter />
            </div>
          ) : null}
          {kids.isLoading ? (
            <Spinner />
          ) : items.length ? (
            <div className="m-group">
              {items.map((n) => (
                <MRow key={n.id} n={n} parent={f} />
              ))}
            </div>
          ) : (
            <div className="empty">
              <span className="eic">
                <Ic n={ar ? AREAS[k].icon : 'folder-open'} s={22} />
              </span>
              {canNew ? (
                <button className="btn" aria-label="New" onClick={(e) => openMenu('new', e.currentTarget, f.id)}>
                  <Ic n="plus" s={16} />
                </button>
              ) : null}
            </div>
          )}
        </>
      }
    />
  );
}

function DocScreen({ d, anim, onBack }: { d: NodeT; anim: string; onBack: () => void }): ReactElement {
  const m = useDocModel(d.id);
  const r = m.r;
  const h1 = m.content && !m.isCode ? firstH1(m.content.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')) : null;
  const title = h1 ?? (m.isSkillMd && m.head ? (m.head.path.split('/').pop() ?? d.name) : d.name);
  const right = (
    <>
      {r >= 2 ? mb('pencil', 'Edit', () => startEdit(d.id)) : null}
      {mb('info', 'Details', () => setUI({ drawer: 'links' }))}
      {mb('more', 'More', (e) => openMenu('mdoc', e.currentTarget, d.id))}
    </>
  );
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title={title}
      right={right}
      body={
        <>
          <div className="m-meta">
            {r >= 2 ? <Pill node={d} /> : null}
            <LintBtn node={d} v={m.v} />
          </div>
          <div className="m-page">
            <SkillHead m={m} />
            <Banner m={m} />
            <DocBody m={m} skipH1={!!h1} />
          </div>
        </>
      }
    />
  );
}

function EditorScreen({ d }: { d: NodeT }): ReactElement {
  const save = useSave();
  const left = (
    <button className="mb" aria-label="Close editor" onClick={() => void leaveEdit()}>
      <Ic n="x" s={24} />
    </button>
  );
  const right = (
    <>
      <span className={'save' + (save === 'saved' ? ' ok' : '')} id="save-ic" aria-label="Saved state">
        <Ic n={save === 'saving' ? 'loader' : save === 'pending' ? 'cloud' : 'cloud-check'} s={16} c={save === 'saving' ? 'spin' : ''} />
      </span>
      {d.has_draft ? (
        <Confirm className="mb" label="Discard draft" onConfirm={() => void discardDraft(d.id)}>
          <Ic n="trash" s={21} />
        </Confirm>
      ) : null}
      <button className="mb pri" aria-label="Commit" onClick={() => void openCommit(d.id)}>
        <Ic n="commit" s={20} />
      </button>
    </>
  );
  const label = d.name === 'SKILL.md' ? (d.path.split('/').slice(-2)[0] ?? d.name) : d.name;
  return (
    <Screen
      anim=""
      left={left}
      title={label}
      right={right}
      large={false}
      body={
        <div className="m-page m-ed">
          <Suspense fallback={<Spinner />}>
            <Editor node={d} mobile />
          </Suspense>
        </div>
      }
    />
  );
}

function NodeScreen({ id, anim }: { id: string; anim: string }): ReactElement {
  const { node, error } = useResolvedNode(id);
  const chain = useChain(node?.id ?? null);
  const editing = useUI((s) => s.editing);
  const back = (): void => {
    if (!node) return navigate('/');
    setUI({ viewing: null, drawer: null, menu: null });
    navigate(backOf(node, chain.data ?? [node]));
  };
  useEffect(() => {
    gestureHooks.back = back;
  });
  if (!node)
    return (
      <Screen
        anim={anim}
        back
        onBack={() => navigate('/')}
        title=""
        body={error ? <Empty icon="lock" /> : <Spinner />}
      />
    );
  if (node.kind === 'doc' && editing === node.id && role(node) >= 2) return <EditorScreen d={node} />;
  return node.kind === 'doc' ? <DocScreen d={node} anim={anim} onBack={back} /> : <FolderScreen f={node} anim={anim} onBack={back} />;
}

function SearchScreen(): ReactElement {
  const q = useUI((s) => s.q);
  const recent = useUI((s) => s.recent);
  const [focus, setFocus] = useState(false);
  const res = useSearch(q);
  const input = useRef<HTMLInputElement>(null);
  const row = (id: string, icon: string, area: string, title: ReactNode, sub: ReactNode): ReactElement => (
    <button key={id} className="m-row" onClick={() => void goNode(id)}>
      <span className={'m-ic sm a-' + area}>
        <Ic n={icon} s={16} />
      </span>
      <span className="m-tx">
        <span className="m-t">{title}</span>
        {sub ? <span className="m-s">{sub}</span> : null}
      </span>
    </button>
  );
  let body: ReactNode;
  if (!q.trim()) {
    const rec = recent.map((id) => qc.getQueryData<NodeT>(['node', id])).filter((n): n is NodeT => !!n);
    body = rec.length ? (
      <>
        <div className="m-gh">
          <Ic n="clock" s={14} />
          <button className="m-link" aria-label="Clear recent" onClick={() => setUI({ recent: [] })}>
            <Ic n="trash" s={16} />
          </button>
        </div>
        <div className="m-group">
          {rec.map((n) => {
            const sk = n.name === 'SKILL.md';
            const segs = n.path.split('/').filter(Boolean);
            return row(n.id, sk ? 'sparkles' : nodeIcon(n), areaKey(n.area), sk ? (segs[segs.length - 2] ?? n.name) : n.name, segs.slice(0, sk ? -2 : -1).join(' / '));
          })}
        </div>
      </>
    ) : (
      <Empty icon="clock" />
    );
  } else if (res.data) {
    const all = [...res.data.rows, ...res.data.names];
    body = all.length ? (
      <div className="m-group">
        {all.map((it) => row(it.id, it.icon, it.area, <Hl text={it.title} toks={res.data!.toks} />, <Hl text={it.desc ?? it.snippet ?? it.path} toks={res.data!.toks} />))}
      </div>
    ) : (
      <Empty icon="search" />
    );
  } else body = <Spinner />;
  return (
    <section className="m-screen">
      <header className={'m-nav m-snav compact' + (q ? ' has' : '') + (focus ? ' act' : '')} id="mnav">
        <div className="m-sf">
          <Ic n="search" s={17} />
          <input
            id="mq"
            ref={input}
            type="search"
            enterKeyHint="search"
            placeholder="Search"
            value={q}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search"
            onFocus={() => setFocus(true)}
            onBlur={() => setTimeout(() => setFocus(false), 150)}
            onChange={(e) => setUI({ q: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && input.current?.blur()}
          />
          <button
            className="m-clr"
            aria-label="Clear"
            onClick={() => {
              setUI({ q: '' });
              input.current?.focus();
            }}
          >
            <Ic n="x-circle" s={17} />
          </button>
        </div>
        <button
          className="mb m-cancel"
          aria-label="Cancel"
          onClick={() => {
            setUI({ q: '' });
            input.current?.blur();
          }}
        >
          <Ic n="x" s={22} />
        </button>
      </header>
      <div className="m-scroll" id="mscroll">
        <div id="mres" className="m-res" style={{ paddingTop: 8 }}>
          {body}
        </div>
      </div>
    </section>
  );
}

function NavRow({ icon, color, label, onClick }: { icon: string; color: string; label: string; onClick: () => void }): ReactElement {
  return (
    <button className="m-row" onClick={onClick}>
      <span className="m-ic sm" style={{ ['--ac' as string]: color }}>
        <Ic n={icon} s={16} />
      </span>
      <span className="m-tx">
        <span className="m-t">{label}</span>
      </span>
      <Ic n="chev-r" s={17} c="m-chev" />
    </button>
  );
}

function AccountRoot({ anim }: { anim: string }): ReactElement {
  const me = useMe();
  const u = me.data?.user;
  const owner = u?.org_role === 'owner';
  useUI((s) => s.theme);
  return (
    <Screen
      anim={anim}
      title="Account"
      body={
        <>
          <div className="m-group">
            <div className="m-row static">
              <Av name={u?.name ?? u?.email} s={48} />
              <span className="m-tx">
                <span className="m-t" style={{ fontWeight: 600 }}>
                  {u?.name}
                </span>
                <span className="m-s">{u?.email}</span>
              </span>
            </div>
          </div>
          {owner ? (
            <div className="m-group">
              <NavRow icon="user" color="#007aff" label="People" onClick={() => navigate('/people')} />
              <NavRow icon="users" color="#5856d6" label="Teams" onClick={() => navigate('/teams')} />
              <NavRow icon="activity" color="#ff9500" label="Audit" onClick={() => navigate('/audit')} />
            </div>
          ) : null}
          <div className="m-group">
            <NavRow icon="key" color="#8e8e93" label="API tokens" onClick={() => navigate('/settings/tokens')} />
            <NavRow icon="plug" color="#34c759" label="Connections" onClick={() => navigate('/settings/connections')} />
            <NavRow icon="trash" color="#8e8e93" label="Trash" onClick={() => navigate('/trash')} />
          </div>
          <div className="m-group">
            <label className="m-row">
              <span className="m-ic sm" style={{ ['--ac' as string]: '#5856d6' }}>
                <Ic n="moon" s={16} />
              </span>
              <span className="m-tx">
                <span className="m-t">Dark</span>
              </span>
              <span className="switch">
                <input type="checkbox" checked={isDark()} aria-label="Dark mode" onChange={toggleTheme} />
                <span />
              </span>
            </label>
          </div>
          <div className="m-group">
            <button className="m-row m-danger" aria-label="Sign out" onClick={() => void logout()}>
              <Ic n="logout" s={18} />
            </button>
          </div>
        </>
      }
    />
  );
}

function PeopleScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const me = useMe();
  const users = useUsers();
  const [q, setQ] = useState('');
  const list = (users.data ?? []).filter((u) => !q || ((u.name ?? '') + ' ' + (u.email ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="People"
      body={
        <>
          <div className="m-pad">
            <div className="m-sf solo">
              <Ic n="search" s={16} />
              <input id="people-q" placeholder="Filter" value={q} autoComplete="off" aria-label="Filter" onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="m-group">
            {list.map((u) => {
              const self = u.id === me.data?.user.id;
              const act = u.status !== 'suspended';
              const name = u.name ?? u.email ?? '';
              return (
                <SwipeRow
                  key={u.id}
                  acts={
                    self ? null : (
                      <button className={'sa ' + (act ? 'sa-del' : 'sa-share')} aria-label={act ? 'Suspend' : 'Reactivate'} onClick={() => void setUserStatus(u.id, name, act ? 'suspended' : 'active')}>
                        <Ic n={act ? 'ban' : 'undo'} s={20} />
                      </button>
                    )
                  }
                >
                  <button className="m-row" onClick={self ? undefined : () => setUI({ menu: { type: 'acts', id: 'user:' + u.id } })}>
                    <Av name={name} s={36} />
                    <span className="m-tx">
                      <span className="m-t">{name}</span>
                      <span className="m-s">{u.email}</span>
                    </span>
                    {u.org_role === 'owner' ? (
                      <span className="faint" aria-label="Owner">
                        <Ic n="crown" s={15} />
                      </span>
                    ) : null}
                    {act ? null : (
                      <span className="chip bad">
                        <Ic n="ban" s={11} />
                      </span>
                    )}
                  </button>
                </SwipeRow>
              );
            })}
          </div>
        </>
      }
    />
  );
}

function TeamsScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const teams = useTeams();
  const users = useUsers();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const active = (users.data ?? []).filter((u) => u.status !== 'suspended').length;
  const create = async (): Promise<void> => {
    const id = await createTeam(name);
    if (id) {
      setAdding(false);
      navigate('/teams/' + id);
    }
  };
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="Teams"
      right={mb('plus', 'New team', () => (setAdding(true), setName('')))}
      body={
        <>
          {adding ? (
            <div className="m-pad">
              <div className="row-flex">
                <input className="input grow" id="newteam" placeholder="Team name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
                <button className="btn primary" aria-label="Create" onClick={() => void create()}>
                  <Ic n="check" s={16} />
                </button>
                <button className="ib" aria-label="Cancel" onClick={() => setAdding(false)}>
                  <Ic n="x" s={16} />
                </button>
              </div>
            </div>
          ) : null}
          <div className="m-group">
            {(teams.data?.items ?? []).map((t) => (
              <button key={t.id} className="m-row" onClick={() => navigate('/teams/' + t.id)}>
                <TeamAv id={t.id} name={t.name} s={32} />
                <span className="m-tx">
                  <span className="m-t">{t.id === 'everyone' ? 'Everyone' : t.name}</span>
                  <span className="m-s">{t.description ?? ''}</span>
                </span>
                <span className="m-v">{t.id === 'everyone' ? active : t.member_count}</span>
                <Ic n="chev-r" s={17} c="m-chev" />
              </button>
            ))}
          </div>
        </>
      }
    />
  );
}

function TeamScreen({ id, anim, onBack }: { id: string; anim: string; onBack: () => void }): ReactElement {
  const teams = useTeams();
  const t = teams.data?.items.find((x) => x.id === id);
  const [tab, setTab] = useState<'members' | 'folders' | 'settings'>('members');
  const ev = id === 'everyone';
  const tabs: [typeof tab, string, string][] = [
    ['members', 'users', 'Members'],
    ['folders', 'folder', 'Folders'],
    ...(ev ? [] : [['settings', 'cog', 'Settings'] as [typeof tab, string, string]]),
  ];
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title={ev ? 'Everyone' : (t?.name ?? '')}
      body={
        <>
          <div className="m-pad">
            <div className="seg" role="tablist" style={{ display: 'flex' }}>
              {tabs.map(([v, i, l]) => (
                <button key={v} className={tab === v ? 'on' : ''} style={{ flex: 1 }} role="tab" aria-selected={tab === v} aria-label={l} onClick={() => setTab(v)}>
                  <Ic n={i} s={16} />
                </button>
              ))}
            </div>
          </div>
          <div className="m-pad">
            <TeamBody id={id} tab={tab} mobile />
          </div>
        </>
      }
    />
  );
}

function AuditScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const [F, setF] = useState<AuditF>({ actor: '', op: '', via: '', range: '7d', q: '' });
  const users = useUsers();
  const { rows } = useAuditRows(F);
  const email = (id: string | null): string => users.data?.find((u) => u.id === id)?.email ?? '';
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="Audit"
      right={mb('download', 'CSV', () => setUI({ modal: { type: 'csv', csv: auditCsv(rows, email), n: rows.length } }))}
      body={
        <>
          <div className="m-pad row-flex" style={{ flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Source">
              {(
                [
                  ['', 'All'],
                  ['ui', 'Web'],
                  ['rest', 'API'],
                  ['mcp', 'Agent'],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={F.via === v ? 'on' : ''} aria-label={l} onClick={() => setF({ ...F, via: v })}>
                  <Ic n={v ? VIA[v]![0] : 'layers'} s={15} />
                </button>
              ))}
            </div>
            <div className="seg">
              {(['24h', '7d', '30d', 'all'] as const).map((r) => (
                <button key={r} className={F.range === r ? 'on' : ''} onClick={() => setF({ ...F, range: r })}>
                  {r === 'all' ? <Ic n="clock" s={15} /> : r}
                </button>
              ))}
            </div>
          </div>
          <div className="m-group">
            {rows.length ? (
              rows.slice(0, 80).map((a) => (
                <div key={a.id} className="m-row static">
                  <span className={'m-ic sm ' + (a.ok ? (a.op.startsWith('publish') ? 'ok' : a.op === 'commit_version' ? 'acc' : 'plain') : 'bad')}>
                    <Ic n={a.ok ? (OPI[a.op] ?? 'activity') : 'ban'} s={15} />
                  </span>
                  <span className="m-tx">
                    <span className="m-t" style={{ fontSize: 15 }}>
                      {(a.actor_name ?? 'System').split(' ')[0]}{' '}
                      <span className="muted">
                        {OPL[a.op] ?? a.op}
                        {a.version ? ' v' + a.version : ''}
                      </span>
                    </span>
                    <span className="m-s">{a.node_name ?? detailText(a.detail)}</span>
                  </span>
                  <span className="m-v" style={{ fontSize: 13 }}>
                    {ago(a.ts)}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty">
                <Ic n="activity" s={22} />
              </div>
            )}
          </div>
        </>
      }
    />
  );
}

function TokensScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const t = useTokens();
  const items = (t.data?.items ?? []).filter((x) => !x.revoked_at);
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="API tokens"
      right={mb('plus', 'New token', () => setUI({ modal: { type: 'mint' } }))}
      body={
        items.length ? (
          <div className="m-group">
            {items.map((k) => (
              <SwipeRow
                key={k.id}
                acts={
                  <button className="sa sa-del" aria-label="Revoke" onClick={() => void revokeToken(k.id, k.name)}>
                    <Ic n="trash" s={20} />
                  </button>
                }
              >
                <button className="m-row" onClick={() => setUI({ menu: { type: 'acts', id: 'token:' + k.id } })}>
                  <span className="m-ic sm plain">
                    <Ic n="key" s={16} />
                  </span>
                  <span className="m-tx">
                    <span className="m-t">{k.name}</span>
                    <span className="m-s">{k.scopes.join(' · ')}</span>
                  </span>
                  <span className="m-v" style={{ fontSize: 13 }}>
                    {k.last_used_at ? ago(k.last_used_at) : '-'}
                  </span>
                </button>
              </SwipeRow>
            ))}
          </div>
        ) : (
          <Empty icon="key" />
        )
      }
    />
  );
}

function ConnsScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const me = useMe();
  const c = useConns();
  const url = me.data?.mcp_url ?? '';
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="Connections"
      body={
        <>
          <div className="m-pad">
            <div className="urlbox">
              <span>{url}</span>
              <button className="ib sm" aria-label="Copy" onClick={() => void navigator.clipboard?.writeText(url)}>
                <Ic n="copy" s={16} />
              </button>
            </div>
          </div>
          {c.data?.items.length ? (
            <div className="m-group">
              {c.data.items.map((x) => (
                <SwipeRow
                  key={x.id}
                  acts={
                    <button className="sa sa-del" aria-label="Revoke" onClick={() => void revokeConn(x.id, connName(x))}>
                      <Ic n="trash" s={20} />
                    </button>
                  }
                >
                  <button className="m-row" onClick={() => setUI({ menu: { type: 'acts', id: 'conn:' + x.id } })}>
                    <ClientAv name={connName(x)} s={28} />
                    <span className="m-tx">
                      <span className="m-t">{connName(x)}</span>
                      <span className="m-s">{x.scopes.join(' · ')}</span>
                    </span>
                    <span className="m-v" style={{ fontSize: 13 }}>
                      {ago(x.created_at)}
                    </span>
                  </button>
                </SwipeRow>
              ))}
            </div>
          ) : null}
        </>
      }
    />
  );
}

function TrashScreen({ anim, onBack }: { anim: string; onBack: () => void }): ReactElement {
  const t = useTrash();
  const items = t.data?.items ?? [];
  return (
    <Screen
      anim={anim}
      back
      onBack={onBack}
      title="Trash"
      body={
        items.length ? (
          <div className="m-group">
            {items.map((n) => (
              <SwipeRow
                key={n.id}
                acts={
                  <button className="sa sa-share" aria-label="Restore" onClick={() => void restoreNode(n.id, n.name)}>
                    <Ic n="undo" s={20} />
                  </button>
                }
              >
                <button className="m-row" onClick={() => setUI({ menu: { type: 'acts', id: 'trash:' + n.id } })}>
                  <span className="m-ic sm plain">
                    <Ic n={n.kind === 'folder' ? 'folder' : 'file'} s={16} />
                  </span>
                  <span className="m-tx">
                    <span className="m-t">{n.name}</span>
                  </span>
                  <span className="m-v" style={{ fontSize: 13 }}>
                    {ago(n.deleted_at)}
                  </span>
                </button>
              </SwipeRow>
            ))}
          </div>
        ) : (
          <Empty icon="trash" />
        )
      }
    />
  );
}

function MoreScreen({ route, anim }: { route: Route; anim: string }): ReactElement {
  const back = (): void => navigate(route.name === 'team' ? '/teams' : '/account');
  useEffect(() => {
    gestureHooks.back = route.name === 'account' ? null : back;
  });
  switch (route.name) {
    case 'people':
      return <PeopleScreen anim={anim} onBack={back} />;
    case 'teams':
      return <TeamsScreen anim={anim} onBack={back} />;
    case 'team':
      return <TeamScreen id={route.id} anim={anim} onBack={back} />;
    case 'audit':
      return <AuditScreen anim={anim} onBack={back} />;
    case 'tokens':
      return <TokensScreen anim={anim} onBack={back} />;
    case 'connections':
      return <ConnsScreen anim={anim} onBack={back} />;
    case 'trash':
      return <TrashScreen anim={anim} onBack={back} />;
    default:
      return <AccountRoot anim={anim} />;
  }
}

function depthOf(route: Route, chainLen: number): number {
  if (route.name === 'node') return chainLen || 1;
  if (route.name === 'team') return 2;
  if (route.name === 'home' || route.name === 'account') return 0;
  return 1;
}

function Tabs({ tab }: { tab: Tab }): ReactElement {
  const me = useMe();
  const it = (v: Tab, icon: string, l: string): ReactElement => (
    <button key={v} className={tab === v ? 'on' : ''} aria-label={l} aria-current={tab === v ? 'page' : undefined} onClick={() => onTab(v, tab)}>
      <Ic n={icon} s={25} />
    </button>
  );
  return (
    <nav className="m-tabs" aria-label="Sections">
      {it('home', 'layers', 'Library')}
      {it('search', 'search', 'Search')}
      {it('graph', 'graph', 'Graph')}
      <button className={tab === 'more' ? 'on' : ''} aria-label="Account" aria-current={tab === 'more' ? 'page' : undefined} onClick={() => onTab('more', tab)}>
        <Av name={me.data?.user.name ?? me.data?.user.email ?? '?'} s={26} />
      </button>
    </nav>
  );
}

function onTab(v: Tab, cur: Tab): void {
  const go = (): void => {
    setUI({ menu: null, modal: null, drawer: null, renaming: null });
    if (v === cur) {
      // Tapping the active tab pops it to its root.
      if (v === 'search') document.getElementById('mq')?.focus();
      navigate(ROOT[v]);
    } else navigate(lastOf[v]);
  };
  if (getUI().editing) void leaveEdit().then(go);
  else go();
}

export function MobileShell(): ReactElement {
  const route = useRoute();
  const tab = tabOf(route);
  const editing = useUI((s) => s.editing);
  const drawer = useUI((s) => s.drawer);
  const modal = useUI((s) => s.modal);
  const menu = useUI((s) => s.menu);
  const nodeId = route.name === 'node' ? route.id : null;
  const chain = useChain(nodeId);
  const nq = useNode(nodeId);
  const key = route.name === 'node' ? 'n:' + route.id : route.name === 'team' ? 'team:' + route.id : route.name;
  const depth = depthOf(route, chain.data?.length ?? 0);
  const prev = useRef<{ key: string; depth: number; tab: Tab } | null>(null);
  let anim = '';
  if (prev.current && prev.current.key !== key && prev.current.tab === tab) anim = depth > prev.current.depth ? 'push' : depth < prev.current.depth ? 'pop' : '';
  const [animKey, setAnimKey] = useState({ key, anim });
  if (animKey.key !== key) setAnimKey({ key, anim });
  useLayoutEffect(() => {
    prev.current = { key, depth, tab };
    lastOf[tab] = window.location.pathname + window.location.search;
  }, [key, depth, tab]);
  // Sheets: the details drawer opens at the medium detent, everything else large.
  const sheetKey = modal ? 'm:' + modal.type : drawer && route.name === 'node' ? 'd' : menu ? 'u' : '';
  const lastSheet = useRef('');
  useEffect(() => {
    if (sheetKey !== lastSheet.current) {
      lastSheet.current = sheetKey;
      setUI({ det: sheetKey === 'd' ? 'm' : 'l' });
    }
  }, [sheetKey]);
  const det = useUI((s) => s.det);
  useEffect(() => {
    if (tab === 'home' && route.name === 'home') gestureHooks.back = null;
  });

  let screen: ReactNode;
  const a = animKey.anim;
  if (tab === 'graph')
    screen = (
      <section className="m-screen m-graph">
        <GraphPage focus={route.name === 'graph' ? route.focus : null} mobile />
      </section>
    );
  else if (tab === 'search') screen = <SearchScreen />;
  else if (tab === 'more') screen = <MoreScreen key={key} route={route} anim={a} />;
  else if (route.name === 'node') screen = <NodeScreen key={key} id={route.id} anim={a} />;
  else screen = <HomeRoot key={key} anim={a} />;

  const showDrawer = !!drawer && route.name === 'node' && !editing && !!nq.data;
  return (
    <>
      <div className={'m-app' + (editing ? ' editing' : '')}>
        <div className="m-stage">{screen}</div>
        {editing ? null : <Tabs tab={tab} />}
      </div>
      {showDrawer && nq.data ? (
        <div className="modal-wrap">
          <div className="modal-scrim" onClick={() => setUI({ drawer: null })} />
          <div className={'modal detent m-drawer' + (det === 'l' ? ' l' : '')} role="dialog" aria-label="Details">
            <div className="grab" aria-label="Resize" role="button" onClick={() => setUI((s) => ({ det: s.det === 'l' ? 'm' : 'l' }))} />
            <DrawerContent id={nq.data.id} />
          </div>
        </div>
      ) : null}
    </>
  );
}
