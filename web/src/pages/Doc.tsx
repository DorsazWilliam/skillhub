import type { ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { ago, splitFM } from '../lib/util';
import { Av, IB, Empty, Spinner, nodeIcon } from '../ui/common';
import { Confirm, copyText } from '../ui/feedback';
import { Markdown } from '../ui/Markdown';
import { setUI, openMenu, useUI } from '../state';
import { startEdit, discardDraft, goNode, isMobile } from '../actions';
import { useUsers, role, type NodeT, type Skill } from '../api/hooks';
import { useDocModel, useDraftInfo, useLint, pendingFiles, skillMeta, type DocModel } from './docModel';
import { Crumbs } from './Crumbs';
import { lazy, Suspense } from 'react';

const Editor = lazy(() => import('../editor/Editor'));

export function useUserName(id: string | null | undefined): string | null {
  const users = useUsers(!!id);
  if (!id) return null;
  return users.data?.find((u) => u.id === id)?.name ?? null;
}

/** Guideline warnings button (prototype lintBtn). */
export function LintBtn({ node, v }: { node: NodeT | undefined; v: number | 'draft' | null }): ReactElement | null {
  const w = useLint(node, v);
  if (!node || !w.data) return null;
  const n = w.data.warnings.length;
  if (!n) {
    const k = w.data.dismissed.length;
    return k ? (
      <button className="lint-btn off" aria-label={`${k} dismissed`} data-tip="Dismissed" onClick={(e) => openMenu('lint', e.currentTarget, node.id)}>
        <Ic n="eye-off" s={13} />
        {k}
      </button>
    ) : null;
  }
  return (
    <button className="lint-btn" aria-label={`${n} warnings`} data-tip="Guidelines" onClick={(e) => openMenu('lint', e.currentTarget, node.id)}>
      <Ic n="alert" s={13} />
      {n}
    </button>
  );
}

/** Version pill (prototype pillHtml). */
export function Pill({ node }: { node: NodeT }): ReactElement {
  const h = node.head_version ?? 0;
  const p = node.published_version ?? null;
  const tip = (p ? 'Published v' + p : 'Not published') + (h > (p ?? 0) ? ', ' + (h - (p ?? 0)) + ' newer' : '') + (node.has_draft ? ', draft' : '');
  return (
    <button className="pill-btn" aria-label="Versions" data-tip={tip} onClick={(e) => openMenu('versions', e.currentTarget, node.id)}>
      {p ? (
        <span className="pp ok">
          <Ic n="check" s={11} />v{p}
        </span>
      ) : (
        <span className="pp mute">
          <Ic n="eye-off" s={11} />
        </span>
      )}
      {h > (p ?? 0) ? <span className="pp warn">+{h - (p ?? 0)}</span> : null}
      {node.has_draft ? <span className="pp dot" /> : null}
      <Ic n="chev-d" s={13} />
    </button>
  );
}

/** Skill header: name, description, and every file of the skill one click away (prototype skillHead). */
export function SkillHead({ m }: { m: DocModel }): ReactElement | null {
  const head = m.head;
  if (!m.skillId || !head) return null;
  const meta = skillMeta(head);
  const canPub = m.r >= 3;
  const pend = canPub ? pendingFiles(head).length : 0;
  const path = head.path.split('/').filter(Boolean);
  const folderName = path[path.length - 1] ?? '';
  return (
    <div className="skhead">
      <div className="skt">
        <span className="skic">
          <Ic n="sparkles" s={17} />
        </span>
        <div className="grow">
          <div className="row-flex" style={{ gap: 6 }}>
            <ParentSkill head={head} />
            <code>{meta.name || folderName}</code>
          </div>
          {meta.description ? <p>{meta.description}</p> : null}
        </div>
        {pend ? (
          <button className="btn sm primary" data-tip="Publish the skill" onClick={() => setUI({ modal: { type: 'skill-publish', id: m.skillId!, open: null }, menu: null })}>
            <Ic n="rocket" s={13} />
            <span>{pend}</span>
          </button>
        ) : null}
      </div>
      <div className="sfiles" role="tablist">
        {(head.files ?? []).map((f) => {
          const on = f.id === m.node?.id;
          const sub = f.kind === 'skill';
          const dirty = !sub && m.r >= 2 && ((on && m.node?.has_draft) || (f.head_version ?? 0) > (f.published_version ?? 0));
          const dr = on && !!m.node?.has_draft;
          return (
            <button
              key={f.id}
              className={'sf' + (on ? ' on' : '') + (sub ? ' sub' : '')}
              role="tab"
              aria-selected={on}
              data-tip={sub ? 'Sub-skill' : undefined}
              onClick={() => void goNode(f.id)}
            >
              <Ic n={sub ? 'sparkles' : f.kind === 'file' ? 'file-code' : 'file'} s={13} />
              <span>{f.path}</span>
              {dirty ? <span className={'sfd' + (dr ? ' dr' : '')} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ParentSkill({ head }: { head: Skill }): ReactElement | null {
  // A sub-skill's canonical path is skills/<parent>/<path>: link the parent skill by its canonical path.
  const c = head.canonical_path?.split('/') ?? [];
  if (c.length < 3 || c[0] !== 'skills') return null;
  const parent = c[1]!;
  return (
    <>
      <button className="skp" data-tip="Parent skill" onClick={() => void goNode('skills/' + parent)}>
        {parent}
      </button>
      <Ic n="chev-r" s={12} c="faint" />
    </>
  );
}

export function CodeView({ src, name }: { src: string; name: string }): ReactElement {
  const lines = src.replace(/\n$/, '').split('\n');
  return (
    <div className="code">
      <div className="code-h">
        <Ic n="file-code" s={14} />
        <span>{name}</span>
        <span className="grow" />
        <span className="faint">{lines.length}</span>
      </div>
      <pre>
        {lines.map((l, i) => (
          <span key={i}>
            <span className="ln">{i + 1}</span>
            {l || ' '}
            {i < lines.length - 1 ? '\n' : null}
          </span>
        ))}
      </pre>
    </div>
  );
}

export function Banner({ m }: { m: DocModel }): ReactElement | null {
  const d = useDraftInfo(m.node);
  const byName = useUserName(d.data?.draft?.updated_by);
  const node = m.node;
  if (!node || m.v == null) return null;
  const pub = node.published_version ?? null;
  if (m.v === 'draft') {
    return (
      <div className="banner draft">
        <Ic n="pencil" s={15} />
        <div className="grow">
          <b>Draft</b>
          <Av name={byName} s={18} />
          <span className="muted">{ago(d.data?.draft?.updated_at)}</span>
        </div>
        <button className="btn sm" onClick={() => startEdit(node.id)}>
          <Ic n="pencil" s={13} />
          <span>Continue</span>
        </button>
        <button className="btn sm" aria-label="Compare" onClick={() => setUI({ modal: { type: 'diff', id: node.id, a: node.head_version ?? 0, b: 'draft' } })}>
          <Ic n="diff" s={13} />
        </button>
        <Confirm className="btn sm ghost danger" label="Discard draft" tip="Discard draft" onConfirm={() => void discardDraft(node.id)}>
          <Ic n="trash" s={13} />
        </Confirm>
      </div>
    );
  }
  if (m.r >= 2 && m.v !== pub) {
    const v = m.v;
    return (
      <div className="banner old">
        <Ic n="clock" s={15} />
        <div className="grow">
          <b>v{v}</b>
          <span className="muted">{pub ? 'published is v' + pub : 'not published'}</span>
        </div>
        {pub ? (
          <button className="btn sm" data-tip="Show published" aria-label="Show published" onClick={() => setUI({ viewing: pub })}>
            <Ic n="back" s={13} />
          </button>
        ) : null}
        <button className="btn sm" data-tip="Compare" aria-label="Compare" onClick={() => setUI({ modal: { type: 'diff', id: node.id, a: v > 1 ? v - 1 : 0, b: v } })}>
          <Ic n="diff" s={13} />
        </button>
        {m.r >= 3 ? (
          <button className="btn sm primary" onClick={() => setUI({ modal: { type: 'publish', id: node.id, v } })}>
            <Ic n="rocket" s={13} />
            <span>Publish v{v}</span>
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

/** The reading body: code view, skill card for a plain document with frontmatter, or rendered markdown. */
export function DocBody({ m, skipH1 }: { m: DocModel; skipH1?: boolean }): ReactElement {
  const node = m.node;
  if (!node) return <Spinner />;
  if (m.v == null)
    return (
      <Empty icon={nodeIcon(node)}>
        {m.r >= 2 ? (
          <button className="btn primary" onClick={() => startEdit(node.id)}>
            <Ic n="pencil" s={14} />
            <span>Start writing</span>
          </button>
        ) : null}
      </Empty>
    );
  if (!m.content) return <Spinner />;
  if (m.isCode) return <CodeView src={m.content.markdown} name={node.name} />;
  const { fm, body } = splitFM(m.content.markdown);
  const showCard = !!fm?.['name'] && !m.skillId;
  return (
    <>
      {showCard ? (
        <div className="skill-card">
          <span className="sk" data-tip="Skill, visible to agents">
            <Ic n="sparkles" s={16} />
          </span>
          <div className="grow">
            <code>{fm?.['name']}</code>
            <p>{fm?.['description'] ?? ''}</p>
          </div>
        </div>
      ) : null}
      <Markdown src={body} full={m.content.markdown} links={m.content.links} area={m.area} skipH1={skipH1} />
    </>
  );
}

export function DocActs({ m }: { m: DocModel }): ReactElement | null {
  const node = m.node;
  if (!node) return null;
  const r = m.r;
  const head = node.head_version ?? 0;
  return (
    <div className="acts">
      <LintBtn node={node} v={m.v} />
      {r >= 2 ? (
        <>
          <Pill node={node} />
          <IB icon="pencil" tip="Edit|E" onClick={() => startEdit(node.id)} />
        </>
      ) : null}
      {r >= 3 && head ? (
        m.skillId ? (
          <IB icon="rocket" tip="Publish skill" onClick={() => setUI({ modal: { type: 'skill-publish', id: m.skillId!, open: null } })} />
        ) : (
          <IB icon="rocket" tip="Publish" onClick={() => setUI({ modal: { type: 'publish', id: node.id, v: head } })} />
        )
      ) : null}
      {r >= 4 && node.parent_id ? <IB icon="user-plus" tip="Share" onClick={() => setUI({ modal: { type: 'share', id: node.parent_id! } })} /> : null}
      <IB className="ib hide-m" icon="link" tip="Copy [[link]]" onClick={() => copyLink(m.content?.canonical_path ?? node.canonical_path)} />
      <IB icon="panel-right" tip="Details" onClick={() => setUI((s) => ({ drawer: s.drawer ? null : 'links' }))} />
      {r >= 2 ? <IB icon="more" tip="More" onClick={(e) => openMenu('more', e.currentTarget, node.id)} /> : null}
    </div>
  );
}

export function copyLink(canon: string | null | undefined): void {
  if (!canon) return;
  copyText('[[' + canon.replace(/\/SKILL\.md$/, '').replace(/\.md$/, '') + ']]');
}

export function DocPage({ id }: { id: string }): ReactElement {
  const m = useDocModel(id);
  const editing = useUI((s) => s.editing === id);
  if (!m.node) return <div className="page">{m.error ? <Empty icon="lock" /> : <Spinner />}</div>;
  if (editing && role(m.node) >= 2)
    return (
      <Suspense fallback={<Spinner />}>
        <Editor node={m.node} mobile={isMobile()} />
      </Suspense>
    );
  return (
    <div className="page">
      <div className="dh">
        <Crumbs id={id} />
        <DocActs m={m} />
      </div>
      <SkillHead m={m} />
      <Banner m={m} />
      <DocBody m={m} />
    </div>
  );
}
