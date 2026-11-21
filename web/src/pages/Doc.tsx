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
import { lazy, Suspense, useState } from 'react';

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

/** Version status as quiet text: "Published v3", newer versions and drafts in a word. Opens History. */
export function VersionText({ node }: { node: NodeT }): ReactElement {
  const h = node.head_version ?? 0;
  const p = node.published_version ?? null;
  const newer = h - (p ?? 0);
  const tip = (p ? 'Published v' + p : 'Not published') + (newer > 0 ? ', ' + newer + ' newer' : '') + (node.has_draft ? ', draft' : '');
  return (
    <button
      className="vtext"
      aria-label="Versions"
      data-tip={tip}
      onClick={(e) => (isMobile() ? openMenu('versions', e.currentTarget, node.id) : setUI({ drawer: 'history', menu: null }))}
    >
      <span className={'d' + (p ? (newer > 0 || node.has_draft ? ' warn' : '') : ' off')} />
      {p ? (
        <span>
          Published <b>v{p}</b>
        </span>
      ) : (
        <span>Not published</span>
      )}
      {newer > 0 ? <span className="vn2">+{newer}</span> : null}
    </button>
  );
}

type SkillFile = NonNullable<Skill['files']>[number];
type Tab = { key: string; label: string; icon: string; files?: { f: SkillFile; label: string }[]; go?: string; sub?: boolean };

/** Tabs of the skill's own top level: SKILL.md, sub-skills, then each folder (and any other root file). */
function skillTabs(files: SkillFile[]): Tab[] {
  const md = files.find((f) => f.path === 'SKILL.md');
  const subs = files.filter((f) => f.kind === 'skill');
  const folders = new Map<string, { f: SkillFile; label: string }[]>();
  const roots: SkillFile[] = [];
  for (const f of files) {
    if (f === md || f.kind === 'skill') continue;
    const i = f.path.indexOf('/');
    if (i < 0) roots.push(f);
    else {
      const k = f.path.slice(0, i);
      folders.set(k, [...(folders.get(k) ?? []), { f, label: f.path.slice(i + 1) }]);
    }
  }
  const tabs: Tab[] = [];
  if (md) tabs.push({ key: 'md', label: 'SKILL.md', icon: 'file', go: md.id });
  if (subs.length) tabs.push({ key: 'subs', label: 'Sub-skills', icon: 'sparkles', files: subs.map((f) => ({ f, label: f.path })), sub: true });
  for (const [k, v] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) tabs.push({ key: 'f:' + k, label: k, icon: 'folder', files: v });
  for (const f of roots) tabs.push({ key: 'r:' + f.id, label: f.path, icon: f.kind === 'file' ? 'file-code' : 'file', go: f.id });
  return tabs;
}

/** Skill header: name, description, and the skill's top level as tabs; a folder tab lists its files (prototype skillHead). */
export function SkillHead({ m }: { m: DocModel }): ReactElement | null {
  const head = m.head;
  const cur = m.node?.id;
  const [sel, setSel] = useState<{ at: string | undefined; key: string } | null>(null);
  if (!m.skillId || !head) return null;
  const meta = skillMeta(head);
  const canPub = m.r >= 3;
  const pend = canPub ? pendingFiles(head).length : 0;
  const path = head.path.split('/').filter(Boolean);
  const folderName = path[path.length - 1] ?? '';
  const tabs = skillTabs(head.files ?? []);
  const here = tabs.find((t) => t.go === cur || t.files?.some((x) => x.f.id === cur));
  const key = sel && sel.at === cur ? sel.key : (here?.key ?? 'md');
  const open = tabs.find((t) => t.key === key);
  const parent = parentSkill(head);
  const dirty = (f: SkillFile): boolean => f.kind !== 'skill' && m.r >= 2 && ((f.id === cur && !!m.node?.has_draft) || (f.head_version ?? 0) > (f.published_version ?? 0));
  return (
    <div className="skhead">
      <div className="skt">
        <span className="skic">
          <Ic n="sparkles" s={17} />
        </span>
        <div className="grow">
          <code>{meta.name || folderName}</code>
          {meta.description ? <p>{meta.description}</p> : null}
        </div>
        {pend ? (
          <button className="btn sm primary" data-tip="Publish the skill" onClick={() => setUI({ modal: { type: 'skill-publish', id: m.skillId!, open: null }, menu: null })}>
            <Ic n="rocket" s={13} />
            <span>{pend}</span>
          </button>
        ) : null}
      </div>
      <div className="stabs" role="tablist">
        {parent ? (
          <button className="sback" aria-label={'Back to ' + parent} data-tip={'Back to ' + parent} onClick={() => void goNode('skills/' + parent)}>
            <Ic n="chev-l" s={14} />
          </button>
        ) : null}
        {tabs.map((t) => (
          <button
            key={t.key}
            className={'stab' + (t.key === key ? ' on' : '') + (t.sub ? ' sub' : '')}
            role="tab"
            aria-selected={t.key === key}
            onClick={() => (t.go ? void goNode(t.go) : setSel({ at: cur, key: t.key }))}
          >
            <Ic n={t.icon} s={14} />
            <span>{t.label}</span>
            {t.files ? <span className="cnt">{t.files.length}</span> : null}
            {t.go && head.files?.some((f) => f.id === t.go && dirty(f)) ? <span className={'sfd' + (t.go === cur && m.node?.has_draft ? ' dr' : '')} /> : null}
          </button>
        ))}
      </div>
      {open?.files ? (
        <div className="flist">
          {open.files.map(({ f, label }) => (
            <button key={f.id} className={'frow' + (f.id === cur ? ' on' : '') + (f.kind === 'skill' ? ' sub' : '')} onClick={() => void goNode(f.id)}>
              <Ic n={f.kind === 'skill' ? 'sparkles' : f.kind === 'file' ? 'file-code' : 'file'} s={15} />
              <span className="fn">{label}</span>
              <span className="fi">
                {f.kind === 'skill' ? 'Sub-skill' : f.published_version ? 'v' + f.published_version : 'Not published'}
                {dirty(f) ? <span className={'sfd' + (f.id === cur && m.node?.has_draft ? ' dr' : '')} /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A sub-skill's canonical path is skills/<parent>/<path>: its parent skill's name, or null. */
function parentSkill(head: Skill): string | null {
  const c = head.canonical_path?.split('/') ?? [];
  return c.length >= 3 && c[0] === 'skills' ? c[1]! : null;
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
          <VersionText node={node} />
          <span className="sep" />
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
