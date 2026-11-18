import { z } from 'zod';
import { all, chainIds, one, qs, type NodeRow } from '../db/d1';
import type { Authz } from '../authz/authorize';
import { roleName } from '../authz/roles';
import { ULID_RE } from '../lib/ulid';

// ---------- shared schemas ----------

export const NodeRef = z.string().min(1).max(2000).describe('Node id, or a path like /Engineering/Data/sql-review');
export const RoleEnum = z.enum(['viewer', 'editor', 'publisher', 'manager']);
export const AccessEnum = z.enum(['none', 'viewer', 'editor', 'publisher', 'manager']);
export const Cursor = z.string().max(200).optional().describe('Opaque cursor from a previous page');
export const Limit = z.number().int().min(1).max(100).optional().describe('Page size, default 50');

export const NodeOut = z.object({
  id: z.string(),
  kind: z.enum(['folder', 'doc']),
  name: z.string(),
  path: z.string().describe('Display path from the highest folder you can read'),
  parent_id: z.string().nullable().describe('null when the parent is the top level or not readable'),
  access: AccessEnum,
  inherit: z.boolean().optional(),
  is_skill: z.boolean().optional(),
  published_version: z.number().nullable().optional(),
  head_version: z.number().nullable().optional().describe('Editors and above only'),
  has_draft: z.boolean().nullable().optional().describe('Editors and above only'),
  updated_at: z.number(),
});
export type NodeOutT = z.infer<typeof NodeOut>;

export const Page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_cursor: z.string().nullable() });

// ---------- node loading ----------

export async function getNodeById(db: D1Database, id: string, opts: { deleted?: boolean } = {}): Promise<NodeRow | null> {
  return one<NodeRow>(db, `SELECT * FROM nodes WHERE id = ? AND deleted_at IS ${opts.deleted ? 'NOT NULL' : 'NULL'}`, id);
}

export async function getNodesByIds(db: D1Database, ids: string[]): Promise<NodeRow[]> {
  const out: NodeRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    out.push(...(await all<NodeRow>(db, `SELECT * FROM nodes WHERE id IN (${qs(part.length)})`, ...part)));
  }
  return out;
}

/**
 * The highest readable folders for the actor ("Shared with me", Google Drive style).
 * Owners see the real top level. Nothing unreadable is returned.
 */
export async function sharedTops(az: Authz): Promise<NodeRow[]> {
  if (az.isOwner) {
    return all<NodeRow>(az.db, 'SELECT * FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY lower(name), id');
  }
  const granted = (await getNodesByIds(az.db, await az.grantedNodeIds())).filter((n) => n.kind === 'folder' && n.deleted_at === null);
  const parentIds = [...new Set(granted.map((n) => n.parent_id).filter((x): x is string => x !== null))];
  const parents = await getNodesByIds(az.db, parentIds);
  const parentRoles = await az.roles(parents);
  const tops = granted.filter((n) => n.parent_id === null || (parentRoles.get(n.parent_id) ?? 0) === 0);
  return tops.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

/** Resolves a NodeRef (id or display path). Returns null if nothing matches. Never checks access. */
export async function resolveRef(az: Authz, ref: string, opts: { deleted?: boolean } = {}): Promise<NodeRow | null> {
  const trimmed = ref.trim();
  if (ULID_RE.test(trimmed)) return getNodeById(az.db, trimmed, opts);
  if (!trimmed.startsWith('/')) return null;
  const segs = trimmed
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s).replace(/\.md$/i, ''));
  if (segs.length === 0) return null;
  const first = segs[0]!.toLowerCase();
  const tops = (await sharedTops(az)).filter((n) => n.name.toLowerCase() === first);
  let cur: NodeRow | null = tops[0] ?? null;
  for (let i = 1; cur && i < segs.length; i++) {
    cur = await one<NodeRow>(az.db, 'SELECT * FROM nodes WHERE parent_id = ? AND lower(name) = ? AND deleted_at IS NULL', cur.id, segs[i]!.toLowerCase());
  }
  return cur;
}

/** Display paths: names from the highest readable ancestor down to the node. */
export async function displayPaths(az: Authz, nodes: NodeRow[]): Promise<Map<string, { path: string; parentVisible: boolean }>> {
  const ids = new Set<string>();
  for (const n of nodes) for (const id of chainIds(n.path)) ids.add(id);
  const chainNodes = await getNodesByIds(az.db, [...ids]);
  const byId = new Map(chainNodes.map((n) => [n.id, n]));
  const folderRoles = await az.roles(chainNodes.filter((n) => n.kind === 'folder'));
  const out = new Map<string, { path: string; parentVisible: boolean }>();
  for (const n of nodes) {
    const chain = chainIds(n.path);
    const names: string[] = [n.name];
    let parentVisible = false;
    for (let i = chain.length - 2; i >= 0; i--) {
      const anc = byId.get(chain[i]!);
      if (!anc || (folderRoles.get(anc.id) ?? 0) === 0) break;
      if (i === chain.length - 2) parentVisible = true;
      names.unshift(anc.name);
    }
    out.set(n.id, { path: '/' + names.join('/'), parentVisible });
  }
  return out;
}

export async function nodeOuts(az: Authz, nodes: NodeRow[], roles?: Map<string, number>): Promise<NodeOutT[]> {
  if (nodes.length === 0) return [];
  const r = roles ?? (await az.roles(nodes));
  const paths = await displayPaths(az, nodes);
  const docIds = nodes.filter((n) => n.kind === 'doc' && (r.get(n.id) ?? 0) >= 2).map((n) => n.id);
  const drafts = new Set<string>();
  for (let i = 0; i < docIds.length; i += 90) {
    const part = docIds.slice(i, i + 90);
    for (const d of await all<{ doc_id: string }>(az.db, `SELECT doc_id FROM drafts WHERE doc_id IN (${qs(part.length)})`, ...part)) drafts.add(d.doc_id);
  }
  return nodes.map((n) => {
    const role = r.get(n.id) ?? 0;
    const p = paths.get(n.id);
    const editor = role >= 2;
    const base: NodeOutT = {
      id: n.id,
      kind: n.kind,
      name: n.name,
      path: p?.path ?? '/' + n.name,
      parent_id: p?.parentVisible ? n.parent_id : null,
      access: roleName(role),
      updated_at: n.updated_at,
    };
    if (n.kind === 'folder') base.inherit = n.inherit === 1;
    else {
      base.is_skill = n.is_skill === 1;
      base.published_version = n.published_version;
      base.head_version = editor ? n.head_version : null;
      base.has_draft = editor ? drafts.has(n.id) : null;
    }
    return base;
  });
}

export async function nodeOut(az: Authz, node: NodeRow): Promise<NodeOutT> {
  const [o] = await nodeOuts(az, [node]);
  return o!;
}

/** Simple cursor: base64 of the last sort key. */
export function encodeCursor(parts: (string | number)[]): string {
  return btoa(JSON.stringify(parts));
}

export function decodeCursor(c: string | undefined): (string | number)[] | null {
  if (!c) return null;
  try {
    const v: unknown = JSON.parse(atob(c));
    return Array.isArray(v) ? (v as (string | number)[]) : null;
  } catch {
    return null;
  }
}
