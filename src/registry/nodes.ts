import { z } from 'zod';
import { all, chainIds, one, stmt, type NodeRow } from '../db/d1';
import { ftsReplace, skillFlag } from '../db/fts';
import { DbTree } from '../db/tree';
import { linkStmts } from './content';
import { SKILL_MD, areaOfPath, formatOfName, isAreaId, normalizeDocName } from '../lib/areas';
import { SKILL_NAME_RE, withFrontmatter } from '../lib/frontmatter';
import { AppError, conflict, invalid } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import { validateName } from '../lib/names';
import { ulid } from '../lib/ulid';
import { sha256Hex } from '../lib/crypto';
import { ROLE } from '../authz/roles';
import type { Authz } from '../authz/authorize';
import { defineOp } from './types';
import { ListItemOut, listExtras } from './listing';
import { Cursor, Limit, NodeOut, NodeRef, Page, decodeCursor, encodeCursor, getNodeById, nodeOut, nodeOuts, resolveRef, sharedTops } from './shared';

export function isUnique(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/** Index-friendly subtree bounds: every path under p sorts in [p, p with its trailing "/" bumped to "0"). */
export function subtree(p: string): [string, string] {
  return [p, p.slice(0, -1) + '0'];
}

function depthOf(path: string): number {
  return chainIds(path).length;
}

const managerReq = { scope: 'manage', kind: 'node', minRole: ROLE.manager } as const;

/** Grants that a node inherits from its ancestors (up to the first boundary), as principal -> max role. */
async function inheritedGrants(az: Authz, parentPath: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!parentPath) return out;
  const chain = chainIds(parentPath).reverse();
  const rows = await all<{ id: string; inherit: number }>(az.db, `SELECT id, inherit FROM nodes WHERE id IN (${chain.map(() => '?').join(',')})`, ...chain);
  const flags = new Map(rows.map((r) => [r.id, r.inherit]));
  const ids: string[] = [];
  for (const id of chain) {
    ids.push(id);
    if ((flags.get(id) ?? 1) === 0) break;
  }
  const grants = await all<{ principal_type: string; principal_id: string; role: number }>(
    az.db,
    `SELECT principal_type, principal_id, role FROM grants WHERE node_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  for (const g of grants) {
    const k = `${g.principal_type}:${g.principal_id}`;
    out.set(k, Math.max(out.get(k) ?? 0, g.role));
  }
  return out;
}

function sameGrants(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export const listChildren = defineOp({
  name: 'list_children',
  summary: 'List readable children of a folder. Without a folder, list the highest folders shared with you.',
  scope: 'read',
  target: { kind: 'node', field: 'folder', minRole: ROLE.viewer, nodeKind: 'folder', nullable: 'any' },
  input: z.object({ folder: NodeRef.optional(), cursor: Cursor, limit: Limit }),
  output: Page(ListItemOut),
  rest: { method: 'GET', path: '/children' },
  mcp: { tool: 'list_children', readOnly: true },
  handler: async (ctx, input) => {
    const limit = input.limit ?? 50;
    if (!ctx.node) {
      const tops = await sharedTops(ctx.az);
      const after = decodeCursor(input.cursor);
      const start = after ? tops.findIndex((n) => n.id === after[0]) + 1 : 0;
      const slice = tops.slice(start, start + limit);
      const next = start + limit < tops.length ? encodeCursor([slice[slice.length - 1]!.id]) : null;
      const topRoles = await ctx.az.roles(slice);
      return { items: await listExtras(ctx.az, slice, await nodeOuts(ctx.az, slice, topRoles), topRoles), next_cursor: next };
    }
    const after = decodeCursor(input.cursor);
    const rows = after
      ? await all<NodeRow>(
          ctx.db,
          `SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL
           AND (CASE kind WHEN 'folder' THEN 0 ELSE 1 END, lower(name), id) > (?, ?, ?)
           ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, lower(name), id LIMIT ?`,
          ctx.node.id,
          after[0],
          after[1],
          after[2],
          limit + 1,
        )
      : await all<NodeRow>(
          ctx.db,
          `SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL
           ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, lower(name), id LIMIT ?`,
          ctx.node.id,
          limit + 1,
        );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? encodeCursor([last.kind === 'folder' ? 0 : 1, last.name.toLowerCase(), last.id]) : null;
    const roles = await ctx.az.roles(page);
    const readable = page.filter((n) => (roles.get(n.id) ?? 0) > 0);
    return { items: await listExtras(ctx.az, readable, await nodeOuts(ctx.az, readable, roles), roles), next_cursor: next };
  },
});

export const getNode = defineOp({
  name: 'get_node',
  summary: 'Get metadata for a folder or document.',
  scope: 'read',
  target: { kind: 'node', field: 'node', minRole: ROLE.viewer },
  input: z.object({ node: NodeRef }),
  output: NodeOut,
  rest: { method: 'GET', path: '/nodes/{node}' },
  mcp: { tool: 'get_node', readOnly: true },
  handler: async (ctx) => nodeOut(ctx.az, ctx.node!),
});

const AREA_FIXED = 'The rules, skills and documentation areas are fixed: they cannot be renamed, moved or deleted';

/** True when the folder is, or sits inside, a skill folder. */
async function inSkill(db: D1Database, folder: NodeRow): Promise<boolean> {
  const skills = await new DbTree(db).chainSkills([folder]);
  return chainIds(folder.path).some((id) => skills.has(id));
}

/**
 * Area rules for a new or renamed node in `parent`: rules/ holds markdown only and no folders; documentation/ holds
 * folders and markdown; under skills/ documents live inside a skill folder (SKILL.md makes its folder a skill), and
 * text files (scripts) are allowed only there. Returns the normalized name and the document format.
 */
export async function checkPlacement(db: D1Database, parent: NodeRow, kind: 'folder' | 'doc', rawName: string): Promise<{ name: string; format: string }> {
  const area = areaOfPath(parent.path);
  if (kind === 'folder') {
    if (area === 'rules') throw invalid('rules/ holds rules only: no folders');
    return { name: rawName, format: 'markdown' };
  }
  const name = normalizeDocName(rawName);
  const format = formatOfName(name);
  if (area === 'rules') {
    if (name === SKILL_MD || format !== 'markdown') throw invalid('rules/ holds markdown rules only');
  } else if (area === 'documentation') {
    if (name === SKILL_MD) throw invalid('SKILL.md belongs in a skill folder under skills/');
    if (format !== 'markdown') throw invalid('Text files (scripts) live inside a skill folder under skills/');
  } else if (area === 'skills') {
    if (name === SKILL_MD) {
      if (isAreaId(parent.id)) throw invalid('Create a folder for the skill first: SKILL.md goes inside it');
    } else if (!(await inSkill(db, parent))) {
      throw invalid('Documents under skills/ live inside a skill folder (a folder with a SKILL.md). Use create_skill first.');
    }
  }
  return { name, format };
}

async function insertNode(ctx: { db: D1Database; actor: { user: { id: string } } }, parent: NodeRow | null, kind: 'folder' | 'doc', rawName: string): Promise<NodeRow> {
  if (!parent) throw invalid('Choose a parent folder: the top level holds only the rules, skills and documentation areas');
  if (parent.kind !== 'folder') throw invalid('Parent must be a folder');
  const { name, format } = await checkPlacement(ctx.db, parent, kind, validateName(rawName));
  const id = ulid();
  const path = parent.path + id + '/';
  if (depthOf(path) > LIMITS.folderDepth + (kind === 'doc' ? 1 : 0)) throw invalid(`Folders can be at most ${LIMITS.folderDepth} levels deep`);
  const now = Date.now();
  try {
    await stmt(
      ctx.db,
      'INSERT INTO nodes (id, parent_id, kind, name, path, inherit, format, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?,?)',
      id,
      parent.id,
      kind,
      name,
      path,
      format,
      ctx.actor.user.id,
      now,
      now,
    ).run();
  } catch (e) {
    if (isUnique(e)) throw conflict(`"${name}" already exists here`);
    throw e;
  }
  return (await getNodeById(ctx.db, id))!;
}

export const createFolder = defineOp({
  name: 'create_folder',
  summary: 'Create a folder inside skills/ or documentation/ (rules/ has no folders; the top level holds only the three areas). For a skill, use create_skill.',
  scope: 'write',
  target: { kind: 'node', field: 'parent', minRole: ROLE.editor, nodeKind: 'folder' },
  input: z.object({ parent: NodeRef, name: z.string().min(1).max(LIMITS.nameChars) }),
  output: NodeOut,
  rest: { method: 'POST', path: '/folders' },
  mcp: { tool: 'create_folder' },
  handler: async (ctx, input) => {
    const node = await insertNode(ctx, ctx.node, 'folder', input.name);
    ctx.audit.nodeId = node.id;
    ctx.audit.detail = { name: node.name, parent: ctx.node?.id ?? null };
    ctx.az.reset();
    return nodeOut(ctx.az, node);
  },
});

export const createDoc = defineOp({
  name: 'create_doc',
  summary:
    'Create a document in a folder, optionally with initial draft content. Names ending in .sh .py .sql .js .ts .json .yaml .yml .toml .txt .csv .ps1 are text files, allowed only inside a skill folder.',
  scope: 'write',
  target: { kind: 'node', field: 'parent', minRole: ROLE.editor, nodeKind: 'folder' },
  input: z.object({
    parent: NodeRef,
    name: z.string().min(1).max(LIMITS.nameChars),
    content: z.string().max(LIMITS.docBytes).optional().describe('Initial draft markdown'),
  }),
  output: z.object({ node: NodeOut, etag: z.string().nullable() }),
  rest: { method: 'POST', path: '/docs' },
  mcp: { tool: 'create_doc' },
  handler: async (ctx, input) => {
    const node = await insertNode(ctx, ctx.node, 'doc', input.name);
    ctx.audit.nodeId = node.id;
    ctx.audit.detail = { name: node.name };
    let etag: string | null = null;
    if (input.content !== undefined) {
      etag = (await sha256Hex(input.content + ':' + Date.now())).slice(0, 16);
      await ctx.db.batch([
        stmt(ctx.db, 'INSERT INTO drafts (doc_id, content, base_version, etag, updated_by, updated_at) VALUES (?,?,0,?,?,?)', node.id, input.content, etag, ctx.actor.user.id, Date.now()),
        ...(await linkStmts(ctx.db, new DbTree(ctx.db), node, 'draft', input.content)),
      ]);
    }
    return { node: await nodeOut(ctx.az, node), etag };
  },
});

export const createSkill = defineOp({
  name: 'create_skill',
  summary:
    'Create a skill: a folder under skills/ holding a SKILL.md draft with the name and description. Inside another skill it becomes a sub-skill. Then edit the draft, commit, and publish with publish_skill.',
  scope: 'write',
  target: { kind: 'node', field: 'parent', minRole: ROLE.editor, nodeKind: 'folder' },
  input: z.object({
    parent: NodeRef.describe('skills/, an organisational folder in it, or a skill (for a sub-skill)'),
    name: z.string().min(1).max(64).regex(SKILL_NAME_RE, 'Lowercase letters, digits and hyphens').describe('Skill name: also the folder name'),
    description: z.string().max(1024).optional().describe('One line that says when to use the skill'),
  }),
  output: z.object({ folder: NodeOut, skill_md: NodeOut, etag: z.string() }),
  rest: { method: 'POST', path: '/skills' },
  mcp: { tool: 'create_skill' },
  handler: async (ctx, input) => {
    const parent = ctx.node!;
    if (areaOfPath(parent.path) !== 'skills') throw invalid('Skills live under skills/');
    await checkPlacement(ctx.db, parent, 'folder', input.name);
    const folderId = ulid();
    const docId = ulid();
    const folderPath = parent.path + folderId + '/';
    if (depthOf(folderPath) > LIMITS.folderDepth) throw invalid(`Folders can be at most ${LIMITS.folderDepth} levels deep`);
    const content = withFrontmatter(`# ${input.name}\n\n1. \n`, { name: input.name, description: input.description ?? '' });
    const etag = (await sha256Hex(`${content}:${Date.now()}:${crypto.randomUUID()}`)).slice(0, 20);
    const now = Date.now();
    const uid = ctx.actor.user.id;
    try {
      await ctx.db.batch([
        stmt(ctx.db, "INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at) VALUES (?,?, 'folder', ?,?,1,?,?,?)", folderId, parent.id, input.name, folderPath, uid, now, now),
        stmt(ctx.db, "INSERT INTO nodes (id, parent_id, kind, name, path, inherit, format, created_by, created_at, updated_at) VALUES (?,?, 'doc', ?,?,1, 'markdown', ?,?,?)", docId, folderId, SKILL_MD, folderPath + docId + '/', uid, now, now),
        stmt(ctx.db, 'INSERT INTO drafts (doc_id, content, base_version, etag, updated_by, updated_at) VALUES (?,?,0,?,?,?)', docId, content, etag, uid, now),
      ]);
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${input.name}" already exists here`);
      throw e;
    }
    ctx.audit.nodeId = folderId;
    ctx.audit.detail = { name: input.name, parent: parent.id };
    ctx.az.reset();
    const [folder, md] = await nodeOuts(ctx.az, [(await getNodeById(ctx.db, folderId))!, (await getNodeById(ctx.db, docId))!]);
    return { folder: folder!, skill_md: md!, etag };
  },
});

