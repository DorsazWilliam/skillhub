import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ic } from '../lib/icons';

/** Toasts (prototype toast()), a hover tooltip on [data-tip] (prototype #tip), and the two-step confirm button. */

interface Toast {
  id: number;
  msg: string;
  icon?: string;
  sub?: string;
  kind?: 'bad';
  warn?: boolean;
  undo?: () => void | Promise<void>;
  in: boolean;
}

let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const f of subs) f();
};

export function toast(msg: string, o: { icon?: string; sub?: string; kind?: 'bad'; warn?: boolean; undo?: () => void | Promise<void> } = {}): void {
  const t: Toast = { id: ++seq, msg, ...o, in: false };
  toasts = [...toasts, t];
  emit();
  requestAnimationFrame(() => {
    toasts = toasts.map((x) => (x.id === t.id ? { ...x, in: true } : x));
    emit();
  });
  setTimeout(
    () => {
      toasts = toasts.map((x) => (x.id === t.id ? { ...x, in: false } : x));
      emit();
      setTimeout(() => {
        toasts = toasts.filter((x) => x.id !== t.id);
        emit();
      }, 250);
    },
    o.undo ? 6500 : 2800,
  );
}

export function errorToast(e: unknown): void {
  const msg = e instanceof Error ? e.message : 'Something went wrong';
  toast(msg, { icon: 'alert', kind: 'bad' });
}

export function Toasts(): ReactElement | null {
  const list = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => toasts,
  );
  const host = document.getElementById('toasts');
  if (!host) return null;
  return createPortal(
    list.map((t) => (
      <div key={t.id} className={'toast ' + (t.kind ?? '') + (t.in ? ' in' : '')} role="status">
        {t.icon ? <Ic n={t.icon} s={16} c={t.warn ? 'tw2' : ''} /> : null}
        <span>{t.msg}</span>
        {t.sub ? <span className="tsub">{t.sub}</span> : null}
        {t.undo ? (
          <button
            className="tbtn"
            onClick={() => {
              const u = t.undo;
              toasts = toasts.filter((x) => x.id !== t.id);
              emit();
              void u?.();
            }}
          >
            <Ic n="undo" s={13} />
            <span>Undo</span>
          </button>
        ) : null}
      </div>
    )),
    host,
  );
}

export function copyText(text: string): void {
  try {
    navigator.clipboard
      .writeText(text)
      .then(() => toast('Copied', { icon: 'check' }))
      .catch(() => toast('Select and copy manually', { icon: 'alert' }));
  } catch {
    toast('Select and copy manually', { icon: 'alert' });
  }
}

/** Hover tooltips for any [data-tip="Label|Key"], suppressed for touch. Text only, built with DOM APIs. */
export function installTooltip(): () => void {
  const tip = document.getElementById('tip');
  if (!tip) return () => undefined;
  let timer = 0;
  let forEl: Element | null = null;
  const hide = (): void => {
    clearTimeout(timer);
    forEl = null;
    tip.classList.remove('on');
  };
  const over = (e: PointerEvent): void => {
    const t = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
    if (t === forEl) return;
    hide();
    if (!t || e.pointerType === 'touch' || t.classList.contains('armed')) return;
    forEl = t;
    timer = window.setTimeout(() => {
      if (!document.body.contains(t)) return;
      const [label, key] = (t.getAttribute('data-tip') ?? '').split('|');
      tip.replaceChildren(document.createTextNode(label ?? ''));
      if (key) {
        const k = document.createElement('kbd');
        k.textContent = key;
        tip.append(k);
      }
      const r = t.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let x: number;
      let y: number;
      if (t.closest('.rail')) {
        x = r.right + 8;
        y = r.top + r.height / 2 - tr.height / 2;
      } else {
        x = r.left + r.width / 2 - tr.width / 2;
        y = r.bottom + 6;
        if (y + tr.height > window.innerHeight - 8) y = r.top - tr.height - 6;
      }
      x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
      tip.classList.add('on');
    }, 350);
  };
  document.addEventListener('pointerover', over);
  for (const ev of ['pointerdown', 'scroll', 'keydown']) document.addEventListener(ev, hide, true);
  return () => {
    document.removeEventListener('pointerover', over);
    for (const ev of ['pointerdown', 'scroll', 'keydown']) document.removeEventListener(ev, hide, true);
  };
}

/** A destructive control that asks "Sure?" on the first click (prototype data-confirm + arm()). */
export function Confirm({
  className,
  onConfirm,
  children,
  label,
  tip,
  style,
  disabled,
}: {
  className: string;
  onConfirm: () => void;
  children: ReactNode;
  label?: string;
  tip?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}): ReactElement {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={className + (armed ? ' armed' : '')}
      aria-label={label}
      data-tip={armed ? undefined : tip}
      style={style}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) setArmed(true);
        else {
          setArmed(false);
          onConfirm();
        }
      }}
    >
      {armed ? (
        <>
          <Ic n="check" s={14} />
          <span>Sure?</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
