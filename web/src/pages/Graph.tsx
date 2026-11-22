import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useGraph, useMe } from '../api/hooks';
import { Ic } from '../lib/icons';
import { AREAS, AREA_KEYS, areaKey, type AreaKey } from '../lib/util';
import { IB } from '../ui/common';
import { goNode } from '../actions';
import { useUI } from '../state';

/**
 * Full link graph on a canvas (prototype mountGraph/tick/draw): deterministic seeded layout, strong repulsion with a
 * collision margin so nodes never overlap, area anchors (stacked vertically on portrait screens), refit after settle.
 * Pinch and one-finger pan on touch, tap selects with a card on the phone.
 */

interface GN {
  id: string;
  open: string;
  label: string;
  area: AreaKey;
  kind: 'skill' | 'doc';
  deg: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
interface GE {
  s: string;
  t: string;
  bad: boolean;
  contains: boolean;
}

const ANCH: Record<AreaKey, [number, number]> = { rules: [-300, -110], skills: [0, 120], docs: [300, -60] };

/** Module state so positions, zoom and filters survive navigation, like the prototype's G. */
const G = {
  pos: new Map<string, GN>(),
  zoom: 1,
  px: 0,
  py: 0,
  hover: null as GN | null,
  focus: null as GN | null,
  f: { rules: true, skills: true, docs: true } as Record<AreaKey, boolean>,
  q: '',
  alpha: 0,
  raf: 0,
  nodes: [] as GN[],
  edges: [] as GE[],
  idx: new Map<string, GN>(),
  fitted: false,
  refit: false,
  touched: false,
  dragged: false,
  port: undefined as boolean | undefined,
  W: 1,
  H: 1,
  dpr: 1,
  canvas: null as HTMLCanvasElement | null,
  wrap: null as HTMLDivElement | null,
  dragN: null as GN | null,
  down: null as { x: number; y: number; moved: boolean; o: GN | null } | null,
  pan: null as { x: number; y: number; px: number; py: number } | null,
  pinch: null as { d: number; z: number; cx: number; cy: number } | null,
  ptr: new Map<number, { x: number; y: number }>(),
  mobile: false,
  onFocus: (_o: GN | null): void => undefined,
  sig: '',
  /** Usage overlay (owners): node size from agent loads over 30 days, unused faded. */
  usage: false,
  loads: null as Map<string, number> | null,
};

/** Turns the usage overlay on or off for the next time the graph is shown. */
export function showUsageOnGraph(v: boolean): void {
  G.usage = v;
}

const usageOn = (o: GN): boolean => G.usage && !!G.loads && o.area !== 'rules';

function rnd(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gVis = (o: GN | undefined | null): o is GN => !!o && G.f[o.area];
const gRad = (o: GN): number => (usageOn(o) ? 3.5 + Math.sqrt(G.loads!.get(o.id) ?? 0) * 1.5 : 4.5 + Math.sqrt(o.deg) * 2.5);
const anch = (k: AreaKey): [number, number] => {
  const a = ANCH[k];
  return G.H > G.W * 1.2 ? [a[1] * 1.1, a[0] * 1.1] : a;
};
const toW = (sx: number, sy: number): [number, number] => [(sx - G.W / 2 - G.px) / G.zoom, (sy - G.H / 2 - G.py) / G.zoom];

function tick(): void {
  const ns = G.nodes.filter(gVis);
  const k = G.alpha;
  const n = ns.length;
  for (let i = 0; i < n; i++) {
    const a = ns[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = ns[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = 0.5 + i * 0.01;
        dy = 0.5;
        d2 = 0.5;
      }
      const d = Math.sqrt(d2);
      const f = Math.min(11000 / d2, 14) * k;
      dx /= d;
      dy /= d;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
      const md = gRad(a) + gRad(b) + 34;
      if (d < md) {
        const c = (md - d) * 0.25;
        a.x += dx * c;
        a.y += dy * c;
        b.x -= dx * c;
        b.y -= dy * c;
      }
    }
  }
  for (const e of G.edges) {
    const a = G.idx.get(e.s);
    const b = G.idx.get(e.t);
    if (!gVis(a) || !gVis(b)) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - (e.contains ? 80 : 150)) * 0.03 * k;
    dx /= d;
    dy /= d;
    a.vx += dx * f;
    a.vy += dy * f;
    b.vx -= dx * f;
    b.vy -= dy * f;
  }
  const gx = G.port ? 9 : 1;
  const gy = G.port ? 0.2 : 1;
  for (const o of ns) {
    const a = anch(o.area);
    o.vx += ((a[0] - o.x) * 0.006 - o.x * 0.002 * gx) * k;
    o.vy += ((a[1] - o.y) * 0.006 - o.y * 0.002 * gy) * k;
    if (o === G.dragN) {
      o.vx = o.vy = 0;
      continue;
    }
    o.vx *= 0.6;
    o.vy *= 0.6;
    o.x += o.vx;
    o.y += o.vy;
  }
  G.alpha *= 0.975;
}

function sizeCanvas(): void {
  const c = G.canvas;
  const w = G.wrap;
  if (!c || !w) return;
  const r = w.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  G.W = Math.max(1, r.width);
  G.H = Math.max(1, r.height);
  G.dpr = dpr;
  c.width = Math.round(G.W * dpr);
  c.height = Math.round(G.H * dpr);
  c.style.width = G.W + 'px';
  c.style.height = G.H + 'px';
}

function fit(): void {
  const ns = G.nodes.filter(gVis);
  if (!ns.length) return;
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const o of ns) {
    x0 = Math.min(x0, o.x);
    y0 = Math.min(y0, o.y);
    x1 = Math.max(x1, o.x);
    y1 = Math.max(y1, o.y);
  }
  const pad = 60;
  const px = G.mobile ? 75 : 60;
  G.zoom = Math.max(0.25, Math.min(1.6, Math.min(G.W / (x1 - x0 + px * 2), (G.H - 50) / (y1 - y0 + pad * 2))));
  G.px = (-(x0 + x1) / 2) * G.zoom;
  G.py = (-(y0 + y1) / 2) * G.zoom + 16;
}

