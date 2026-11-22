import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { Ic } from '../lib/icons';
import { hue, initials, CLIENT_C } from '../lib/util';
import { role, type Item, type NodeT } from '../api/hooks';

/** Shared atoms from the prototype: avatars, icon buttons, status marks, empty states. */

export function Av({ name, s = 24, style }: { name: string | null | undefined; s?: number; style?: CSSProperties }): ReactElement | null {
  if (!name) return null;
  return (
    <span className="av" style={{ ['--h' as string]: hue(name), ['--s' as string]: s + 'px', ...style }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function TeamAv({ id, name, s = 24 }: { id: string; name: string; s?: number }): ReactElement {
  if (id === 'everyone')
    return (
      <span className="av sq ev" style={{ ['--s' as string]: s + 'px' }}>
        <Ic n="globe" s={Math.round(s * 0.55)} />
      </span>
    );
  return (
    <span className="av sq" style={{ ['--h' as string]: hue(name), ['--s' as string]: s + 'px' }}>
      <Ic n="users" s={Math.round(s * 0.55)} />
    </span>
  );
}

export function ClientAv({ name, s = 28 }: { name: string; s?: number }): ReactElement {
  return (
    <span className="av sq" style={{ ['--s' as string]: s + 'px', background: CLIENT_C[name] ?? 'var(--muted)', color: '#fff' }}>
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function IB({
  icon,
  tip,
  onClick,
  className = 'ib',
  s = 17,
  disabled,
  ...rest
}: {
  icon: string;
  tip: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  s?: number;
  disabled?: boolean;
  [k: `data-${string}`]: string | undefined;
}): ReactElement {
  return (
    <button className={className} aria-label={tip.split('|')[0]} data-tip={tip} onClick={onClick} disabled={disabled} {...rest}>
      <Ic n={icon} s={s} />
    </button>
  );
}

/** Document status mark (prototype mark()): draft dot, not published ring, newer amber, published check. */
export function DocMark({ n }: { n: Pick<NodeT, 'access' | 'has_draft' | 'published_version' | 'head_version'> }): ReactElement | null {
  if (role(n) < 2) return null;
  const h = n.head_version ?? 0;
  const p = n.published_version ?? null;
  if (n.has_draft) return <span className="mk dot" data-tip="Draft in progress" />;
  if (p == null) return <span className="mk ring" data-tip="Not published" />;
  if (h > p) return <span className="mk amber" data-tip={`v${h} newer than published v${p}`} />;
  return (
    <span className="mk ok" data-tip={`Published v${p}`}>
      <Ic n="check" s={13} />
    </span>
  );
}

/** Aggregate state of a skill folder (prototype skillMark()). */
export function SkillMark({ n }: { n: Pick<Item, 'access' | 'skill'> }): ReactElement | null {
  const st = n.skill?.state;
  if (role(n) < 2 || !st) return null;
  if (st === 'draft') return <span className="mk dot" data-tip="Draft in progress" />;
  if (st === 'unpublished') return <span className="mk ring" data-tip="Not published" />;
  if (st === 'pending') {
    const p = n.skill?.pending ?? 0;
    return <span className="mk amber" data-tip={`${p} ${p === 1 ? 'file' : 'files'} to publish`} />;
  }
  return (
    <span className="mk ok" data-tip="Published">
      <Ic n="check" s={13} />
    </span>
  );
}

export function Empty({ icon, children, pad, eic = true }: { icon: string; children?: ReactNode; pad?: string; eic?: boolean }): ReactElement {
  return (
    <div className="empty" style={pad ? { padding: pad } : undefined}>
      {eic ? (
        <span className="eic">
          <Ic n={icon} s={22} />
        </span>
      ) : (
        <Ic n={icon} s={20} />
      )}
      {children}
    </div>
  );
}

export function Spinner(): ReactElement {
  return (
    <div className="empty" style={{ padding: '60px 0' }} aria-busy="true">
      <Ic n="loader" s={20} c="spin" />
    </div>
  );
}

export function scopeChips(sc: string[]): ReactElement[] {
  return sc.map((s) => (
    <span key={s} className={'chip ' + (s === 'read' ? '' : s === 'write' ? 'acc' : 'warn')} style={{ marginRight: 4 }}>
      {s}
    </span>
  ));
}

/** Icon of a tree node (prototype nodeIcon). */
export function nodeIcon(
  n: { kind: 'folder' | 'doc'; is_area?: boolean; area?: string | null; is_skill?: boolean; is_prototype?: boolean; name: string; format?: string },
  open = false,
): string {
  if (n.kind === 'folder') {
    if (n.is_area) return n.area === 'rules' ? 'scroll' : n.area === 'skills' ? 'sparkles' : n.area === 'prototypes' ? 'app-window' : 'book';
    if (n.is_skill) return 'sparkles';
    if (n.is_prototype) return 'app-window';
    return open ? 'folder-open' : 'folder';
  }
  return n.format && n.format !== 'markdown' ? 'file-code' : 'file';
}
