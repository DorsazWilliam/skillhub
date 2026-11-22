import { AREA_IDS, SKILL_MD, areaByName, areaOfPath, type Area } from './areas';

/**
 * Canonical links, mirroring the approved prototype (extractLinks, canon, resolvePath, linkAllowed, classify).
 * A link is [[area/path]] or [[area/path|label]]; the path has no .md suffix. Links inside code are ignored.
 */
const WL = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g;
export const MAX_LINKS = 200;

export type LinkStatus = 'ok' | 'wrong_direction' | 'broken' | 'locked';

export interface RawLink {
  path: string;
  label: string | null;
}

export function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

export function extractLinks(md: string): RawLink[] {
  const out: RawLink[] = [];
  for (const m of stripCode(md).matchAll(WL)) out.push({ path: (m[1] ?? '').trim(), label: m[2] ? m[2].trim() : null });
  return out;
}

/** Distinct links in order of first appearance (the prototype dedupes on the path as written). */
export function distinctLinks(md: string): RawLink[] {
  const seen = new Set<string>();
  const out: RawLink[] = [];
  for (const l of extractLinks(md)) {
    if (!l.path || seen.has(l.path)) continue;
    seen.add(l.path);
    out.push(l);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

export function linkSegments(p: string): string[] {
  return p
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

/** Minimal node shape the link logic needs. */
export interface TNode {
  id: string;
  parent_id: string | null;
  kind: 'folder' | 'doc';
  name: string;
  path: string;
}

/** Lookups a resolver needs; implemented against D1 (per request) and in memory (graph). */
export interface TreeSource {
  get(id: string): Promise<TNode | null>;
  /** Live child named seg, seg + '.md', or seg without '.md' (case-insensitive; exact name first). */
  child(parentId: string, seg: string): Promise<TNode | null>;
  /** First live skill folder with this name inside skills/ (shallowest, then by id). */
  findSkill(name: string): Promise<TNode | null>;
  /** Which of these folder ids are skill folders (contain a live SKILL.md). */
  skillSet(folderIds: string[]): Promise<Set<string>>;
}

/** prototype resolvePath: area name first; under skills/, a direct walk, else the skill named by the second segment. */
export async function resolvePath(src: TreeSource, p: string): Promise<TNode | null> {
  const segs = linkSegments(p);
  if (segs.length === 0) return null;
  const area = areaByName(segs[0]!);
  if (!area) return null;
  let cur = await src.get(AREA_IDS[area]);
  if (!cur) return null;
  let i = 1;
  if (area === 'skills' && segs.length > 1) {
    let direct: TNode | null = cur;
    for (let j = 1; direct && j < segs.length; j++) direct = await src.child(direct.id, segs[j]!);
    if (direct) return direct;
    const sk = await src.findSkill(segs[1]!);
    if (!sk) return null;
    cur = sk;
    i = 2;
  }
  for (; cur && i < segs.length; i++) cur = await src.child(cur.id, segs[i]!);
  return cur;
}

export function chainOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Where a node sits: its area and the nearest skill folder containing it (a skill folder contains itself). */
export interface Placed {
  id: string;
  area: Area | null;
  chain: string[];
  skillId: string | null;
}

export function place(node: TNode, skills: Set<string>): Placed {
  const chain = chainOf(node.path);
  const folders = node.kind === 'doc' ? chain.slice(0, -1) : chain;
  let skillId: string | null = null;
  for (let i = folders.length - 1; i >= 0; i--) {
    if (skills.has(folders[i]!)) {
      skillId = folders[i]!;
      break;
    }
  }
  return { id: node.id, area: areaOfPath(node.path), chain, skillId };
}

/**
 * Allowed directions: rules -> skills, documentation; skills -> documentation, prototypes and inside their own skill;
 * documentation -> documentation, prototypes; prototypes -> documentation, prototypes.
 */
export function linkAllowed(src: Placed, tgt: Placed): boolean {
  if (src.area === 'rules') return tgt.area === 'skills' || tgt.area === 'documentation';
  if (src.area === 'skills') {
    if (tgt.area === 'documentation' || tgt.area === 'prototypes') return true;
    return !!src.skillId && tgt.chain.includes(src.skillId);
  }
  return tgt.area === 'documentation' || tgt.area === 'prototypes';
}

export interface ChainNode {
  id: string;
  name: string;
  kind: 'folder' | 'doc';
}

/**
 * prototype canon(): skills/<skill>/<file path> for anything inside a skill (SKILL.md dropped, .md stripped),
 * skills/<parent skill>/<path to sub-skill>/... for sub-skills, otherwise area/folders/name.
 * `chain` runs from the area root down to the node. Returns the path and the ids whose names it uses.
 */
export function canonFromChain(chain: ChainNode[], skills: Set<string>): { path: string; uses: string[] } {
  const self = chain[chain.length - 1];
  if (!self) return { path: '', uses: [] };
  const start = self.kind === 'doc' ? chain.length - 2 : chain.length - 1;
  let sk = -1;
  for (let i = start; i >= 0; i--) {
    if (chain[i]!.kind === 'folder' && skills.has(chain[i]!.id)) {
      sk = i;
      break;
    }
  }
  if (sk < 0) return { path: chain.map((n) => n.name).join('/'), uses: chain.slice(1).map((n) => n.id) };
  let ps = -1;
  for (let i = sk - 1; i >= 0; i--) {
    if (skills.has(chain[i]!.id)) {
      ps = i;
      break;
    }
  }
  const baseFrom = ps >= 0 ? ps : sk;
  const base = chain.slice(baseFrom, sk + 1);
  const below = chain.slice(sk + 1).filter((n) => !(n.kind === 'doc' && n.name === SKILL_MD));
  const path = ['skills', ...base.map((n) => n.name), ...below.map((n) => n.name)].join('/').replace(/\.md$/, '');
  return { path, uses: [...base, ...below].map((n) => n.id) };
}

/** Lower-cased lookup keys under which links to this node may be stored (canonical and full path, with and without .md). */
export function pathKeys(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const k = linkSegments(p).join('/').toLowerCase();
    if (!k) continue;
    out.add(k);
    out.add(k.endsWith('.md') ? k.slice(0, -3) : k + '.md');
  }
  return [...out];
}
