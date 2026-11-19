import { Fragment, type ReactElement } from 'react';
import { useChain } from '../api/hooks';
import { Ic } from '../lib/icons';
import { nodeIcon } from '../ui/common';
import { goNode } from '../actions';
import { areaKey } from '../lib/util';

/** Breadcrumbs from the highest readable folder (prototype crumbs). */
export function Crumbs({ id }: { id: string }): ReactElement {
  const chain = useChain(id);
  const p = chain.data ?? [];
  return (
    <nav className="crumbs" aria-label="Path">
      {p.map((n, i) => {
        const last = i === p.length - 1;
        const icn = n.is_area ? (
          <span className={'ac-' + areaKey(n.area)}>
            <Ic n={nodeIcon(n)} s={14} />
          </span>
        ) : last ? (
          <Ic n={nodeIcon(n)} s={14} />
        ) : null;
        return last ? (
          <span key={n.id} className="cur">
            {icn}
            {n.name}
          </span>
        ) : (
          <Fragment key={n.id}>
            <button onClick={() => void goNode(n.id)}>
              {icn}
              {n.name}
            </button>
            <Ic n="chev-r" s={12} />
          </Fragment>
        );
      })}
    </nav>
  );
}
