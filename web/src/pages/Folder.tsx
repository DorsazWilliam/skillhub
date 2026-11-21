import type { ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { ago, AREAS, areaKey, RULES_CAP, type AreaKey } from '../lib/util';
import { Av, DocMark, SkillMark, IB, Empty, Spinner, nodeIcon } from '../ui/common';
import { setUI, openMenu } from '../state';
import { goNode, newDoc, newFolder, newSkill } from '../actions';
import { useChildren, useNode, useChain, useGraph, useRulesSize, role, type Item, type NodeT } from '../api/hooks';
import { LintBtn } from './Doc';
import { Crumbs } from './Crumbs';
import { navigate } from '../router';

export function AreaChip({ k }: { k: AreaKey }): ReactElement {
  return (
    <span className="chip" data-tip={AREAS[k].tip}>
      <Ic n={k === 'rules' ? 'bot' : k === 'skills' ? 'search' : 'link'} s={12} />
      {k === 'rules' ? 'Always on' : k === 'skills' ? 'On demand' : 'Linked'}
    </span>
  );
}

/** True when the folder is a skill or sits inside one (new files and sub-skills go there). */
export function useInSkill(f: NodeT | undefined): boolean {
  const chain = useChain(f?.id ?? null);
  if (!f) return false;
  return (chain.data ?? [f]).some((n) => n.kind === 'folder' && !n.is_area && !!n.is_skill);
}

export type NewKind = { act: 'doc' | 'folder' | 'skill'; icon: string; tip: string; lbl: string };

export function newKinds(f: NodeT | undefined, inSkill: boolean): NewKind[] {
  if (!f || role(f) < 2) return [];
  const a = areaKey(f.area);
  if (a === 'rules') return f.is_area ? [{ act: 'doc', icon: 'file-plus', tip: 'New rule', lbl: 'Rule' }] : [];
  if (a === 'skills')
    return inSkill
      ? [
          { act: 'doc', icon: 'file-plus', tip: 'New file', lbl: 'File' },
          { act: 'folder', icon: 'folder-plus', tip: 'New folder', lbl: 'Folder' },
          { act: 'skill', icon: 'sparkles', tip: 'New sub-skill', lbl: 'Sub-skill' },
        ]
      : [
          { act: 'skill', icon: 'sparkles', tip: 'New skill', lbl: 'Skill' },
          { act: 'folder', icon: 'folder-plus', tip: 'New folder', lbl: 'Folder' },
        ];
  return [
    { act: 'doc', icon: 'file-plus', tip: 'New document', lbl: 'Document' },
    { act: 'folder', icon: 'folder-plus', tip: 'New folder', lbl: 'Folder' },
  ];
}

export function runNew(act: NewKind['act'], parent: string): void {
  setUI({ menu: null });
  if (act === 'doc') void newDoc(parent);
  else if (act === 'folder') void newFolder(parent);
  else void newSkill(parent);
}

function NewBtns({ f, small }: { f: NodeT; small?: boolean }): ReactElement {
  const inSkill = useInSkill(f);
  return (
    <>
      {newKinds(f, inSkill).map((k) =>
        small ? (
          <button key={k.act} className="btn sm" onClick={() => runNew(k.act, f.id)}>
            <Ic n={k.icon} s={14} />
            <span>{k.lbl}</span>
          </button>
        ) : (
          <IB key={k.act} icon={k.icon} tip={k.tip} onClick={() => runNew(k.act, f.id)} />
        ),
      )}
    </>
  );
}

export function RulesMeter(): ReactElement | null {
  const q = useRulesSize();
  if (!q.data) return null;
  const b = q.data.total_bytes;
  const cap = q.data.cap_bytes || RULES_CAP;
  const pct = Math.min(100, (b / cap) * 100);
  const st = pct > 90 ? 'bad' : pct > 70 ? 'warn' : 'ok';
  return (
    <div className={'meter ' + st} data-tip="Published rules sent to every agent on connect">
      <span className="mic">
        <Ic n="bot" s={15} />
      </span>
      <div className="mbar">
        <span style={{ width: pct.toFixed(1) + '%' }} />
      </div>
      <span className="mnum">
        {(b / 1024).toFixed(1)} / {cap / 1024} KB
      </span>
    </div>
  );
}

function ItemRow({ n }: { n: Item }): ReactElement {
  const open = (): void => void goNode(n.id);
  if (n.kind === 'folder') {
    if (n.is_skill) {
      const sk = n.skill;
      return (
        <div className="item" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
          <span className="ac-skills">
            <Ic n="sparkles" s={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="t ell">{n.name}</div>
            {sk?.description ? <div className="d">{sk.description}</div> : null}
          </div>
          {role(n) >= 2 && sk?.state ? <SkillMark n={n} /> : <span />}
          <span className="v">{sk?.version ? 'v' + sk.version : ''}</span>
          <span className="w">{sk?.files ?? ''}</span>
          <span className="faint">
            <Ic n="file" s={14} />
          </span>
        </div>
      );
    }
    return (
      <div className="item" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <span className="faint">
          <Ic n="folder" s={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="t ell">{n.name}</div>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          {n.children ?? ''}
        </span>
        <span className="v" />
        <span className="w" />
        <span />
      </div>
    );
  }
  const r = role(n);
  const v = r >= 2 ? (n.head_version ? 'v' + n.head_version : '') : n.published_version ? 'v' + n.published_version : '';
  return (
    <div className="item" onClick={open} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <span className="faint">
        <Ic n={nodeIcon(n)} s={17} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="t ell">{n.name}</div>
        {n.links ? (
          <div className="d row-flex" style={{ gap: 4 }}>
            <Ic n="link" s={11} />
            {n.links}
          </div>
        ) : null}
      </div>
      {r >= 2 ? <DocMark n={n} /> : <span />}
      <span className="v">{v}</span>
      <span className="w">{ago(n.updated_at)}</span>
      {n.author?.name ? <Av name={n.author.name} s={22} /> : <span />}
    </div>
  );
}

export function FolderPage({ id }: { id: string }): ReactElement {
  const nq = useNode(id);
  const f = nq.data;
  const kids = useChildren(id);
  if (!f) return <div className="page">{nq.error ? <Empty icon="lock" /> : <Spinner />}</div>;
  const r = role(f);
  const ar = f.is_area;
  const k = areaKey(f.area);
  const items = kids.data ?? [];
  return (
    <div className="page">
      <div className="dh">
        <Crumbs id={id} />
        <div className="acts">
          <LintBtn node={f} v={null} />
          <NewBtns f={f} />
          {r >= 4 ? <IB icon="user-plus" tip="Share" onClick={() => setUI({ modal: { type: 'share', id: f.id } })} /> : null}
          {r >= 4 && !ar ? <IB icon="more" tip="More" onClick={(e) => openMenu('more', e.currentTarget, f.id)} /> : null}
        </div>
      </div>
      <div className={'fhead' + (ar ? ' a-' + k : '')}>
        <span className="fic">
          <Ic n={ar ? AREAS[k].icon : 'folder'} s={20} />
        </span>
        <h1>{f.name}</h1>
        {ar ? <AreaChip k={k} /> : null}
        {f.inherit === false ? (
          <span className="chip warn" data-tip="Access is set here only">
            <Ic n="link-off" s={12} />
            Isolated
          </span>
        ) : null}
      </div>
      {ar && f.area === 'rules' ? <RulesMeter /> : null}
      {kids.isLoading ? (
        <Spinner />
      ) : items.length ? (
        <div className="items">
          {items.map((n) => (
            <ItemRow key={n.id} n={n} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <span className="eic">
            <Ic n={ar ? AREAS[k].icon : 'folder-open'} s={22} />
          </span>
          {r >= 2 ? (
            <div className="row-flex">
              <NewBtns f={f} small />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Counts per area for the home tiles: skills count skill folders, other areas count documents (from the graph). */
export function useAreaCounts(): Record<AreaKey, number | null> {
  const g = useGraph();
  const out: Record<AreaKey, number | null> = { rules: null, skills: null, docs: null };
  if (!g.data) return out;
  const c: Record<AreaKey, number> = { rules: 0, skills: 0, docs: 0 };
  for (const n of g.data.nodes) c[areaKey(n.area)]++;
  return c;
}

export function HomePage(): ReactElement {
  const roots = useChildren(null);
  const counts = useAreaCounts();
  return (
    <div className="page">
      <div className="fhead">
        <span className="fic">
          <Ic n="layers" s={20} />
        </span>
        <h1>Library</h1>
        <div className="grow" />
        <button className="btn" onClick={() => navigate('/graph')}>
          <Ic n="graph" s={15} />
          <span>Graph</span>
        </button>
      </div>
      <div className="tiles">
        {(roots.data ?? []).map((f) => {
          const k = areaKey(f.area);
          return (
            <button key={f.id} className={'tile a-' + k} onClick={() => void goNode(f.id)}>
              <span className="fic">
                <Ic n={AREAS[k].icon} s={18} />
              </span>
              <div>
                <b>{f.name}</b>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  <span className="num">{counts[k] ?? ''}</span> · {AREAS[k].tip}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
