import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useChain, type NodeT } from '../api/hooks';
import { Ic } from '../lib/icons';
import { nodeIcon } from '../ui/common';
import { goNode } from '../actions';
import { areaKey } from '../lib/util';
import { openMenu } from '../state';

function icon(n: NodeT, last: boolean): ReactElement | null {
  if (n.is_area)
    return (
      <span className={'ac-' + areaKey(n.area)}>
        <Ic n={nodeIcon(n)} s={14} />
      </span>
    );
  return last ? <Ic n={nodeIcon(n)} s={14} /> : null;
}

function Seg({ n, onClick }: { n: NodeT; onClick?: () => void }): ReactElement {
  return (
    <span className="cseg">
      <button onClick={onClick} title={n.name}>
        {icon(n, false)}
        <span>{n.name}</span>
      </button>
      <Ic n="chev-r" s={12} />
    </span>
  );
}

function Cur({ n, measure }: { n: NodeT; measure?: boolean }): ReactElement {
  return (
    <span className={measure ? 'mcur' : 'cur'}>
      {icon(n, true)}
      <span>{n.name}</span>
    </span>
  );
}

function Fold({ onClick, tip }: { onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; tip?: string }): ReactElement {
  return (
    <span className="cseg">
      <button className="cfold" aria-label="Show full path" data-tip={tip} onClick={onClick}>
        <Ic n="more" s={14} />
      </button>
      <Ic n="chev-r" s={12} />
    </span>
  );
}

/** Fold order: levels after the area from the left (the parent too), then the area itself. Returns the first h, in path order. */
function foldedIdx(n: number, h: number): number[] {
  const order = [...Array.from({ length: Math.max(0, n - 2) }, (_, i) => i + 1), ...(n > 1 ? [0] : [])];
  return order.slice(0, h).sort((a, b) => a - b);
}

/**
 * Breadcrumbs from the highest readable folder. The whole path shows when it fits; otherwise levels fold into one
 * menu, one at a time from the left, only as many as needed (the area last). The current item is never truncated.
 */
export function Crumbs({ id }: { id: string }): ReactElement {
  const p = useChain(id).data ?? [];
  const nav = useRef<HTMLElement>(null);
  const meas = useRef<HTMLDivElement>(null);
  const [hide, setHide] = useState(0);
  const key = p.map((n) => n.id).join('/');

  useLayoutEffect(() => {
    const el = nav.current;
    const m = meas.current;
    if (!el || !m || p.length < 2) {
      setHide(0);
      return;
    }
    const fit = (): void => {
      const w = [...m.children].map((c) => c.getBoundingClientRect().width + 2);
      const fold = w.pop() ?? 0;
      const avail = el.clientWidth;
      let total = w.reduce((a, b) => a + b, 0);
      let h = 0;
      if (total > avail) {
        total += fold;
        const order = foldedIdx(p.length, p.length - 1);
        const seq = [...order.filter((i) => i > 0), ...order.filter((i) => i === 0)];
        while (h < seq.length && total > avail) total -= w[seq[h++]!]!;
      }
      setHide(h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!p.length) return <nav className="crumbs" aria-label="Path" ref={nav} />;
  const last = p[p.length - 1]!;
  const fi = foldedIdx(p.length, hide);
  const folded = fi.map((i) => p[i]!);
  const fold = folded.length ? (
    <Fold key="fold" tip={folded.map((x) => x.name).join(' / ')} onClick={(e) => openMenu('crumbs', e.currentTarget, id + ':' + hide)} />
  ) : null;
  return (
    <nav className="crumbs" aria-label="Path" ref={nav}>
      <div className="cmeasure" ref={meas} aria-hidden="true">
        {p.slice(0, -1).map((n) => (
          <Seg key={n.id} n={n} />
        ))}
        <Cur n={last} measure />
        <Fold />
      </div>
      {p.slice(0, -1).map((n, i) =>
        fi.includes(i) ? (i === fi[0] ? fold : null) : <Seg key={n.id} n={n} onClick={() => void goNode(n.id)} />,
      )}
      <Cur n={last} />
    </nav>
  );
}

/** The folded levels of the path, as menu items. The menu id is "<node id>:<folded count>". */
export function CrumbsMenu({ id, done }: { id: string; done: () => void }): ReactElement {
  const [nid, k] = id.split(':');
  const p = useChain(nid ?? null).data ?? [];
  const mid = foldedIdx(p.length, Number(k ?? 0)).map((i) => p[i]!);
  return (
    <>
      {mid.map((n, i) => (
        <button
          key={n.id}
          className="mi"
          style={{ paddingLeft: 9 + i * 12 }}
          onClick={() => {
            done();
            void goNode(n.id);
          }}
        >
          <Ic n={nodeIcon(n)} s={15} />
          <span className="ell">{n.name}</span>
        </button>
      ))}
    </>
  );
}