function center(o: GN): void {
  G.px = -o.x * G.zoom;
  G.py = -o.y * G.zoom;
}

function zoomAt(sx: number, sy: number, z: number): void {
  G.touched = true;
  z = Math.max(0.25, Math.min(4, z));
  const [wx, wy] = toW(sx, sy);
  G.zoom = z;
  G.px = sx - G.W / 2 - wx * z;
  G.py = sy - G.H / 2 - wy * z;
  draw();
}

function kick(): void {
  if (!G.raf) G.raf = requestAnimationFrame(loop);
}

function loop(): void {
  G.raf = 0;
  if (!G.canvas || !G.canvas.isConnected) return;
  const live = G.alpha > 0.004;
  if (live) tick();
  if (!live && !G.touched && !G.dragged && G.refit) {
    G.refit = false;
    fit();
  }
  draw();
  if (live) kick();
}

function draw(): void {
  const c = G.canvas;
  if (!c) return;
  const x = c.getContext('2d');
  if (!x) return;
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string): string => cs.getPropertyValue(n).trim();
  const col: Record<AreaKey, string> = { rules: v('--c-rules'), skills: v('--c-skills'), docs: v('--c-docs') };
  const fg = v('--fg');
  const muted = v('--muted');
  const warn = v('--warn-dot');
  const bg = v('--panel');
  const line = v('--border-2');
  x.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
  x.clearRect(0, 0, G.W, G.H);
  x.save();
  x.translate(G.W / 2 + G.px, G.H / 2 + G.py);
  x.scale(G.zoom, G.zoom);
  const act = G.hover ?? G.focus;
  const nb = new Set<string>();
  if (act) {
    nb.add(act.id);
    for (const e of G.edges) {
      if (e.s === act.id) nb.add(e.t);
      if (e.t === act.id) nb.add(e.s);
    }
  }
  const z = G.zoom;
  for (const e of G.edges) {
    const a = G.idx.get(e.s);
    const b = G.idx.get(e.t);
    if (!gVis(a) || !gVis(b)) continue;
    const on = !!act && (e.s === act.id || e.t === act.id);
    x.globalAlpha = act ? (on ? 0.95 : 0.06) : e.bad ? 0.8 : 0.5;
    x.strokeStyle = e.bad ? warn : on ? col[a.area] : line;
    x.lineWidth = (on ? 1.7 : 1.1) / z;
    x.setLineDash(e.bad || e.contains ? [4 / z, 3 / z] : []);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const rb = gRad(b) + 2.5 / z;
    const ex = b.x - ux * rb;
    const ey = b.y - uy * rb;
    x.beginPath();
    x.moveTo(a.x + ux * gRad(a), a.y + uy * gRad(a));
    x.lineTo(ex, ey);
    x.stroke();
    if (!e.contains && (on || z > 0.7)) {
      x.setLineDash([]);
      x.fillStyle = x.strokeStyle;
      const s = (on ? 6 : 4.5) / z;
      x.beginPath();
      x.moveTo(ex, ey);
      x.lineTo(ex - ux * s - uy * s * 0.55, ey - uy * s + ux * s * 0.55);
      x.lineTo(ex - ux * s + uy * s * 0.55, ey - uy * s - ux * s * 0.55);
      x.closePath();
      x.fill();
    }
  }
  x.setLineDash([]);
  for (const o of G.nodes) {
    if (!gVis(o)) continue;
    const dim = act && !nb.has(o.id);
    x.globalAlpha = dim ? 0.16 : usageOn(o) && !G.loads!.get(o.id) ? 0.25 : 1;
    const r = gRad(o);
    if (o === act) {
      x.globalAlpha = 0.22;
      x.fillStyle = col[o.area];
      x.beginPath();
      x.arc(o.x, o.y, r + 6 / z, 0, 7);
      x.fill();
      x.globalAlpha = 1;
    }
    x.fillStyle = col[o.area];
    x.beginPath();
    x.arc(o.x, o.y, r, 0, 7);
    x.fill();
    x.lineWidth = 2 / z;
    x.strokeStyle = bg;
    x.stroke();
    if (o.kind === 'skill') {
      x.fillStyle = bg;
      x.beginPath();
      x.arc(o.x, o.y, r * 0.38, 0, 7);
      x.fill();
    }
  }
  x.restore();
  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  x.font = '500 12px ' + font;
  x.textAlign = 'center';
  x.textBaseline = 'top';
  x.lineJoin = 'round';
  // Labels: most connected first, skipped when they would overlap one already drawn.
  const placed: number[][] = [];
  const order = G.nodes.filter(gVis).sort((p, q) => Number(q === act) - Number(p === act) || q.deg - p.deg);
  for (const o of order) {
    const show = act ? nb.has(o.id) : z > 0.7 || o.deg >= 4;
    if (!show) continue;
    const sx = G.W / 2 + G.px + o.x * z;
    const sy = G.H / 2 + G.py + (o.y + gRad(o)) * z + 4;
    const w = x.measureText(o.label).width + 6;
    const rc = [sx - w / 2, sy, sx + w / 2, sy + 15];
    if (o !== act && placed.some((r) => rc[0]! < r[2]! && rc[2]! > r[0]! && rc[1]! < r[3]! && rc[3]! > r[1]!)) continue;
    placed.push(rc);
    x.globalAlpha = 1;
    x.lineWidth = 3.5;
    x.strokeStyle = bg;
    x.strokeText(o.label, sx, sy);
    x.fillStyle = o === act ? fg : muted;
    x.fillText(o.label, sx, sy);
  }
  x.globalAlpha = 1;
}

