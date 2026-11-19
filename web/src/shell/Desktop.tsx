import { useRef, type ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { Av, IB } from '../ui/common';
import { setUI, useUI, openMenu, isDark, toggleTheme, getUI } from '../state';
import { useRoute, navigate, type Route } from '../router';
import { useMe, useNode } from '../api/hooks';
import { goNode, leaveEdit } from '../actions';
import { TreePane } from './Tree';
import { DrawerContent } from './Drawer';
import { SearchResults, useSearch, searchIds } from './search';
import { Main } from './Main';
import { brandName, brandOrg } from '../lib/brand';

function SearchBox(): ReactElement {
  const q = useUI((s) => s.q);
  const open = useUI((s) => s.searchOpen);
  const sIdx = useUI((s) => s.sIdx);
  const res = useSearch(q);
  const ref = useRef<HTMLInputElement>(null);
  const pick = (id: string): void => {
    setUI({ q: '', searchOpen: false });
    ref.current?.blur();
    void goNode(id);
  };
  return (
    <div className="search">
      <Ic n="search" s={16} c="si" />
      <input
        id="q"
        ref={ref}
        placeholder="Search"
        autoComplete="off"
        spellCheck={false}
        value={q}
        aria-label="Search"
        onChange={(e) => setUI({ q: e.target.value, searchOpen: true, sIdx: 0 })}
        onFocus={() => q.trim() && setUI({ searchOpen: true })}
        onBlur={() => setTimeout(() => setUI({ searchOpen: false }), 120)}
        onKeyDown={(e) => {
          const ids = searchIds(q, res.data);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setUI({ sIdx: Math.max(0, Math.min(ids.length - 1, sIdx + (e.key === 'ArrowDown' ? 1 : -1))) });
          } else if (e.key === 'Enter' && ids.length) {
            e.preventDefault();
            pick(ids[Math.min(sIdx, ids.length - 1)]!);
          } else if (e.key === 'Enter' && q.trim()) {
            navigate('/search?q=' + encodeURIComponent(q.trim()));
          } else if (e.key === 'Escape') {
            setUI({ searchOpen: false });
            ref.current?.blur();
          }
        }}
      />
      <kbd>/</kbd>
      {open && q.trim() ? <SearchResults q={q} sIdx={sIdx} onPick={pick} /> : null}
    </div>
  );
}

function Top(): ReactElement {
  const me = useMe();
  const u = me.data?.user;
  return (
    <header className="top">
      <IB className="ib mbtn" icon="menu" s={18} tip="Folders" onClick={() => setUI((s) => ({ mTree: !s.mTree }))} />
      <div className="brand">
        <span className="logo">
          <Ic n="layers" s={15} />
        </span>
        <span className="nm">{brandName()}</span>
        {brandOrg(me.data) ? <span className="org">{brandOrg(me.data)}</span> : null}
      </div>
      <SearchBox />
      <div className="right">
        <IB className="ib hide-m" icon="command" tip="Quick open|Ctrl K" onClick={() => setUI({ modal: { type: 'palette', q: '', i: 0 }, menu: null })} />
        <button className="ib" aria-label="Account" data-tip={u?.name ?? u?.email ?? 'Account'} style={{ width: 'auto', padding: '0 4px' }} onClick={(e) => openMenu('user', e.currentTarget, 'me')}>
          <Av name={u?.name ?? u?.email ?? '?'} s={28} />
        </button>
      </div>
    </header>
  );
}

const PAGE_VIEWS = new Set(['people', 'teams', 'team', 'audit', 'tokens', 'connections', 'graph', 'search', 'account']);

function Rail({ route }: { route: Route }): ReactElement {
  const me = useMe();
  const owner = me.data?.user.org_role === 'owner';
  const it = (to: string, icon: string, tip: string, on: boolean): ReactElement => (
    <button
      key={to}
      className={'ib' + (on ? ' on' : '')}
      aria-label={tip}
      data-tip={tip}
      onClick={() => {
        void leaveEdit();
        setUI({ menu: null, modal: null });
        navigate(to);
      }}
    >
      <Ic n={icon} s={19} />
    </button>
  );
  const files = route.name === 'home' || route.name === 'node' || route.name === 'trash';
  return (
    <nav className="rail" aria-label="Sections">
      {it('/', 'layers', 'Library', files)}
      {it('/graph', 'graph', 'Graph', route.name === 'graph')}
      {owner ? (
        <>
          {it('/people', 'user', 'People', route.name === 'people')}
          {it('/teams', 'users', 'Teams', route.name === 'teams' || route.name === 'team')}
          {it('/audit', 'activity', 'Audit', route.name === 'audit')}
        </>
      ) : null}
      <div className="sp" />
      {it('/settings/tokens', 'key', 'API tokens', route.name === 'tokens')}
      {it('/settings/connections', 'plug', 'Connections', route.name === 'connections')}
      <button className="ib" aria-label="Theme" data-tip="Theme" onClick={toggleTheme}>
        <Ic n={isDark() ? 'sun' : 'moon'} s={18} />
      </button>
    </nav>
  );
}

export function DesktopShell(): ReactElement {
  const route = useRoute();
  const drawer = useUI((s) => s.drawer);
  const mTree = useUI((s) => s.mTree);
  useUI((s) => s.theme);
  const pm = PAGE_VIEWS.has(route.name);
  const nodeId = route.name === 'node' ? route.id : null;
  const nq = useNode(nodeId);
  const showDrawer = !pm && !!drawer && !!nq.data && route.name === 'node' && nq.data.id === nodeId;
  return (
    <div className={'shell' + (showDrawer ? ' with-drawer' : '') + (pm ? ' page-mode' : '') + (mTree ? ' m-tree' : '')}>
      <Top />
      <Rail route={route} />
      <aside className="tree" aria-label="Folders">
        <TreePane />
      </aside>
      <main className="main" id="main">
        <Main route={route} />
      </main>
      <aside className="drawer" aria-label="Details">
        {showDrawer && nodeId ? <DrawerContent id={nodeId} /> : null}
      </aside>
      <div
        className="scrim"
        onClick={() => {
          setUI({ mTree: false, ...(window.matchMedia('(max-width:860px)').matches ? { drawer: null } : {}) });
          void getUI;
        }}
      />
    </div>
  );
}