export const renameNode = defineOp({
  name: 'rename_node',
  summary: 'Rename a folder or document.',
  scope: 'write',
  target: { kind: 'node', field: 'node', minRole: ROLE.editor },
  input: z.object({ node: NodeRef, name: z.string().min(1).max(LIMITS.nameChars) }),
  output: NodeOut,
  rest: { method: 'PATCH', path: '/nodes/{node}' },
  mcp: { tool: 'rename_node' },
  handler: async (ctx, input) => {
    const node = ctx.node!;
    if (isAreaId(node.id)) throw invalid(AREA_FIXED);
    const parent = node.parent_id ? await getNodeById(ctx.db, node.parent_id) : null;
    if (!parent) throw invalid(AREA_FIXED);
    const { name, format } = await checkPlacement(ctx.db, parent, node.kind, validateName(input.name));
    const renamed: NodeRow = { ...node, name, format: node.kind === 'doc' ? format : node.format };
    const stmts = [stmt(ctx.db, 'UPDATE nodes SET name = ?, format = ?, updated_at = ? WHERE id = ?', name, renamed.format, Date.now(), node.id)];
    if (node.kind === 'doc' && node.published_version !== null) {
      const v = await one<{ content: string }>(ctx.db, 'SELECT content FROM doc_versions WHERE doc_id = ? AND n = ?', node.id, node.published_version);
      const content = v?.content ?? null;
      stmts.push(stmt(ctx.db, 'UPDATE nodes SET is_skill = ? WHERE id = ?', skillFlag(renamed, content), node.id), ...ftsReplace(ctx.db, renamed, content));
    }
    try {
      await ctx.db.batch(stmts);
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" already exists here`);
      throw e;
    }
    ctx.audit.detail = { from: node.name, to: name };
    ctx.az.reset();
    return nodeOut(ctx.az, (await getNodeById(ctx.db, node.id))!);
  },
});

