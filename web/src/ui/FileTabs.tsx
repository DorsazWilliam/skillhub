import { useState, type ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { goNode } from '../actions';
import type { Skill } from '../api/hooks';

export type FolderFile = NonNullable<Skill['files']>[number];
type Tab = { key: string; label: string; icon: string; files?: { f: FolderFile; label: string }[]; go?: string; sub?: boolean };

/**
 * Tabs of a skill's or prototype's own top level: an optional lead tab (SKILL.md, or Preview), nested entries
 * (sub-skills, nested prototypes), then each folder, then other root files. A folder tab lists its files.
 */
function folderTabs(files: FolderFile[], lead: { file?: string; tab?: Tab }, sub: { label: string; icon: string }): Tab[] {
  const leadFile = lead.file ? files.find((f) => f.path === lead.file) : undefined;
  const subs = files.filter((f) => f.kind === 'skill');
  const folders = new Map<string, { f: FolderFile; label: string }[]>();
  const roots: FolderFile[] = [];
  for (const f of files) {
    if (f === leadFile || f.kind === 'skill') continue;
    const i = f.path.indexOf('/');
    if (i < 0) roots.push(f);
    else {
      const k = f.path.slice(0, i);
      folders.set(k, [...(folders.get(k) ?? []), { f, label: f.path.slice(i + 1) }]);
    }
  }
  const tabs: Tab[] = [];
  if (lead.tab) tabs.push(lead.tab);
  if (leadFile) tabs.push({ key: 'lead', label: leadFile.path, icon: 'file', go: leadFile.id });
  if (subs.length) tabs.push({ key: 'subs', label: sub.label, icon: sub.icon, files: subs.map((f) => ({ f, label: f.path })), sub: true });
  for (const [k, v] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) tabs.push({ key: 'f:' + k, label: k, icon: 'folder', files: v });
  for (const f of roots) tabs.push({ key: 'r:' + f.id, label: f.path, icon: f.kind === 'file' ? 'file-code' : 'file', go: f.id });
  return tabs;
}

export interface FileTabsProps {
  files: FolderFile[];
  /** The open node (a file, or the folder itself for a lead tab that points at it). */
  cur: string | undefined;
  curHasDraft: boolean;
  canEdit: boolean;
  lead: { file?: string; tab?: { key: string; label: string; icon: string; go: string } };
  sub: { label: string; icon: string; rowLabel: string };
  back?: { label: string; go: string };
}

export function FileTabs({ files, cur, curHasDraft, canEdit, lead, sub, back }: FileTabsProps): ReactElement {
  const [sel, setSel] = useState<{ at: string | undefined; key: string } | null>(null);
  const tabs = folderTabs(files, lead, sub);
  const here = tabs.find((t) => t.go === cur || t.files?.some((x) => x.f.id === cur));
  const key = sel && sel.at === cur ? sel.key : (here?.key ?? tabs[0]?.key ?? '');
  const open = tabs.find((t) => t.key === key);
  const dirty = (f: FolderFile): boolean => f.kind !== 'skill' && canEdit && ((f.id === cur && curHasDraft) || (f.head_version ?? 0) > (f.published_version ?? 0));
  const dot = (id: string): ReactElement | null => {
    const f = files.find((x) => x.id === id);
    return f && dirty(f) ? <span className={'sfd' + (id === cur && curHasDraft ? ' dr' : '')} /> : null;
  };
  return (
    <>
      <div className="stabs" role="tablist">
        {back ? (
          <button className="sback" aria-label={'Back to ' + back.label} data-tip={'Back to ' + back.label} onClick={() => void goNode(back.go)}>
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
            {t.go ? dot(t.go) : null}
          </button>
        ))}
      </div>
      {open?.files ? (
        <div className="flist">
          {open.files.map(({ f, label }) => (
            <button key={f.id} className={'frow' + (f.id === cur ? ' on' : '') + (f.kind === 'skill' ? ' sub' : '')} onClick={() => void goNode(f.id)}>
              <Ic n={f.kind === 'skill' ? sub.icon : f.kind === 'file' ? 'file-code' : 'file'} s={15} />
              <span className="fn">{label}</span>
              <span className="fi">
                {f.kind === 'skill' ? sub.rowLabel : f.published_version ? 'v' + f.published_version : 'Not published'}
                {dot(f.id)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
