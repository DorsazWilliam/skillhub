import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { callCommand } from '@milkdown/kit/utils';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
} from '@milkdown/kit/preset/commonmark';
import { editorViewCtx } from '@milkdown/kit/core';
import { EditorView as CMView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { api, ApiError } from '../api/client';
import { qc, useGraph, useSkill, useChain, invalidate, type NodeT } from '../api/hooks';
import { Ic } from '../lib/icons';
import { buildFM, splitFM, fmError, areaKey, LINK_RULE, type AreaKey } from '../lib/util';
import { IB, Spinner } from '../ui/common';
import { Confirm, toast, errorToast } from '../ui/feedback';
import { LintItem } from '../ui/Menus';
import { Crumbs } from '../pages/Crumbs';
import { setUI } from '../state';
import { editorCtl, leaveEdit, openCommit, discardDraft } from '../actions';
import { setSave, useSave } from './status';
import { wikiRemark, wikiNode, wikiView, wikiInputRule, acPlugin, acBridge, imageView, insertWikiLink, setLinkStatus, setLinkIcons, type AcState, type WlStatus } from './extensions';

/**
 * The document editor (prototype editorHtml): frontmatter form for SKILL.md, Milkdown Crepe WYSIWYG with a raw
 * markdown toggle on CodeMirror 6, [[ autocomplete, live warnings from each autosave, autosave of the shared draft
 * every 2 s with etag conflict handling, paste/drop/button image upload through upload_asset.
 */

type Warning = { code: string; message: string; key: string; level: 'warn' | 'broken' };

const ALLOWED_IMG = /^image\/(png|jpeg|webp|gif)$/;

async function uploadImage(doc: string, file: File): Promise<{ src: string; alt: string } | null> {
  if (file.type === 'image/svg+xml') {
    toast('SVG is not allowed', { icon: 'alert', kind: 'bad' });
    return null;
  }
  if (!ALLOWED_IMG.test(file.type)) {
    toast('PNG, JPEG, WebP or GIF', { icon: 'alert', kind: 'bad' });
    return null;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('Max 5 MB', { icon: 'alert', kind: 'bad' });
    return null;
  }
  const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  try {
    const res = await api.upload_asset({ doc, file, alt });
    toast('Image added', { icon: 'image' });
    return { src: 'asset://' + res.id, alt };
  } catch (e) {
    errorToast(e);
    return null;
  }
}

function linkStatus(ws: Warning[]): Map<string, WlStatus> {
  const m = new Map<string, WlStatus>();
  for (const w of ws) {
    const [code, path] = [w.code, w.key.slice(w.key.indexOf('|') + 1)];
    if (code === 'link-direction') m.set(path, 'warn');
    else if (code === 'link-broken') m.set(path, 'broken');
    else if (code === 'link-locked') m.set(path, 'locked');
  }
  return m;
}

interface Target {
  path: string;
  area: AreaKey;
  icon: string;
}

/** Link targets the source may point at (prototype acTargets + linkAllowed). */
function useTargets(node: NodeT, skillId: string | null): Target[] {
  const g = useGraph();
  const sk = useSkill(skillId, null, !!skillId);
  return useMemo(() => {
    const src = areaKey(node.area);
    const out: Target[] = [];
    const self = node.canonical_path ?? '';
    for (const n of g.data?.nodes ?? []) {
      const c = n.canonical_path;
      if (!c || c === self) continue;
      const a = areaKey(n.area);
      const ok = src === 'rules' ? a === 'skills' || a === 'docs' : a === 'docs';
      if (!ok) continue;
      out.push({ path: c, area: a, icon: n.kind === 'skill' ? 'sparkles' : 'file' });
    }
    if (src === 'skills' && sk.data?.files && sk.data.canonical_path) {
      for (const f of sk.data.files) {
        if (f.path === 'SKILL.md') continue;
        const p = sk.data.canonical_path + '/' + f.path.replace(/\.md$/, '');
        if (p !== self) out.push({ path: p, area: 'skills', icon: f.kind === 'skill' ? 'sparkles' : f.kind === 'file' ? 'file-code' : 'file' });
      }
    }
    return out;
  }, [g.data, sk.data, node.area, node.canonical_path]);
}

function acScore(path: string, q: string): number {
  if (!q) return 1;
  const p = path.toLowerCase();
  const ql = q.toLowerCase();
  const k = p.indexOf(ql);
  if (k >= 0) return 100 - k * 0.5 + (p.endsWith(ql) ? 20 : 0);
  let j = 0;
  for (const ch of p) if (j < ql.length && ch === ql[j]) j++;
  return j === ql.length ? 10 : 0;
}

function Hlq({ s, q }: { s: string; q: string }): ReactElement {
  if (!q) return <>{s}</>;
  const lo = s.toLowerCase();
  const ql = q.toLowerCase();
  const k = lo.indexOf(ql);
  if (k >= 0)
    return (
      <>
        {s.slice(0, k)}
        <mark>{s.slice(k, k + q.length)}</mark>
        {s.slice(k + q.length)}
      </>
    );
  let j = 0;
  return (
    <>
      {[...s].map((ch, i) => {
        if (j < ql.length && ch.toLowerCase() === ql[j]) {
          j++;
          return <mark key={i}>{ch}</mark>;
        }
        return ch;
      })}
    </>
  );
}

export default function Editor({ node, mobile }: { node: NodeT; mobile: boolean }): ReactElement {
  const init = useQuery({
    queryKey: ['editorInit', node.id],
    gcTime: 0,
    staleTime: 0,
    queryFn: async () => {
      const d = await api.get_draft({ doc: node.id });
      if (d.draft) return { content: d.draft.content, etag: d.draft.etag as string | null, draft: true };
      const head = d.head_version;
      const content = head ? (await api.get_version({ doc: node.id, version: head })).content : '';
      return { content, etag: null as string | null, draft: false };
    },
  });
  if (!init.data) return <Spinner />;
  return <EditorInner key={node.id} node={node} mobile={mobile} initial={init.data} />;
}

function EditorInner({ node, mobile, initial }: { node: NodeT; mobile: boolean; initial: { content: string; etag: string | null; draft: boolean } }): ReactElement {
  const isCode = !!node.format && node.format !== 'markdown';
  const isSkillMd = node.name === 'SKILL.md';
  const area = areaKey(node.area);
  const parsed = useMemo(() => {
    if (isCode) return { name: '', desc: '', rest: '', prefix: '', body: initial.content };
    const { fm, body, rest } = splitFM(initial.content);
    if (isSkillMd) return { name: fm?.['name'] ?? '', desc: fm?.['description'] ?? '', rest, prefix: '', body };
    // Other documents keep any frontmatter untouched and out of the visual editor.
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(initial.content);
    return { name: '', desc: '', rest: '', prefix: m ? m[0] : '', body: m ? initial.content.slice(m[0].length) : initial.content };
  }, [initial.content, isCode, isSkillMd]);

  const [name, setName] = useState(parsed.name);
  const [desc, setDesc] = useState(parsed.desc);
  const [raw, setRaw] = useState(isCode);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [hasDraft, setHasDraft] = useState(initial.draft || !!node.has_draft);
  const [ac, setAc] = useState<AcState & { i: number; raw: boolean }>({ open: false, q: '', from: 0, to: 0, rect: null, i: 0, raw: false });
  const save = useSave();

  const host = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const crepe = useRef<CrepeBuilder | null>(null);
  const cm = useRef<CMView | null>(null);
  const body = useRef(parsed.body);
  const meta = useRef({ name: parsed.name, desc: parsed.desc });
  const etag = useRef<string | null>(initial.etag);
  const lastSaved = useRef(initial.content);
  const changed = useRef(false);
  const timer = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const acRef = useRef(ac);
  acRef.current = ac;

  const chain = useChain(node.id);
  const skillId = [...(chain.data ?? [])].reverse().find((n) => n.kind === 'folder' && !n.is_area && !!n.is_skill)?.id ?? null;
  const targets = useTargets(node, skillId);
  useEffect(() => setLinkIcons(new Map(targets.map((t) => [t.path, t.icon]))), [targets]);

  const readBody = useCallback((): string => {
    if (cm.current) return cm.current.state.doc.toString();
    if (crepe.current) {
      try {
        return crepe.current.getMarkdown();
      } catch {
        return body.current;
      }
    }
    return body.current;
  }, []);

  const compose = useCallback((): string => {
    const b = body.current;
    if (isCode) return b;
    if (isSkillMd) return buildFM(meta.current.name, meta.current.desc, parsed.rest) + b;
    return parsed.prefix + b;
  }, [isCode, isSkillMd, parsed.rest, parsed.prefix]);

  const applyWarnings = useCallback(
    (ws: Warning[]) => {
      setWarnings(ws);
      setLinkStatus(linkStatus(ws), LINK_RULE[area]);
    },
    [area],
  );

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    if (saving.current) await saving.current;
    if (changed.current) body.current = readBody();
    const content = compose();
    if (!changed.current || content === lastSaved.current) {
      setSave('saved');
      return;
    }
    setSave('saving');
    const run = (async () => {
      try {
        const res = await api.update_draft({ doc: node.id, content, etag: etag.current });
        etag.current = res.etag;
        lastSaved.current = content;
        applyWarnings(res.warnings);
        if (!hasDraft) {
          setHasDraft(true);
          invalidate('children', 'node');
        }
        qc.setQueryData(['node', node.id], (n: NodeT | undefined) => (n ? { ...n, has_draft: true } : n));
        setSave('saved');
      } catch (e) {
        setSave('pending');
        if (e instanceof ApiError && e.code === 'conflict') {
          const d = e.details ?? {};
          const theirs = typeof d['content'] === 'string' ? d['content'] : null;
          const theirTag = typeof d['etag'] === 'string' ? d['etag'] : null;
          editorCtl.resolve = (choice) => {
            setUI({ modal: null });
            editorCtl.resolve = null;
            etag.current = theirTag;
            if (choice === 'mine') {
              lastSaved.current = theirs ?? '';
              void flush();
            } else {
              lastSaved.current = theirs ?? '';
              changed.current = false;
              const t = splitFM(theirs ?? '');
              if (isSkillMd) {
                meta.current = { name: t.fm?.['name'] ?? '', desc: t.fm?.['description'] ?? '' };
                setName(meta.current.name);
                setDesc(meta.current.desc);
                body.current = t.body;
              } else body.current = isCode ? (theirs ?? '') : (theirs ?? '').slice(parsed.prefix.length);
              remount.current++;
              setRemount(remount.current);
              setSave('saved');
            }
          };
          setUI({ modal: { type: 'conflict', id: node.id, theirs, by: typeof d['updated_by'] === 'string' ? d['updated_by'] : null } });
        } else errorToast(e);
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
  }, [applyWarnings, compose, hasDraft, isCode, isSkillMd, node.id, parsed.prefix, readBody]);

  const remount = useRef(0);
  const [remountKey, setRemount] = useState(0);

  const scheduleSave = useCallback(() => {
    changed.current = true;
    setSave('pending');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 2000);
  }, [flush]);

  // Controller for navigation (flush before leaving) and initial warnings.
  useEffect(() => {
    editorCtl.flush = flush;
    setSave('saved');
    return () => {
      if (editorCtl.flush === flush) editorCtl.flush = null;
    };
  }, [flush]);

  useEffect(() => {
    void api
      .get_warnings({ node: node.id, version: 'latest' })
      .then((w) => applyWarnings(w.warnings))
      .catch(() => undefined);
    const before = (): void => {
      if (changed.current) void flush();
    };
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('beforeunload', before);
      clearTimeout(timer.current);
      setLinkStatus(new Map(), '');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Autocomplete plumbing shared by both editors.
  const visibleTargets = useMemo(() => {
    if (!ac.open) return [];
    return targets
      .map((t) => ({ ...t, sc: acScore(t.path, ac.q) }))
      .filter((t) => t.sc > 0)
      .sort((a, b) => b.sc - a.sc || a.path.localeCompare(b.path))
      .slice(0, 8);
  }, [ac.open, ac.q, targets]);
  const targetsRef = useRef(visibleTargets);
  targetsRef.current = visibleTargets;

  const pick = useCallback(
    (i: number) => {
      const t = targetsRef.current[i];
      const a = acRef.current;
      if (!t) return;
      setAc((s) => ({ ...s, open: false }));
      if (a.raw && cm.current) {
        cm.current.dispatch({ changes: { from: a.from, to: a.to, insert: '[[' + t.path + ']]' }, selection: { anchor: a.from + t.path.length + 4 } });
        cm.current.focus();
      } else if (acBridge.view) insertWikiLink(acBridge.view, a.from, a.to, t.path);
      scheduleSave();
    },
    [scheduleSave],
  );

  const onKey = useCallback(
    (key: string): boolean => {
      const a = acRef.current;
      if (!a.open) return false;
      const n = targetsRef.current.length;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        setAc((s) => ({ ...s, i: Math.max(0, Math.min(n - 1, s.i + (key === 'ArrowDown' ? 1 : -1))) }));
        return true;
      }
      if ((key === 'Enter' || key === 'Tab') && n) {
        pick(a.i);
        return true;
      }
      if (key === 'Escape') {
        setAc((s) => ({ ...s, open: false }));
        return true;
      }
      return false;
    },
    [pick],
  );

  useEffect(() => {
    acBridge.onChange = (s) => setAc((p) => (s.open ? { ...s, i: p.open && p.q === s.q ? p.i : 0, raw: false } : p.raw ? p : { ...p, open: false }));
    acBridge.onKey = onKey;
    return () => {
      acBridge.onChange = () => undefined;
      acBridge.onKey = () => false;
    };
  }, [onKey]);

  // Milkdown (visual) editor.
  useEffect(() => {
    if (raw || isCode || !host.current) return;
    const root = host.current;
    const b = new CrepeBuilder({ root, defaultValue: body.current });
    b.addFeature(placeholder, { text: 'Start writing', mode: 'doc' });
    b.editor
      .config((ctx) => {
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader: async (files, schema) => {
            const out = [];
            for (let i = 0; i < files.length; i++) {
              const f = files.item(i);
              if (!f) continue;
              const r = await uploadImage(node.id, f);
              const img = r ? schema.nodes['image']?.createAndFill({ src: r.src, alt: r.alt }) : null;
              if (img) out.push(img);
            }
            if (out.length) scheduleSave();
            return out;
          },
        }));
      })
      .use(wikiRemark)
      .use(wikiNode)
      .use(wikiView)
      .use(wikiInputRule)
      .use(acPlugin)
      .use(imageView);
    b.on((l) =>
      l.markdownUpdated((_ctx, md, prev) => {
        if (md !== prev) {
          body.current = md;
          scheduleSave();
        }
      }),
    );
    let live = true;
    void b.create().then(() => {
      if (!live) return;
      crepe.current = b;
      if (!mobile) b.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    });
    return () => {
      live = false;
      if (crepe.current === b) {
        if (changed.current) body.current = b.getMarkdown();
        crepe.current = null;
      }
      void b.destroy();
      root.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, isCode, node.id, remountKey]);

  // CodeMirror (raw markdown and text files).
  useEffect(() => {
    if (!raw || !host.current) return;
    const root = host.current;
    const acCheck = (v: CMView): void => {
      const sel = v.state.selection.main;
      if (!sel.empty || isCode) return setAc((s) => (s.raw && s.open ? { ...s, open: false } : s));
      const line = v.state.doc.lineAt(sel.head);
      const before = line.text.slice(Math.max(0, sel.head - line.from - 64), sel.head - line.from);
      const m = /\[\[([^[\]|\n]{0,60})$/.exec(before);
      if (!m) return setAc((s) => (s.raw && s.open ? { ...s, open: false } : s));
      const c = v.coordsAtPos(sel.head);
      setAc((s) => ({ open: true, q: m[1] ?? '', from: sel.head - m[0].length, to: sel.head, rect: c ? { left: c.left, top: c.top, bottom: c.bottom } : null, i: s.open && s.q === (m[1] ?? '') ? s.i : 0, raw: true }));
    };
    const insertFiles = (files: FileList | null | undefined, v: CMView): boolean => {
      const f = files?.[0];
      if (!f || isCode) return false;
      void uploadImage(node.id, f).then((r) => {
        if (!r) return;
        const pos = v.state.selection.main.head;
        const md = `\n![${r.alt}](${r.src})\n`;
        v.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length } });
      });
      return true;
    };
    const view = new CMView({
      parent: root,
      state: EditorState.create({
        doc: body.current,
        extensions: [
          history(),
          Prec.highest(
            keymap.of(
              ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map((key) => ({
                key,
                run: () => acRef.current.open && acRef.current.raw && onKey(key),
              })),
            ),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...(isCode ? [] : [markdown()]),
          CMView.lineWrapping,
          cmPlaceholder(isCode ? '' : 'Start writing'),
          CMView.contentAttributes.of({ 'aria-label': isCode ? 'Code' : 'Markdown', spellcheck: 'false' }),
          CMView.updateListener.of((u) => {
            if (u.docChanged) {
              body.current = u.state.doc.toString();
              scheduleSave();
            }
            if (u.docChanged || u.selectionSet) acCheck(u.view);
          }),
          CMView.domEventHandlers({
            paste: (e, v) => insertFiles(e.clipboardData?.files, v) && (e.preventDefault(), true),
            drop: (e, v) => insertFiles(e.dataTransfer?.files, v) && (e.preventDefault(), true),
          }),
        ],
      }),
    });
    cm.current = view;
    if (!mobile) view.focus();
    return () => {
      body.current = view.state.doc.toString();
      cm.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, node.id, remountKey]);

  const cmd = (c: string): void => {
    const e = crepe.current?.editor;
    if (!e) return;
    const map: Record<string, () => void> = {
      h2: () => e.action(callCommand(wrapInHeadingCommand.key, 2)),
      bold: () => e.action(callCommand(toggleStrongCommand.key)),
      italic: () => e.action(callCommand(toggleEmphasisCommand.key)),
      ul: () => e.action(callCommand(wrapInBulletListCommand.key)),
      ol: () => e.action(callCommand(wrapInOrderedListCommand.key)),
      quote: () => e.action(callCommand(wrapInBlockquoteCommand.key)),
      code: () => e.action(callCommand(createCodeBlockCommand.key)),
    };
    map[c]?.();
    e.action((ctx) => ctx.get(editorViewCtx).focus());
  };

  const insertLinkStart = (): void => {
    if (cm.current) {
      const pos = cm.current.state.selection.main.head;
      cm.current.dispatch({ changes: { from: pos, insert: '[[' }, selection: { anchor: pos + 2 } });
      cm.current.focus();
    } else if (acBridge.view) {
      const v = acBridge.view;
      v.focus();
      v.dispatch(v.state.tr.insertText('[['));
    }
  };

  const onFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    const r = await uploadImage(node.id, f);
    if (!r) return;
    if (cm.current) {
      const pos = cm.current.state.selection.main.head;
      const md = `\n![${r.alt}](${r.src})\n`;
      cm.current.dispatch({ changes: { from: pos, insert: md } });
    } else if (acBridge.view) {
      const v = acBridge.view;
      const img = v.state.schema.nodes['image']?.createAndFill({ src: r.src, alt: r.alt });
      if (img) v.dispatch(v.state.tr.replaceSelectionWith(img));
    }
    scheduleSave();
  };

  const toggleRaw = (): void => {
    if (crepe.current) body.current = crepe.current.getMarkdown();
    else if (cm.current) body.current = cm.current.state.doc.toString();
    setAc((s) => ({ ...s, open: false }));
    setRaw((r) => !r);
  };

  const err = isSkillMd ? fmError(name, desc, true) : '';
  const canDiscard = hasDraft;
  const shownWarnings = isCode ? [] : warnings;

  return (
    <div className="page">
      <div className="dh">
        <Crumbs id={node.id} />
        <div className="acts">
          <span className={'save' + (save === 'saved' ? ' ok' : '')} id="save-ic" data-tip={save === 'saved' ? 'Saved to draft' : 'Saving'} aria-label={save === 'saved' ? 'Saved to draft' : 'Saving'}>
            <Ic n={save === 'saving' ? 'loader' : save === 'pending' ? 'cloud' : 'cloud-check'} s={16} c={save === 'saving' ? 'spin' : ''} />
          </span>
          {canDiscard ? (
            <Confirm className="ib" label="Discard draft" tip="Discard draft" onConfirm={() => void discardDraft(node.id)}>
              <Ic n="trash" s={17} />
            </Confirm>
          ) : null}
          <button className="btn primary" data-tip="Commit|Ctrl S" onClick={() => void openCommit(node.id)}>
            <Ic n="commit" s={15} />
            <span>Commit</span>
          </button>
          <IB icon="x" tip="Close|Esc" onClick={() => void leaveEdit()} />
        </div>
      </div>
      {isSkillMd ? (
        <div className="fm-card">
          <div className="fm-row" data-tip="Skill name">
            <Ic n="sparkles" s={16} />
            <input
              id="ed-name"
              className="fm-name"
              value={name}
              placeholder="skill-name"
              spellCheck={false}
              autoComplete="off"
              aria-label="Skill name"
              onChange={(e) => {
                const v = e.target.value.trim();
                setName(v);
                meta.current = { ...meta.current, name: v };
                scheduleSave();
              }}
            />
          </div>
          <textarea
            id="ed-desc"
            className="fm-desc"
            rows={1}
            value={desc}
            placeholder="When should an agent use this?"
            aria-label="Description"
            onChange={(e) => {
              setDesc(e.target.value);
              meta.current = { ...meta.current, desc: e.target.value };
              scheduleSave();
            }}
          />
          <div className="fm-err" id="ed-err">
            {err}
          </div>
        </div>
      ) : null}
      {isCode ? (
        <div className="code-h solo">
          <Ic n="file-code" s={14} />
          <span>{node.name}</span>
        </div>
      ) : (
        <div className="fmt" role="toolbar" aria-label="Formatting">
          {raw
            ? null
            : (
                [
                  ['h2', 'heading', 'Heading'],
                  ['bold', 'bold', 'Bold|Ctrl B'],
                  ['italic', 'italic', 'Italic|Ctrl I'],
                  ['ul', 'list', 'List'],
                  ['ol', 'list-ol', 'Numbered list'],
                  ['quote', 'quote', 'Quote'],
                  ['code', 'code-block', 'Code block'],
                ] as const
              ).map(([c, i, t]) => <IB key={c} className="ib sm" icon={i} s={16} tip={t} onClick={() => cmd(c)} data-cmd={c} />)}
          {raw ? null : <span className="sep" />}
          <IB className="ib sm" icon="image" s={16} tip="Image" onClick={() => fileIn.current?.click()} />
          <IB className="ib sm" icon="link" s={16} tip="Link|[[" onClick={insertLinkStart} />
          <div className="grow" />
          <IB className={'ib sm' + (raw ? ' on' : '')} icon="code" s={16} tip={raw ? 'Visual' : 'Markdown'} onClick={toggleRaw} />
        </div>
      )}
      <input
        type="file"
        ref={fileIn}
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void onFile(f);
        }}
      />
      <div id="ed-links">
        {shownWarnings.length ? (
          <div className="lnotes">
            {shownWarnings.map((w) => (
              <span key={w.key} onClickCapture={() => setTimeout(() => setWarnings((ws) => ws.filter((x) => x.key !== w.key)), 0)}>
                <LintItem node={node.id} x={w} chip />
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {raw ? (
        <div key={'raw' + remountKey} id="ed-raw" className={'raw' + (isCode ? ' codeed' : '')} ref={host} />
      ) : (
        <div key={'vis' + remountKey} id="ed-body" className="md editable" ref={host} data-ph="Start writing" />
      )}
      {ac.open && ac.rect ? (
        <div
          className="ac on"
          role="listbox"
          style={{ left: Math.max(8, Math.min(ac.rect.left - 8, window.innerWidth - 428)), top: ac.rect.bottom + 6 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {visibleTargets.length ? (
            visibleTargets.map((t, i) => (
              <div key={t.path} className={'aci' + (i === ac.i ? ' on' : '')} role="option" aria-selected={i === ac.i} onClick={() => pick(i)}>
                <span className={'ac-' + t.area}>
                  <Ic n={t.icon} s={14} />
                </span>
                <span className="ell">
                  <Hlq s={t.path} q={ac.q} />
                </span>
              </div>
            ))
          ) : (
            <div className="aci faint">
              <Ic n="ban" s={14} />
              <span className="ell">{LINK_RULE[area]}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