export const moveNode = defineOp({
  name: 'move_node',
  summary: 'Move a folder or document to another folder in the same area. Needs manager on the source and the destination.',
  scope: 'manage',
  target: { kind: 'node', field: 'node', minRole: ROLE.manager },
  input: z.object({ node: NodeRef, to: NodeRef.describe('Destination folder, in the same area') }),
  output: z.object({ node: NodeOut, moved: z.number(), access_changed: z.boolean(), warning: z.string().nullable() }),
  rest: { method: 'POST', path: '/nodes/{node}/move' },
  mcp: { tool: 'move_node', destructive: true },
  handler: async (ctx, input) => {
    const node = ctx.node!;
    const az = ctx.az;
    if (isAreaId(node.id) || !node.parent_id) throw invalid(AREA_FIXED);
    const sourceParent = await getNodeById(ctx.db, node.parent_id);
    await az.authorize(managerReq, { node: sourceParent });

    if (input.to === '/' || input.to.trim() === '') throw invalid('The top level holds only the rules, skills and documentation areas');
    const dest = await resolveRef(az, input.to);
    if (!dest) throw new AppError('not_found', 'Destination not found');
    if (dest.kind !== 'folder') throw invalid('Destination must be a folder');
    await az.authorize(managerReq, { node: dest });
    const area = areaOfPath(node.path);
    if (areaOfPath(dest.path) !== area) throw invalid('Items stay in their area: move within rules/, skills/ or documentation/');
    if (node.kind === 'folder' && area === 'rules') throw invalid('rules/ holds rules only: no folders');
    if (node.kind === 'doc' && area === 'skills' && !(await inSkill(ctx.db, dest))) throw invalid('Documents under skills/ live inside a skill folder');

    if (dest.id === node.id || dest.path.startsWith(node.path)) throw invalid('Cannot move a folder into itself');
    if (dest.id === node.parent_id) return { node: await nodeOut(az, node), moved: 0, access_changed: false, warning: null };

    const count = (await one<{ c: number }>(ctx.db, "SELECT COUNT(*) AS c FROM nodes WHERE path >= ? AND path < ?", ...subtree(node.path)))?.c ?? 0;
    if (count > LIMITS.moveNodes) throw invalid(`A move can include at most ${LIMITS.moveNodes} items`, { count });

    const newPath = dest.path + node.id + '/';
    const deepest = (await one<{ d: number }>(ctx.db, "SELECT MAX(length(path) - length(replace(path, '/', ''))) - 1 AS d FROM nodes WHERE path >= ? AND path < ? AND kind = 'folder'", ...subtree(node.path)))?.d ?? 0;
    if (deepest - depthOf(node.path) + depthOf(newPath) > LIMITS.folderDepth) throw invalid(`Folders can be at most ${LIMITS.folderDepth} levels deep`);

    const before = node.kind === 'folder' && node.inherit === 0 ? new Map<string, number>() : await inheritedGrants(az, sourceParent?.path ?? null);
    const after = node.kind === 'folder' && node.inherit === 0 ? new Map<string, number>() : await inheritedGrants(az, dest.path);
    const changed = !sameGrants(before, after);

    try {
      await ctx.db.batch([
        stmt(ctx.db, 'UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?', dest.id, Date.now(), node.id),
        stmt(ctx.db, "UPDATE nodes SET path = ? || substr(path, ?) WHERE path >= ? AND path < ?", newPath, node.path.length + 1, ...subtree(node.path)),
      ]);
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${node.name}" already exists in the destination`);
      throw e;
    }
    az.reset();
    ctx.audit.detail = { from: sourceParent?.id ?? null, to: dest.id, moved: count, access_changed: changed };
    const moved = (await getNodeById(ctx.db, node.id))!;
    return {
      node: await nodeOut(az, moved),
      moved: count,
      access_changed: changed,
      warning: changed ? 'Effective access for the moved items changed. Review sharing on the new location.' : null,
    };
  },
});

