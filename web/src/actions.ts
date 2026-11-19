import { api, uiOnly, ApiError } from './api/client';
import { fetchChildren, fetchNode, invalidate, invalidateContent, qc } from './api/hooks';
import { getUI, setUI, openMany, pushRecent, isWide } from './state';
import { navigate, currentRoute } from './router';
import { toast, errorToast } from './ui/feedback';
import { splitFM, fmError } from './lib/util';

/** Every user action that changes data. Each goes through the generated client (the registry's REST surface). */

export const mobileMQ = window.matchMedia('(max-width:767px)');
export const narrowMQ = window.matchMedia('(max-width:860px)');
export const isMobile = (): boolean => mobileMQ.matches;

/** Registered by the open editor so navigation can flush the pending autosave first. */
export const editorCtl: { flush: (() => Promise<void>) | null; resolve: ((choice: 'mine' | 'theirs') => void) | null } = { flush: null, resolve: null };

export async function leaveEdit(): Promise<void> {
  if (!getUI().editing) return;
  try {
    await editorCtl.flush?.();
  } catch {
    /* the editor already reported it */
  }
  setUI({ editing: null, viewing: null });
  invalidateContent();
}

export function startEdit(id: string): void {
  setUI({ editing: id, viewing: 'draft', menu: null, modal: null, drawer: isMobile() ? null : getUI().drawer });
}

export async function goNode(id: string): Promise<void> {
  if (getUI().editing) await leaveEdit();
  setUI({ viewing: null, menu: null, modal: null, searchOpen: false, mTree: false, drawer: isMobile() ? null : getUI().drawer ?? (isWide() ? 'links' : null) });
  navigate('/n/' + id);
}

export async function go(path: string): Promise<void> {
  if (getUI().editing) await leaveEdit();
  setUI({ menu: null, modal: null, mTree: false, searchOpen: false });
  navigate(path);
}

export function noteVisit(id: string, chainIds: string[]): void {
  if (id) pushRecent(id);
  openMany(chainIds);
}

