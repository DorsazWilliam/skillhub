import { getUI, setUI, openMenu } from '../state';
import { isMobile } from '../actions';

/**
 * Phone gestures (prototype: row swipe actions, long-press menus, leading-edge swipe back, sheet drag with detents).
 * They work on the DOM classes the components render and call back into the app for navigation and state.
 */

export const gestureHooks: { back: (() => void) | null } = { back: null };

interface G {
  k: 'sheet' | 'edge' | 'row' | 'lp' | 'none';
  x0: number;
  y0: number;
  lock: 'x' | 'y' | null;
  m?: HTMLElement;
  h0?: number;
  h?: number;
  dy?: number;
  dx?: number;
  det?: boolean;
  moved?: boolean;
  scr?: HTMLElement;
  sw?: HTMLElement;
  row?: HTMLElement;
  base?: number;
  o?: number;
}

let t: G | null = null;
let lpT = 0;
let suppress = false;
let supT = 0;

function supClick(): void {
  suppress = true;
  clearTimeout(supT);
  supT = window.setTimeout(() => (suppress = false), 400);
}

function swClose(except?: Element | null): void {
  document.querySelectorAll('.m-sw.open').forEach((s) => {
    if (s === except) return;
    s.classList.remove('open');
    const r = s.querySelector<HTMLElement>('.m-row');
    if (r) r.style.transform = '';
  });
}

function sheetDismiss(m: HTMLElement): void {
  m.style.transition = 'transform .22s ease-in';
  m.style.transform = 'translateY(110%)';
  const sc = m.parentElement?.querySelector<HTMLElement>('.modal-scrim');
  if (sc) {
    sc.style.transition = 'opacity .22s';
    sc.style.opacity = '0';
  }
  setTimeout(() => {
    if (m.classList.contains('menu-sheet')) setUI({ menu: null });
    else if (m.classList.contains('m-drawer')) setUI({ drawer: null });
    else setUI({ modal: null, renaming: null });
  }, 210);
}