export const deleteNode = defineOp({
  name: 'delete_node',
  summary: 'Move a folder or document (and everything inside) to the trash.',
  scope: 'manage',
  target: { kind: 'node', field: 'node', minRole: ROLE.manager },
  input: z.object({ node: NodeRef }),
  output: z.object({ deleted: z.number() }),
  rest: { method: 'DELETE', path: '/nodes/{node}' },
  mcp: { tool: 'delete_node', destructive: true },
  handler: async (ctx) => {
    const node = ctx.node!;
    if (isAreaId(node.id)) throw invalid(AREA_FIXED);
    const now = Date.now();
    const deleted = (await one<{ c: number }>(ctx.db, 'SELECT COUNT(*) AS c FROM nodes WHERE path >= ? AND path < ? AND deleted_at IS NULL', ...subtree(node.path)))?.c ?? 0;
    await ctx.db.batch([
      stmt(ctx.db, "DELETE FROM skill_fts WHERE doc_id IN (SELECT id FROM nodes WHERE path >= ? AND path < ? AND kind = 'doc')", ...subtree(node.path)),
      stmt(ctx.db, "DELETE FROM doc_fts WHERE doc_id IN (SELECT id FROM nodes WHERE path >= ? AND path < ? AND kind = 'doc')", ...subtree(node.path)),
      stmt(ctx.db, "UPDATE nodes SET deleted_at = ?, deleted_by = ? WHERE path >= ? AND path < ? AND deleted_at IS NULL", now, ctx.actor.user.id, ...subtree(node.path)),
    ]);
    ctx.audit.detail = { name: node.name, deleted };
    return { deleted };
  },
});