function gpt(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const r = G.canvas!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function gHit(p: { x: number; y: number }): GN | null {
  const [wx, wy] = toW(p.x, p.y);
  let best: GN | null = null;
  let bd = 1e9;
  for (const o of G.nodes) {
    if (!gVis(o)) continue;
    const d = Math.hypot(o.x - wx, o.y - wy);
    if (d < gRad(o) + 7 / G.zoom && d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

function bind(c: HTMLCanvasElement): () => void {
  const down = (e: PointerEvent): void => {
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }
    const p = gpt(e);
    G.ptr.set(e.pointerId, p);
    if (G.ptr.size === 2) {
      const [a, b] = [...G.ptr.values()] as [{ x: number; y: number }, { x: number; y: number }];
      G.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: G.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      G.dragN = null;
      G.pan = null;
      G.down = null;
      return;
    }
    const o = gHit(p);
    G.down = { x: p.x, y: p.y, moved: false, o };
    if (o) G.dragN = o;
    else {
      G.pan = { x: p.x, y: p.y, px: G.px, py: G.py };
      c.style.cursor = 'grabbing';
    }
  };
  const move = (e: PointerEvent): void => {
    const p = gpt(e);
    if (G.ptr.has(e.pointerId)) G.ptr.set(e.pointerId, p);
    if (G.pinch && G.ptr.size === 2) {
      const [a, b] = [...G.ptr.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(G.pinch.cx, G.pinch.cy, (G.pinch.z * d) / G.pinch.d);
      return;
    }
    if (G.down && Math.hypot(p.x - G.down.x, p.y - G.down.y) > 4) G.down.moved = true;
    if (G.dragN && G.down && G.down.moved) {
      const [wx, wy] = toW(p.x, p.y);
      G.dragN.x = wx;
      G.dragN.y = wy;
      G.alpha = Math.max(G.alpha, 0.3);
      kick();
      return;
    }
    if (G.pan) {
      G.touched = true;
      G.px = G.pan.px + (p.x - G.pan.x);
      G.py = G.pan.py + (p.y - G.pan.y);
      draw();
      return;
    }
    if (e.pointerType !== 'touch') {
      const o = gHit(p);
      if (o !== G.hover) {
        G.hover = o;
        c.style.cursor = o ? 'pointer' : 'grab';
        draw();
      }
    }
  };
  const up = (e: PointerEvent): void => {
    G.ptr.delete(e.pointerId);
    if (G.pinch) {
      if (G.ptr.size < 2) G.pinch = null;
      return;
    }
    const d = G.down;
    G.down = null;
    G.dragN = null;
    G.pan = null;
    c.style.cursor = G.hover ? 'pointer' : 'grab';
    if (d && d.moved && d.o) G.dragged = true;
    if (d && !d.moved) {
      if (d.o) {
        if (G.mobile) {
          G.focus = d.o;
          draw();
          G.onFocus(d.o);
          return;
        }
        void goNode(d.o.open);
        return;
      }
      if (G.focus) {
        G.focus = null;
        draw();
        G.onFocus(null);
      }
    }
  };
  const leave = (): void => {
    if (G.hover && !G.down) {
      G.hover = null;
      draw();
    }
  };
  const wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = gpt(e);
    zoomAt(p.x, p.y, G.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  };
  c.addEventListener('pointerdown', down);
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('pointerleave', leave);
  c.addEventListener('wheel', wheel, { passive: false });
  return () => {
    c.removeEventListener('pointerdown', down);
    c.removeEventListener('pointermove', move);
    c.removeEventListener('pointerup', up);
    c.removeEventListener('pointercancel', up);
    c.removeEventListener('pointerleave', leave);
    c.removeEventListener('wheel', wheel);
  };
}

type Data = NonNullable<ReturnType<typeof useGraph>['data']>;

function mount(data: Data): void {
  sizeCanvas();
  const port = G.H > G.W * 1.2;
  if (G.port !== undefined && G.port !== port) {
    G.pos.clear();
    G.fitted = false;
    G.touched = false;
  }
  G.port = port;
  const nodes: GN[] = data.nodes.map((n) => ({ id: n.id, open: n.open_id, label: n.label, area: areaKey(n.area), kind: n.kind, deg: 0, x: 0, y: 0, vx: 0, vy: 0 }));
  const idx = new Map(nodes.map((o) => [o.id, o]));
  const edges: GE[] = data.edges.filter((e) => idx.has(e.from) && idx.has(e.to) && e.from !== e.to).map((e) => ({ s: e.from, t: e.to, bad: e.status === 'wrong_direction', contains: e.contains }));
  for (const e of edges) {
    idx.get(e.s)!.deg++;
    idx.get(e.t)!.deg++;
  }
  // Deterministic: initial positions come from a fixed seed in a stable order.
  const r = rnd(7);
  let fresh = 0;
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const seeds = new Map(sorted.map((o) => [o.id, [r(), r()] as [number, number]]));
  for (const o of nodes) {
    const p = G.pos.get(o.id);
    if (p) {
      o.x = p.x;
      o.y = p.y;
    } else {
      const a = anch(o.area);
      const s = seeds.get(o.id)!;
      o.x = a[0] + (s[0] - 0.5) * 300;
      o.y = a[1] + (s[1] - 0.5) * 300;
      fresh++;
    }
    G.pos.set(o.id, o);
  }
  G.nodes = nodes;
  G.edges = edges;
  G.idx = idx;
  if (G.hover && !idx.has(G.hover.id)) G.hover = null;
  if (G.focus) G.focus = idx.get(G.focus.id) ?? null;
  if (fresh) {
    G.alpha = 1;
    for (let i = 0; i < 450; i++) tick();
    G.alpha = 0.03;
    G.fitted = G.touched ? G.fitted : false;
  }
  if (!G.fitted) {
    fit();
    G.fitted = true;
    G.refit = true;
  }
  if (G.focus) center(G.focus);
  draw();
  kick();
}

function gFind(q: string): GN | null {
  G.q = q;
  const ql = q.trim().toLowerCase();
  if (!ql) {
    G.focus = null;
    draw();
    return null;
  }
  let best: GN | null = null;
  let bs = -1;
  for (const o of G.nodes) {
    if (!gVis(o)) continue;
    const l = o.label.toLowerCase();
    const k = l.indexOf(ql);
    if (k < 0) continue;
    const s = (k === 0 ? 50 : 0) + o.deg - l.length * 0.1;
    if (s > bs) {
      bs = s;
      best = o;
    }
  }
  G.focus = best;
  if (best) center(best);
  draw();
  return best;
}

export function GraphPage({ focus, mobile }: { focus: string | null; mobile?: boolean }): ReactElement {
  const g = useGraph();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [, setF] = useState(0);
  const [card, setCard] = useState<GN | null>(null);
  const [q, setQ] = useState(G.q);
  useUI((s) => s.theme);
  const owner = useMe().data?.user.org_role === 'owner';
  const [usage, setUsage] = useState(G.usage);
  const u = useQuery({ queryKey: ['usage', 30], enabled: owner && usage, staleTime: 60_000, queryFn: () => api.get_usage({ days: 30 }) });
  G.usage = owner && usage;
  G.loads = u.data ? new Map(u.data.items.map((i) => [i.id, i.loads])) : null;
  G.mobile = !!mobile;
  G.onFocus = (o) => setCard(o);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    G.canvas = c;
    G.wrap = wrap.current;
    const unbind = bind(c);
    const ro = new ResizeObserver(() => {
      sizeCanvas();
      if (!G.touched) fit();
      draw();
    });
    if (wrap.current) ro.observe(wrap.current);
    return () => {
      unbind();
      ro.disconnect();
      cancelAnimationFrame(G.raf);
      G.raf = 0;
    };
  }, []);

  useEffect(() => {
    if (!g.data || !G.canvas) return;
    mount(g.data);
    if (focus) {
      const o = G.idx.get(focus);
      if (o) {
        G.focus = o;
        if (G.zoom < 1) G.zoom = 1.1;
        center(o);
        draw();
        if (G.mobile) setCard(o);
      }
    }
  }, [g.data, focus]);

  useEffect(() => {
    draw();
  });

  const toggle = (k: AreaKey): void => {
    const on = AREA_KEYS.filter((a) => G.f[a]);
    if (G.f[k] && on.length === 1) return;
    G.f[k] = !G.f[k];
    G.alpha = Math.max(G.alpha, 0.35);
    kick();
    setF((x) => x + 1);
  };
  const lc = card ? G.edges.filter((e) => e.s === card.id || e.t === card.id).length : 0;

  return (
    <div className="gwrap" id="gwrap" ref={wrap}>
      <canvas id="gc" ref={canvas} aria-label="Link graph" />
      <div className="gtop">
        <div className="seg gseg" role="group" aria-label="Areas">
          {AREA_KEYS.map((a) => (
            <button key={a} className={(G.f[a] ? 'on ' : '') + 'a-' + a} aria-label={AREAS[a].label} aria-pressed={G.f[a]} data-tip={AREAS[a].label} onClick={() => toggle(a)}>
              <Ic n={AREAS[a].icon} s={15} />
            </button>
          ))}
        </div>
        <div className="qwrap gq">
          <Ic n="search" s={15} />
          <input
            className="input"
            id="gq"
            placeholder="Find"
            value={q}
            autoComplete="off"
            spellCheck={false}
            aria-label="Find in graph"
            onChange={(e) => {
              setQ(e.target.value);
              const o = gFind(e.target.value);
              if (G.mobile) setCard(o);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && G.focus) {
                e.preventDefault();
                void goNode(G.focus.open);
              } else if (e.key === 'Escape') {
                setQ('');
                gFind('');
                setCard(null);
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        {owner ? (
          <button
            className={'btn sm gu' + (usage ? ' on' : '')}
            aria-pressed={usage}
            data-tip="Size by agent loads in the last 30 days, fade what was never loaded"
            onClick={() => {
              setUsage(!usage);
              G.alpha = Math.max(G.alpha, 0.35);
              kick();
            }}
          >
            <Ic n="chart" s={14} />
            <span>Usage</span>
          </button>
        ) : null}
      </div>
      <div className="gzoom">
        <IB icon="plus" tip="Zoom in" data-a="gz-in" onClick={() => zoomAt(G.W / 2, G.H / 2, G.zoom * 1.3)} />
        <IB icon="minus" tip="Zoom out" data-a="gz-out" onClick={() => zoomAt(G.W / 2, G.H / 2, G.zoom / 1.3)} />
        <IB
          icon="maximize"
          tip="Fit"
          onClick={() => {
            fit();
            G.touched = false;
            draw();
          }}
        />
      </div>
      <div className="glegend">
        <span data-tip="Link">
          <i className="gl" />
        </span>
        <span data-tip="Against the area rules">
          <i className="gl bad" />
          <Ic n="alert" s={11} />
        </span>
        <span data-tip="Sub-skill">
          <i className="gl dash" />
          <Ic n="sparkles" s={11} />
        </span>
      </div>
      {mobile ? (
        <div className={'gcard' + (card ? ' on' : '')} id="gcard" role="status">
          {card ? (
            <>
              <span className={'m-ic sm a-' + card.area}>
                <Ic n={card.kind === 'skill' ? 'sparkles' : 'file'} s={16} />
              </span>
              <span className="m-tx">
                <span className="m-t">{card.label}</span>
                <span className="m-s" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Ic n="link" s={12} />
                  {lc}
                </span>
              </span>
              <button
                className="mb"
                aria-label="Clear"
                onClick={() => {
                  G.focus = null;
                  G.q = '';
                  setQ('');
                  draw();
                  setCard(null);
                }}
              >
                <Ic n="x" s={20} />
              </button>
              <button className="btn primary" aria-label="Open" onClick={() => void goNode(card.open)}>
                <Ic n="arrow" s={17} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