export function installGestures(): () => void {
  const onClick = (e: MouseEvent): void => {
    if (suppress) {
      suppress = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };
  const down = (e: PointerEvent): void => {
    suppress = false;
    t = null;
    clearTimeout(lpT);
    if (!isMobile() || e.button > 0) return;
    const x = e.clientX;
    const y = e.clientY;
    const target = e.target as HTMLElement;
    const modal = target.closest<HTMLElement>('.modal');
    if (modal) {
      if (target.closest('.grab,.mh,.dtabs') && !target.closest('input,select,textarea,button:not(.grab)')) {
        t = { k: 'sheet', m: modal, x0: x, y0: y, lock: null, h0: modal.getBoundingClientRect().height, det: modal.classList.contains('detent'), moved: false };
        modal.style.transition = 'none';
      }
      return;
    }
    if (target.closest('.menu,#gc,.fmt')) return;
    const open = document.querySelector('.m-sw.open');
    const row = target.closest<HTMLElement>('.m-sw>.m-row');
    if (open && !target.closest('.m-acts') && (!row || row.parentElement !== open)) {
      swClose();
      t = { k: 'none', x0: x, y0: y, lock: null };
      supClick();
      return;
    }
    const back = document.querySelector('.m-screen [data-back]');
    const ui = getUI();
    if (x < 24 && back && !ui.editing && !ui.modal && !ui.menu) {
      t = { k: 'edge', x0: x, y0: y, scr: back.closest<HTMLElement>('.m-screen') ?? undefined, lock: null };
      return;
    }
    if (row && row.parentElement) {
      const acts = row.parentElement.querySelector<HTMLElement>('.m-acts');
      t = { k: 'row', x0: x, y0: y, sw: row.parentElement, row, lock: null, base: row.parentElement.classList.contains('open') ? -(acts?.offsetWidth ?? 0) : 0 };
    }
    const lp = target.closest<HTMLElement>('[data-lp]');
    if (lp) {
      t = t ?? { k: 'lp', x0: x, y0: y, lock: null };
      lpT = window.setTimeout(() => {
        if (!t || t.lock) return;
        t = { k: 'none', x0: 0, y0: 0, lock: null };
        supClick();
        try {
          navigator.vibrate?.(8);
        } catch {
          /* unsupported */
        }
        openMenu('ctx', null, lp.dataset['lp'] ?? '');
      }, 480);
    }
  };
  const move = (e: PointerEvent): void => {
    if (!t || t.k === 'none') return;
    const x = e.clientX;
    const y = e.clientY;
    if (t.k === 'sheet' && t.m) {
      const dy = y - t.y0;
      if (Math.abs(dy) > 4) t.moved = true;
      if (!t.moved) return;
      t.dy = dy;
      if (t.det) {
        const h = Math.max(100, Math.min(window.innerHeight - 8, (t.h0 ?? 0) - dy));
        t.h = h;
        t.m.style.height = h + 'px';
      } else if (dy > 0) t.m.style.transform = `translateY(${dy}px)`;
      return;
    }
    const dx = x - t.x0;
    const dy = y - t.y0;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(lpT);
    if (t.lock == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) t.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
    if (t.lock !== 'x') return;
    if (t.k === 'edge' && t.scr) {
      t.dx = Math.max(0, dx);
      t.scr.style.transition = 'none';
      t.scr.style.transform = `translateX(${t.dx}px)`;
      return;
    }
    if (t.k === 'row' && t.sw && t.row) {
      const W = t.sw.querySelector<HTMLElement>('.m-acts')?.offsetWidth ?? 0;
      if (!W) return;
      t.o = Math.max(-W - 48, Math.min(0, (t.base ?? 0) + dx));
      t.row.classList.add('drag');
      t.row.style.transform = `translateX(${t.o}px)`;
    }
  };
  const end = (): void => {
    clearTimeout(lpT);
    const g = t;
    t = null;
    if (!g || g.k === 'none') return;
    if (g.k === 'sheet' && g.m) {
      g.m.style.transition = '';
      if (!g.moved) return;
      supClick();
      if (g.det) {
        const med = window.innerHeight * 0.55;
        const lg = window.innerHeight - 10;
        const h = g.h ?? g.h0 ?? 0;
        g.m.style.height = '';
        if (h < med * 0.72) {
          sheetDismiss(g.m);
          return;
        }
        setUI({ det: h > (med + lg) / 2 ? 'l' : 'm' });
        return;
      }
      if ((g.dy ?? 0) > Math.min(120, (g.h0 ?? 0) * 0.3)) {
        sheetDismiss(g.m);
        return;
      }
      g.m.style.transform = '';
      return;
    }
    if (g.lock !== 'x') return;
    supClick();
    if (g.k === 'edge' && g.scr) {
      const scr = g.scr;
      const w = scr.offsetWidth;
      scr.style.transition = 'transform .22s ease-out';
      if ((g.dx ?? 0) > w * 0.33) {
        scr.style.transform = 'translateX(100%)';
        setTimeout(() => gestureHooks.back?.(), 210);
      } else scr.style.transform = '';
      return;
    }
    if (g.k === 'row' && g.sw && g.row) {
      const W = g.sw.querySelector<HTMLElement>('.m-acts')?.offsetWidth ?? 0;
      g.row.classList.remove('drag');
      if (!W) return;
      const open = (g.o ?? g.base ?? 0) < -W / 2;
      swClose(g.sw);
      g.sw.classList.toggle('open', open);
      g.row.style.transform = open ? `translateX(${-W}px)` : '';
    }
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', down, { passive: true });
  document.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // Keep the editor toolbar above the on-screen keyboard.
  const vv = window.visualViewport;
  const kb = (): void => {
    if (!vv) return;
    const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', h + 'px');
    document.documentElement.classList.toggle('kb', h > 60);
  };
  vv?.addEventListener('resize', kb);
  vv?.addEventListener('scroll', kb);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointerdown', down);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    vv?.removeEventListener('resize', kb);
    vv?.removeEventListener('scroll', kb);
  };
}
