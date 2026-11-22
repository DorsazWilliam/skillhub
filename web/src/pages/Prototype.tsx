import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Ic } from '../lib/icons';
import { IB, Empty, Spinner } from '../ui/common';
import { FileTabs } from '../ui/FileTabs';
import { setUI, openMenu } from '../state';
import { useChain, useNode, usePrototype, role, type NodeT } from '../api/hooks';
import { pendingFiles } from './docModel';
import { copyLink } from './Doc';
import { Crumbs } from './Crumbs';

type Viewport = 'desktop' | 'tablet' | 'phone';
const VIEWPORTS: [Viewport, string, string][] = [
  ['desktop', 'monitor', 'Desktop'],
  ['tablet', 'tablet', 'Tablet'],
  ['phone', 'smartphone', 'Phone'],
];
/** CSS width each viewport renders at; the frame is scaled down to fit the stage, so layouts match the real device. */
const VW: Record<Viewport, number> = { desktop: 1280, tablet: 820, phone: 390 };
const VH: Record<Viewport, number | null> = { desktop: null, tablet: 1100, phone: 844 };
const PAD: Record<Viewport, number> = { desktop: 0, tablet: 20, phone: 20 };

/** Scale and size for a frame of `vp` inside a stage of the given size. */
function fitFrame(vp: Viewport, stage: { w: number; h: number }): { scale: number; w: number; h: number } {
  const pad = PAD[vp] * 2;
  const w = VW[vp];
  const scale = Math.min(1, (stage.w - pad) / w);
  const h = VH[vp] ?? (stage.h - pad) / scale;
  const fitH = Math.min(h, (stage.h - pad) / scale);
  return { scale, w, h: vp === 'desktop' ? h : fitH };
}

/** The prototype folder that contains (or is) this node, from its chain. */
export function useProtoOf(id: string | null): NodeT | null {
  const chain = useChain(id).data ?? [];
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i]!.kind === 'folder' && chain[i]!.is_prototype) return chain[i]!;
  return null;
}

/** Prototype header: name, file count, and its top level as tabs, with Preview first. Used on the prototype and its files. */
export function ProtoHead({ protoId, cur, curHasDraft }: { protoId: string; cur: string; curHasDraft: boolean }): ReactElement | null {
  const folder = useNode(protoId).data;
  const p = usePrototype(protoId);
  if (!folder || !p.data) return null;
  const r = role(folder);
  const pend = r >= 3 ? pendingFiles({ files: p.data.files }).length : 0;
  return (
    <div className="skhead protohead">
      <div className="skt">
        <span className="skic">
          <Ic n="app-window" s={17} />
        </span>
        <div className="grow">
          <code>{folder.name}</code>
          <p>
            {p.data.files.filter((f) => f.kind !== 'skill').length} files · {p.data.published ? 'published' : 'not published yet'}
          </p>
        </div>
        {pend ? (
          <button className="btn sm primary" data-tip="Publish the prototype" onClick={() => setUI({ modal: { type: 'skill-publish', id: protoId, open: null, proto: true }, menu: null })}>
            <Ic n="rocket" s={13} />
            <span>{pend}</span>
          </button>
        ) : null}
      </div>
      <FileTabs
        files={p.data.files}
        cur={cur}
        curHasDraft={curHasDraft}
        canEdit={r >= 2}
        lead={{ tab: { key: 'preview', label: 'Preview', icon: 'eye', go: protoId } }}
        sub={{ label: 'Prototypes', icon: 'app-window', rowLabel: 'Prototype' }}
      />
    </div>
  );
}

/** A prototype: its files as tabs and a live preview in a sandboxed frame, at desktop, tablet or phone width. */
export function PrototypePage({ id }: { id: string }): ReactElement {
  const folder = useNode(id).data;
  const r = folder ? role(folder) : 0;
  const [mode, setMode] = useState<'published' | 'working' | null>(null);
  const [vp, setVp] = useState<Viewport>('desktop');
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1000, h: 640 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!folder]);
  const fit = fitFrame(vp, box);
  const eff = mode ?? (r >= 2 ? 'working' : 'published');
  const p = usePrototype(id, eff);
  if (!folder)
    return (
      <div className="page">
        <Spinner />
      </div>
    );
  const url = p.data?.preview_url;
  const empty = p.data && eff === 'published' && !p.data.published;
  return (
    <div className="page wide proto-page">
      <div className="dh">
        <Crumbs id={id} />
        <div className="acts">
          {r >= 3 ? <IB icon="rocket" tip="Publish prototype" onClick={() => setUI({ modal: { type: 'skill-publish', id, open: null, proto: true } })} /> : null}
          {r >= 4 ? <IB icon="user-plus" tip="Share" onClick={() => setUI({ modal: { type: 'share', id } })} /> : null}
          <IB className="ib hide-m" icon="link" tip="Copy [[link]]" onClick={() => copyLink(folder.canonical_path)} />
          {r >= 2 ? <IB icon="more" tip="More" onClick={(e) => openMenu('more', e.currentTarget, id)} /> : null}
        </div>
      </div>
      <ProtoHead protoId={id} cur={id} curHasDraft={false} />
      <div className="pv-bar">
        <div className="seg" role="group" aria-label="Viewport">
          {VIEWPORTS.map(([k, icon, label]) => (
            <button key={k} className={vp === k ? 'on' : ''} aria-pressed={vp === k} aria-label={label} data-tip={label} onClick={() => setVp(k)}>
              <Ic n={icon} s={14} />
            </button>
          ))}
        </div>
        {r >= 2 ? (
          <div className="seg" role="group" aria-label="Version">
            <button className={eff === 'working' ? 'on' : ''} aria-pressed={eff === 'working'} data-tip="Drafts and unpublished versions" onClick={() => setMode('working')}>
              Working
            </button>
            <button className={eff === 'published' ? 'on' : ''} aria-pressed={eff === 'published'} data-tip="What viewers see" onClick={() => setMode('published')}>
              Published
            </button>
          </div>
        ) : null}
        <div className="grow" />
        <IB icon="refresh" s={16} tip="Reload" onClick={() => setNonce((n) => n + 1)} />
        <IB icon="external" s={16} tip="Open in a new tab (link valid one hour)" disabled={!url} onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')} />
      </div>
      <div className={'pv-stage ' + vp} ref={stage}>
        {p.isLoading ? (
          <Spinner />
        ) : empty ? (
          <Empty icon="eye-off">
            <span className="muted">Not published yet</span>
          </Empty>
        ) : url ? (
          <iframe
            key={url + ':' + nonce}
            ref={frame}
            className="pv-frame"
            style={{ width: fit.w, height: fit.h, transform: `scale(${fit.scale})`, marginBottom: fit.h * (fit.scale - 1), marginRight: fit.w * (fit.scale - 1) }}
            title={'Preview of ' + folder.name}
            src={url}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        ) : null}
      </div>
    </div>
  );
}