export const restoreNode = defineOp({
  name: 'restore_node',
  summary: 'Restore a folder or document from the trash.',
  scope: 'manage',
  target: { kind: 'node', field: 'node', minRole: ROLE.manager, deleted: true },
  input: z.object({ node: NodeRef.describe('Id of the trashed node') }),
  output: NodeOut,
  rest: { method: 'POST', path: '/trash/{node}/restore' },
  mcp: { tool: 'restore_node' },
  handler: async (ctx) => {
    const node = ctx.node!;
    if (node.parent_id) {
      const parent = await getNodeById(ctx.db, node.parent_id);
      if (!parent) throw invalid('Restore the parent folder first');
    }
    const published = await all<NodeRow & { content: string }>(
      ctx.db,
      `SELECT n.*, v.content AS content FROM nodes n JOIN doc_versions v ON v.doc_id = n.id AND v.n = n.published_version
       WHERE n.path >= ? AND n.path < ? AND n.deleted_at = ? AND n.kind = 'doc'`,
      ...subtree(node.path),
      node.deleted_at,
    );
    try {
      await ctx.db.batch([
        stmt(ctx.db, "UPDATE nodes SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE path >= ? AND path < ? AND deleted_at = ?", Date.now(), ...subtree(node.path), node.deleted_at),
        ...published.flatMap((p) => ftsReplace(ctx.db, p, p.content)),
      ]);
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${node.name}" already exists in that folder. Rename it first.`);
      throw e;
    }
    ctx.audit.detail = { name: node.name };
    return nodeOut(ctx.az, (await getNodeById(ctx.db, node.id))!);
  },
});

export const listTrash = defineOp({
  name: 'list_trash',
  summary: 'List trashed items you manage, newest first.',
  scope: 'manage',
  target: { kind: 'user' },
  input: z.object({ limit: Limit }),
  output: z.object({
    items: z.array(z.object({ id: z.string(), kind: z.enum(['folder', 'doc']), name: z.string(), deleted_at: z.number(), deleted_by: z.string().nullable() })),
  }),
  rest: { method: 'GET', path: '/trash' },
  mcp: { tool: 'list_trash', readOnly: true },
  handler: async (ctx, input) => {
    const rows = await all<NodeRow>(
      ctx.db,
      `SELECT n.* FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
       WHERE n.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> n.deleted_at)
       ORDER BY n.deleted_at DESC LIMIT 500`,
    );
    const roles = await ctx.az.roles(rows);
    const items = rows
      .filter((n) => (roles.get(n.id) ?? 0) >= ROLE.manager)
      .slice(0, input.limit ?? 50)
      .map((n) => ({ id: n.id, kind: n.kind, name: n.name, deleted_at: n.deleted_at!, deleted_by: n.deleted_by }));
    return { items };
  },
});