async function uniqueName(parent: string, base: string): Promise<string> {
  const kids = await fetchChildren(parent).catch(() => []);
  const taken = new Set(kids.map((k) => k.name.toLowerCase()));
  let n = base;
  let i = 2;
  while (taken.has(n.toLowerCase())) n = `${base}-${i++}`;
  return n;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function newDoc(parent: string): Promise<void> {
  try {
    const name = await uniqueName(parent, 'untitled');
    const res = await api.create_doc({ parent, name });
    invalidateContent();
    openMany([parent]);
    await goNode(res.node.id);
    startEdit(res.node.id);
    if (isMobile()) setUI({ modal: { type: 'rename', id: res.node.id } });
    else setUI({ renaming: res.node.id, mTree: narrowMQ.matches });
  } catch (e) {
    errorToast(e);
  }
}

export async function newFolder(parent: string): Promise<void> {
  try {
    const name = await uniqueName(parent, 'New folder');
    const f = await api.create_folder({ parent, name });
    invalidateContent();
    openMany([parent]);
    if (isMobile()) setUI({ modal: { type: 'rename', id: f.id }, menu: null });
    else setUI({ renaming: f.id, menu: null, mTree: narrowMQ.matches });
  } catch (e) {
    errorToast(e);
  }
}

export async function newSkill(parent: string): Promise<void> {
  try {
    const name = await uniqueName(parent, 'new-skill');
    const res = await api.create_skill({ parent, name });
    invalidateContent();
    openMany([parent, res.folder.id]);
    await goNode(res.skill_md.id);
    startEdit(res.skill_md.id);
  } catch (e) {
    errorToast(e);
  }
}

export async function renameNode(id: string, name: string): Promise<void> {
  const v = name.trim();
  const n = await fetchNode(id).catch(() => null);
  if (!n || !v || v === n.name) return;
  if (v.includes('/') || v.length > 120) {
    toast('No slashes, max 120 characters', { icon: 'alert', kind: 'bad' });
    return;
  }
  try {
    await api.rename_node({ node: id, name: v });
    invalidateContent();
  } catch (e) {
    toast(e instanceof ApiError && e.code === 'conflict' ? 'Name already used here' : msg(e), { icon: 'alert', kind: 'bad' });
  }
}

export async function moveNode(id: string, dest: string): Promise<void> {
  const n = await fetchNode(id).catch(() => null);
  const prev = n?.parent_id ?? null;
  try {
    const res = await api.move_node({ node: id, to: dest });
    invalidateContent();
    openMany([dest]);
    const d = await fetchNode(dest).catch(() => null);
    toast('Moved to ' + (d?.name ?? 'folder'), {
      icon: res.access_changed ? 'alert' : 'move',
      warn: res.access_changed,
      sub: res.access_changed ? 'access changed' : '',
      undo: prev
        ? async () => {
            await api.move_node({ node: id, to: prev }).catch(errorToast);
            invalidateContent();
          }
        : undefined,
    });
  } catch (e) {
    toast(e instanceof ApiError && e.code === 'conflict' ? 'Name already used there' : msg(e), { icon: 'alert', kind: 'bad' });
  }
}

export async function deleteNode(id: string): Promise<void> {
  const n = await fetchNode(id).catch(() => null);
  try {
    await api.delete_node({ node: id });
    invalidateContent();
    const r = currentRoute();
    if (r.name === 'node' && n && (r.id === id || (await isInside(r.id, id)))) {
      if (n.parent_id) navigate('/n/' + n.parent_id, { replace: true });
      else navigate('/', { replace: true });
    }
    toast('Deleted ' + (n?.name ?? ''), {
      icon: 'trash',
      undo: async () => {
        await api.restore_node({ node: id }).catch(errorToast);
        invalidateContent();
      },
    });
  } catch (e) {
    errorToast(e);
  }
}

async function isInside(id: string, anc: string): Promise<boolean> {
  let cur: string | null = id;
  for (let i = 0; cur && i < 40; i++) {
    if (cur === anc) return true;
    const n: { parent_id: string | null } | undefined = qc.getQueryData(['node', cur]);
    cur = n?.parent_id ?? null;
  }
  return false;
}

export async function restoreNode(id: string, name: string): Promise<void> {
  try {
    await api.restore_node({ node: id });
    invalidateContent();
    toast('Restored ' + name, { icon: 'undo' });
  } catch (e) {
    errorToast(e);
  }
}

/** Opens the commit sheet after flushing the editor (prototype openCommit). */
export async function openCommit(id: string): Promise<void> {
  if (getUI().editing === id) await editorCtl.flush?.();
  try {
    const d = await api.get_draft({ doc: id });
    if (!d.draft) {
      toast('No changes to commit', { icon: 'check' });
      return;
    }
    const n = await fetchNode(id);
    if (n.name === 'SKILL.md') {
      const { fm } = splitFM(d.draft.content);
      const err = fmError(fm?.['name'] ?? '', fm?.['description'] ?? '', true);
      if (err) {
        toast(err, { icon: 'alert', kind: 'bad' });
        return;
      }
    }
    qc.setQueryData(['draft', id], d);
    setUI({ modal: { type: 'commit', id, msg: '', pub: false }, menu: null });
  } catch (e) {
    errorToast(e);
  }
}

export async function doCommit(id: string, message: string, pub: boolean, skillId: string | null): Promise<void> {
  try {
    const res = await api.commit_version({ doc: id, message: message.trim() || 'Update' });
    setUI({ modal: null, editing: null, viewing: null });
    // A skill created as new-skill takes the name from its frontmatter on the first commit (prototype doCommit).
    const n = await fetchNode(id).catch(() => null);
    if (n?.name === 'SKILL.md' && n.parent_id) {
      const folder = await api.get_node({ node: n.parent_id }).catch(() => null);
      const v = await api.get_version({ doc: id, version: res.version }).catch(() => null);
      const fmName = v ? splitFM(v.content).fm?.['name'] : undefined;
      if (folder && fmName && /^new-skill(-\d+)?$/.test(folder.name) && fmName !== folder.name) await api.rename_node({ node: folder.id, name: fmName }).catch(() => null);
    }
    if (pub && skillId) {
      await publishSkill(skillId);
    } else if (pub) {
      const p = await api.publish_version({ doc: id, version: res.version });
      toast('Published v' + res.version, { icon: 'rocket', undo: () => undoPublish(id, p.previous_version) });
    } else toast('Committed v' + res.version, { icon: 'commit' });
    invalidateContent();
  } catch (e) {
    errorToast(e);
  }
}

async function undoPublish(id: string, prev: number | null): Promise<void> {
  try {
    if (prev) await api.publish_version({ doc: id, version: prev });
    else await api.unpublish({ doc: id });
  } catch (e) {
    errorToast(e);
  }
  invalidateContent();
}

export async function publishVersion(id: string, v: number): Promise<void> {
  try {
    const p = await api.publish_version({ doc: id, version: v });
    setUI({ modal: null, viewing: null });
    invalidateContent();
    toast((v < (p.previous_version ?? 0) ? 'Rolled back to v' : 'Published v') + v, { icon: 'rocket', undo: () => undoPublish(id, p.previous_version) });
  } catch (e) {
    errorToast(e);
  }
}

export async function unpublish(id: string): Promise<void> {
  try {
    const r = await api.unpublish({ doc: id });
    setUI({ modal: null, menu: null });
    invalidateContent();
    toast('Unpublished', {
      icon: 'eye-off',
      undo: r.previous_version ? () => undoPublish(id, r.previous_version) : undefined,
    });
  } catch (e) {
    errorToast(e);
  }
}

export async function publishSkill(skillId: string): Promise<void> {
  try {
    const res = await api.publish_skill({ skill: skillId });
    setUI({ modal: null });
    invalidateContent();
    const done = res.files.filter((f) => f.status === 'published');
    if (!done.length) {
      toast('Up to date', { icon: 'check' });
      return;
    }
    const sk = await fetchNode(skillId).catch(() => null);
    toast('Published ' + (sk?.name ?? 'skill'), {
      icon: 'rocket',
      sub: done.length + (done.length === 1 ? ' file' : ' files'),
      undo: async () => {
        for (const f of done) await undoPublish(f.id, f.from);
      },
    });
  } catch (e) {
    errorToast(e);
  }
}

export async function discardDraft(id: string): Promise<void> {
  try {
    if (getUI().editing === id) editorCtl.flush = null;
    const d = await api.get_draft({ doc: id }).catch(() => null);
    await api.discard_draft({ doc: id });
    setUI({ editing: null, viewing: null });
    invalidateContent();
    const content = d?.draft?.content;
    toast('Draft discarded', {
      icon: 'trash',
      undo: content
        ? async () => {
            await api.update_draft({ doc: id, content, etag: null }).catch(errorToast);
            invalidateContent();
          }
        : undefined,
    });
  } catch (e) {
    errorToast(e);
  }
}

export async function dismissWarning(id: string, key: string, quiet = false): Promise<void> {
  try {
    await api.dismiss_warning({ node: id, key });
    invalidate('warnings');
    if (!quiet)
      toast('Dismissed', {
        icon: 'check',
        undo: async () => {
          // The API restores all dismissals of a node at once; re-dismiss the others.
          const w = await api.get_warnings({ node: id });
          await api.restore_warnings({ node: id });
          for (const x of w.dismissed) if (x.key !== key) await api.dismiss_warning({ node: id, key: x.key });
          invalidate('warnings');
        },
      });
  } catch (e) {
    errorToast(e);
  }
}

export async function restoreWarnings(id: string): Promise<void> {
  try {
    await api.restore_warnings({ node: id });
    invalidate('warnings');
    setUI({ menu: null });
  } catch (e) {
    errorToast(e);
  }
}

export async function exportTree(): Promise<void> {
  try {
    const res = await api.export_tree({});
    const bin = atob(res.zip_base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = res.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setUI({ modal: null });
    toast('Export ready', { icon: 'download', sub: res.documents + ' documents' });
  } catch (e) {
    errorToast(e);
  }
}

export async function logout(): Promise<void> {
  try {
    await uiOnly.logout();
  } catch {
    /* already signed out */
  }
  qc.clear();
  window.location.href = '/login';
}
