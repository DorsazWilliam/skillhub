import { useEffect, useRef, type ReactElement } from 'react';
import { useChildren, role, qc, type Item, type NodeT } from '../api/hooks';
import { Ic } from '../lib/icons';
import { DocMark, SkillMark, nodeIcon, IB } from '../ui/common';
import { setUI, toggleOpen, useUI, openMenu, getUI } from '../state';
import { goNode, moveNode, renameNode } from '../actions';
import { useRoute, navigate } from '../router';
import { useMe } from '../api/hooks';

/** Lazy folder tree (prototype treePane/treeRows): one list_children per opened folder, drag and drop to move. */

function cachedNode(id: string): NodeT | undefined {
  return qc.getQueryData<NodeT>(['node', id]);
}

function insideSkill(id: string): boolean {
  let cur: string | null = id;
  for (let i = 0; cur && i < 40; i++) {
    const n = cachedNode(cur);
    if (!n) return false;
    if (n.kind === 'folder' && n.is_skill && !n.is_area) return true;
    cur = n.parent_id;
  }
  return false;
}

function isDesc(id: string, anc: string): boolean {
  let cur: string | null = id;
  for (let i = 0; cur && i < 40; i++) {
    if (cur === anc) return true;
    cur = cachedNode(cur)?.parent_id ?? null;
  }
  return false;
}

export function canDrop(id: string, dest: string): boolean {
  const n = cachedNode(id);
  const d = cachedNode(dest);
  if (!n || !d || !n.parent_id) return false;
  const p = cachedNode(n.parent_id);
  return (
    dest !== id &&
    !isDesc(dest, id) &&
    dest !== n.parent_id &&
    role(p) >= 4 &&
    role(d) >= 4 &&
    d.area === n.area &&
    !(n.kind === 'folder' && d.area === 'rules') &&
    !(n.area === 'skills' && n.kind === 'doc' && !insideSkill(dest))
  );
}

function RenameInput({ n }: { n: Item }): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = (save: boolean): void => {
    const v = ref.current?.value ?? n.name;
    setUI({ renaming: null });
    if (save) void renameNode(n.id, v);
  };
  return (
    <input
      id="rn"
      ref={ref}
      defaultValue={n.name}
      aria-label="Name"
      onClick={(e) => e.stopPropagation()}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
      }}
    />
  );
}

