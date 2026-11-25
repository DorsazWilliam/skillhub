import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useMe, role, fetchNode } from './api/hooks';
import { ApiError } from './api/client';
import { useRoute, navigate, currentRoute } from './router';
import { getUI, setUI, closeMenuFromOutside, applyTheme } from './state';
import { mobileMQ, leaveEdit, openCommit, startEdit } from './actions';
import { DesktopShell } from './shell/Desktop';
import { MobileShell } from './mobile/Mobile';
import { MenuHost } from './ui/Menus';
import { ModalHost } from './ui/Modals';
import { Toasts, installTooltip } from './ui/feedback';
import { installGestures } from './mobile/gestures';
import { Login } from './Login';
import { Spinner } from './ui/common';
import { setBrand } from './lib/brand';

function useMobile(): boolean {
  return useSyncExternalStore(
    (f) => {
      mobileMQ.addEventListener('change', f);
      return () => mobileMQ.removeEventListener('change', f);
    },
    () => mobileMQ.matches,
  );
}

function typing(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae && (/INPUT|TEXTAREA|SELECT/.test(ae.tagName) || ae.isContentEditable || !!ae.closest('.cm-editor'));
}

/** Global keys from the prototype: / search, Ctrl K quick open, Ctrl S commit, E edit, Esc closes the top layer. */
function installKeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    const s = getUI();
    if (mod && k.toLowerCase() === 'k') {
      e.preventDefault();
      setUI({ menu: null, modal: { type: 'palette', q: '', i: 0 } });
      return;
    }
    if (mod && k.toLowerCase() === 's') {
      e.preventDefault();
      if (s.editing) void openCommit(s.editing);
      else {
        const r = currentRoute();
        if (r.name === 'node')
          void fetchNode(r.id).then((n) => {
            if (n.has_draft && role(n) >= 2) void openCommit(n.id);
          });
      }
      return;
    }
    if (k === 'Escape') {
      if (s.renaming) return;
      if (s.modal) {
        if (s.modal.type !== 'conflict') setUI({ modal: null });
        return;
      }
      if (s.menu) return setUI({ menu: null });
      if (s.searchOpen) return setUI({ searchOpen: false });
      if (document.querySelector('.ac.on')) return;
      if (s.editing) {
        void leaveEdit();
        return;
      }
      if (s.mTree) setUI({ mTree: false });
      return;
    }
    if (typing() || mod || e.altKey) return;
    if (k === '/') {
      const q = document.getElementById('q');
      if (q) {
        e.preventDefault();
        q.focus();
      }
      return;
    }
    if (k === 'e' && !s.editing) {
      const r = currentRoute();
      if (r.name !== 'node') return;
      void fetchNode(r.id).then((n) => {
        if (n.kind === 'doc' && role(n) >= 2) {
          startEdit(n.id);
        }
      });
    }
  };
  const onDown = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    if (getUI().menu && t && !t.closest('[data-menu],.menu-sheet')) closeMenuFromOutside();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onDown, true);
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDown, true);
  };
}

export function App(): ReactElement {
  const me = useMe();
  const route = useRoute();
  const mobile = useMobile();
  useEffect(() => {
    applyTheme();
    const a = installTooltip();
    const b = installGestures();
    const c = installKeys();
    return () => {
      a();
      b();
      c();
    };
  }, []);
  useEffect(() => {
    setUI({ menu: null });
  }, [mobile]);
  setBrand(me.data);
  const unauth = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (me.data && route.name === 'login' && !new URLSearchParams(window.location.search).has('invite')) navigate('/', { replace: true });
  }, [me.data, route.name]);
  if (unauth || (route.name === 'login' && (!me.data || new URLSearchParams(window.location.search).has('invite')))) return <Login error={route.name === 'login' ? route.error : null} />;
  if (!me.data)
    return (
      <div className="screen">
        <Spinner />
      </div>
    );
  return (
    <>
      {mobile ? <MobileShell /> : <DesktopShell />}
      <MenuHost />
      <ModalHost />
      <Toasts />
    </>
  );
}