function Row({ n, d, parent }: { n: Item; d: number; parent: Item | null }): ReactElement {
  const open = useUI((s) => s.open.has(n.id));
  const renaming = useUI((s) => s.renaming === n.id);
  const route = useRoute();
  const sel = route.name === 'node' && route.id === n.id;
  const ar = n.is_area;
  const sk = !ar && n.kind === 'folder' && !!n.is_skill;
  const mv = !!parent && !ar && n.name !== 'SKILL.md' && role(parent) >= 4;
  const hoverT = useRef(0);
  const kids = useChildren(n.id, n.kind === 'folder' && open);

  const onClick = (): void => {
    if (getUI().renaming === n.id) return;
    if (n.kind === 'folder') {
      const selMd = route.name === 'node' && sk && (kids.data ?? []).some((k) => k.id === route.id && k.name === 'SKILL.md');
      if ((sel || selMd) && route.name === 'node') {
        toggleOpen(n.id);
        return;
      }
      toggleOpen(n.id, true);
    }
    void goNode(n.id);
  };

  return (
    <>
      <div
        className={'row' + (sel ? ' sel' : '') + (ar ? ' area a-' + (n.area === 'documentation' ? 'docs' : n.area) : '') + (sk ? ' skill' : '')}
        data-id={n.id}
        data-kind={n.kind}
        draggable={mv}
        style={{ ['--d' as string]: d }}
        role="treeitem"
        aria-expanded={n.kind === 'folder' ? open : undefined}
        aria-selected={sel}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu('ctx', null, n.id, { x: e.clientX, y: e.clientY });
        }}
        onDragStart={(e) => {
          if (!mv) return;
          setUI({ dragging: n.id });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', n.id);
          e.currentTarget.classList.add('dragging');
        }}
        onDragEnd={(e) => {
          setUI({ dragging: null });
          e.currentTarget.classList.remove('dragging');
          document.querySelectorAll('.row.drop').forEach((x) => x.classList.remove('drop'));
        }}
        onDragOver={(e) => {
          const drag = getUI().dragging;
          if (!drag || n.kind !== 'folder' || !canDrop(drag, n.id)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!e.currentTarget.classList.contains('drop')) {
            document.querySelectorAll('.row.drop').forEach((x) => x.classList.remove('drop'));
            e.currentTarget.classList.add('drop');
            clearTimeout(hoverT.current);
            hoverT.current = window.setTimeout(() => toggleOpen(n.id, true), 700);
          }
        }}
        onDragLeave={(e) => {
          e.currentTarget.classList.remove('drop');
          clearTimeout(hoverT.current);
        }}
        onDrop={(e) => {
          const drag = getUI().dragging;
          e.currentTarget.classList.remove('drop');
          clearTimeout(hoverT.current);
          setUI({ dragging: null });
          if (drag && canDrop(drag, n.id)) {
            e.preventDefault();
            void moveNode(drag, n.id);
          }
        }}
      >
        {n.kind === 'folder' ? (
          <span
            className={'tw' + (open ? ' open' : '')}
            onClick={(e) => {
              e.stopPropagation();
              toggleOpen(n.id);
            }}
          >
            <Ic n="chev-r" s={13} />
          </span>
        ) : (
          <span className="tw" />
        )}
        <Ic n={nodeIcon(n, open)} s={16} c="ri" />
        {renaming ? <RenameInput n={n} /> : <span className="nm">{n.name}</span>}
        {n.kind === 'folder' && n.inherit === false ? (
          <span className="lk" data-tip="Not inheriting access">
            <Ic n="link-off" s={12} />
          </span>
        ) : null}
        {n.kind === 'doc' ? <DocMark n={n} /> : sk ? <SkillMark n={n} /> : null}
        <IB
          className="ib xs more"
          icon="more"
          s={15}
          tip="Actions"
          onClick={(e) => {
            e.stopPropagation();
            openMenu('ctx', e.currentTarget, n.id);
          }}
        />
      </div>
      {n.kind === 'folder' && open ? (
        kids.data ? (
          kids.data.length ? (
            <TreeRows items={kids.data} d={d + 1} parent={n} />
          ) : (
            <div className="empty-row" style={{ ['--d' as string]: d }}>
              Empty
            </div>
          )
        ) : (
          <div className="empty-row" style={{ ['--d' as string]: d }}>
            <Ic n="loader" s={12} c="spin" />
          </div>
        )
      ) : null}
    </>
  );
}

function TreeRows({ items, d, parent }: { items: Item[]; d: number; parent: Item | null }): ReactElement {
  return (
    <>
      {items.map((n) => (
        <Row key={n.id} n={n} d={d} parent={parent} />
      ))}
    </>
  );
}

export function TreePane(): ReactElement {
  const roots = useChildren(null);
  const me = useMe();
  const route = useRoute();
  const owner = me.data?.user.org_role === 'owner';
  const anyManager = (roots.data ?? []).some((r) => role(r) >= 4) || owner;
  return (
    <>
      <div className="tree-head">
        <span className="lbl">Library</span>
        <IB className="ib xs" icon="graph" s={15} tip="Graph" onClick={() => navigate('/graph')} />
        <IB className="ib xs" icon="chev-d" s={15} tip="Collapse all" onClick={() => setUI({ open: new Set() })} />
      </div>
      <div className="tree-body" id="tree-body" role="tree" aria-label="Library">
        {roots.data ? (
          roots.data.length ? (
            <TreeRows items={roots.data} d={0} parent={null} />
          ) : (
            <div className="empty" style={{ padding: '40px 0' }}>
              <Ic n="folder" s={20} />
            </div>
          )
        ) : null}
      </div>
      {anyManager ? (
        <div className="tree-foot">
          <button className={'btn ghost sm' + (route.name === 'trash' ? ' on' : '')} onClick={() => navigate('/trash')} style={{ color: 'var(--muted)' }}>
            <Ic n="trash" s={14} />
            <span>Trash</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
