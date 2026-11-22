import { z } from 'zod';
import { all, chainIds, qs, type NodeRow } from '../db/d1';
import { DbTree, MemTree } from '../db/tree';
import { ROLE } from '../authz/roles';
import { SKILL_MD, areaOfPath, isFileFormat, type Area } from '../lib/areas';
import { canonFromChain, linkAllowed, pathKeys, place, resolvePath, type RawLink } from '../lib/links';
import { defineOp } from './types';
import { AreaEnum, NodeRef, canonicalPaths, chainInfo, canonicalOf, getNodesByIds } from './shared';
import { LinkOut, outgoingLinks } from './content';

interface LinkRow {
  from_node: string;
  kind: 'published' | 'draft';
  ord: number;
  to_path: string;
  label: string | null;
}

const BacklinkOut = z.object({
  id: z.string().describe('The linking document'),
  skill_id: z.string().nullable().describe('Its skill folder, when the linking document is a SKILL.md'),
  canonical_path: z.string().nullable(),
  area: AreaEnum.nullable(),
  status: z.enum(['ok', 'wrong_direction']),
});

/** Names along the chain, no access check: used only to build lookup keys, never returned. */
async function lookupKeys(tree: DbTree, nodes: NodeRow[]): Promise<string[]> {
  const ids = [...new Set(nodes.flatMap((n) => chainIds(n.path)))];
  const byId = await tree.getMany(ids);
  const skills = await tree.skillSet(ids);
  const paths: string[] = [];
  for (const n of nodes) {
    const chain = chainIds(n.path).map((id) => byId.get(id));
    if (chain.some((c) => !c)) continue;
    const full = chain as NodeRow[];
    paths.push(full.map((c) => c.name).join('/'), canonFromChain(full, skills).path);
  }
  return pathKeys(paths);
}

export const getLinks = defineOp({
  name: 'get_links',
  summary:
    'Outgoing [[links]] of a document or skill with their status (ok, wrong_direction, broken, locked), and the readable documents that link to it. Locked targets are never named.',
  scope: 'read',
  target: { kind: 'node', field: 'node', minRole: ROLE.viewer },
  input: z.object({
    node: NodeRef,
    version: z.enum(['published', 'draft']).optional().describe('Which links to read. Editors default to the working copy (draft or latest version), viewers always get published.'),
  }),
  output: z.object({ node: z.string(), outgoing: z.array(LinkOut), backlinks: z.array(BacklinkOut) }),
  rest: { method: 'GET', path: '/nodes/{node}/links' },
  mcp: { tool: 'get_links', readOnly: true },
  handler: async (ctx, input) => {
    const node = ctx.node!;
    const tree = new DbTree(ctx.db);
    // A skill is its folder: outgoing links come from SKILL.md, backlinks may point at the folder or at SKILL.md.
    let src: NodeRow | null = node.kind === 'doc' ? node : null;
    const targets: NodeRow[] = [node];
    if (node.kind === 'folder') {
      const md = await tree.skillMd(node.id);
      if (md && (await ctx.az.role(md)) > 0) {
        src = md;
        targets.push(md);
      }
    } else if (node.name === SKILL_MD && node.parent_id) {
      const folder = await tree.get(node.parent_id);
      if (folder) targets.push(folder as NodeRow);
    }

    let outgoing: z.infer<typeof LinkOut>[] = [];
    if (src && !isFileFormat(src.format)) {
      const role = await ctx.az.role(src);
      const kind = role >= ROLE.editor && input.version !== 'published' ? 'draft' : 'published';
      const rows = await all<LinkRow>(ctx.db, 'SELECT * FROM links WHERE from_node = ? AND kind = ? ORDER BY ord', src.id, kind);
      const raw: RawLink[] = rows.map((r) => ({ path: r.to_path, label: r.label }));
      outgoing = await outgoingLinks(ctx.az, tree, src, raw);
    }

    const targetIds = new Set(targets.map((t) => t.id));
    const found = await lookupKeys(tree, targets);
    const keys = found.length ? found : [''];
    const ids = [...targetIds];
    const rows = await all<LinkRow & { to_node: string | null }>(
      ctx.db,
      `SELECT * FROM links WHERE lower(to_path) IN (${qs(keys.length)}) OR to_node IN (${qs(ids.length)}) LIMIT 2000`,
      ...keys,
      ...ids,
    );
    const sources = (await getNodesByIds(ctx.db, [...new Set(rows.map((r) => r.from_node))])).filter((n) => n.deleted_at === null);
    const roles = await ctx.az.roles(sources);
    const skills = await tree.chainSkills(sources);
    const tgtPlaced = place(node, new Set());
    const backSources: NodeRow[] = [];
    const status = new Map<string, 'ok' | 'wrong_direction'>();
    for (const s of sources) {
      const role = roles.get(s.id) ?? 0;
      if (role === 0 || targetIds.has(s.id)) continue;
      const want = role >= ROLE.editor ? 'draft' : 'published';
      for (const r of rows.filter((x) => x.from_node === s.id && x.kind === want)) {
        const t = await resolvePath(tree, r.to_path);
        if (!t || !targetIds.has(t.id)) continue;
        backSources.push(s);
        status.set(s.id, linkAllowed(place(s, skills), tgtPlaced) ? 'ok' : 'wrong_direction');
        break;
      }
    }
    const shownOf = new Map<string, NodeRow>();
    const parentIds = backSources.filter((s) => s.name === SKILL_MD && s.parent_id).map((s) => s.parent_id!);
    const parents = new Map((await getNodesByIds(ctx.db, parentIds)).map((p) => [p.id, p]));
    for (const s of backSources) shownOf.set(s.id, s.name === SKILL_MD && s.parent_id && parents.has(s.parent_id) ? parents.get(s.parent_id)! : s);
    const canon = await canonicalPaths(ctx.az, [...shownOf.values()]);
    const backlinks = backSources.map((s) => {
      const shown = shownOf.get(s.id)!;
      return {
        id: s.id,
        skill_id: shown.id !== s.id ? shown.id : null,
        canonical_path: canon.get(shown.id) ?? null,
        area: areaOfPath(s.path),
        status: status.get(s.id)!,
      };
    });
    return { node: node.id, outgoing, backlinks };
  },
});

const GraphNode = z.object({
  id: z.string().describe('A skill folder, a prototype folder, or a document outside them. Files inside a skill or prototype collapse into it.'),
  open_id: z.string().describe('The node to open: SKILL.md for a skill, the folder for a prototype'),
  kind: z.enum(['skill', 'doc', 'prototype']),
  label: z.string(),
  area: AreaEnum,
  canonical_path: z.string().nullable(),
  published: z.boolean(),
});
const GraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  status: z.enum(['ok', 'wrong_direction']),
  contains: z.boolean().describe('true for a skill and its sub-skill'),
});

export const getGraph = defineOp({
  name: 'get_graph',
  summary: 'The link graph of everything you can read: skills and documents as nodes, [[links]] as edges. Optionally one area.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ area: AreaEnum.optional() }),
  output: z.object({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) }),
  rest: { method: 'GET', path: '/graph' },
  mcp: { tool: 'get_graph', readOnly: true },
  handler: async (ctx, input) => {
    const tree = await MemTree.load(ctx.db);
    const all_ = [...tree.byId.values()];
    const roles = await ctx.az.roles(all_);
    const readable = (n: NodeRow | undefined | null): n is NodeRow => !!n && (roles.get(n.id) ?? 0) > 0;

    // gkey: every file inside a skill collapses into the nearest skill folder.
    const skillOf = (n: NodeRow): NodeRow | null => {
      const chain = chainIds(n.path);
      const folders = n.kind === 'doc' ? chain.slice(0, -1) : chain;
      for (let i = folders.length - 1; i >= 0; i--) if (tree.skillFolders.has(folders[i]!)) return tree.byId.get(folders[i]!) ?? null;
      return null;
    };
    const protoOf = (n: NodeRow): NodeRow | null => {
      const chain = chainIds(n.path);
      const folders = n.kind === 'doc' ? chain.slice(0, -1) : chain;
      for (let i = folders.length - 1; i >= 0; i--) if (tree.protoFolders.has(folders[i]!)) return tree.byId.get(folders[i]!) ?? null;
      return null;
    };
    const keyOf = (n: NodeRow): NodeRow => (n.kind === 'folder' ? n : (skillOf(n) ?? protoOf(n) ?? n));
    const inArea = (n: NodeRow): boolean => !input.area || areaOfPath(n.path) === (input.area as Area);

    const nodes = new Map<string, NodeRow>();
    const add = (n: NodeRow): NodeRow | null => {
      const k = keyOf(n);
      if (!readable(k) || !inArea(k)) return null;
      nodes.set(k.id, k);
      return k;
    };

    const docs = all_.filter((d) => d.kind === 'doc' && readable(d) && !isFileFormat(d.format));
    const docIds = docs.map((d) => d.id);
    const linkRows: LinkRow[] = [];
    for (let i = 0; i < docIds.length; i += 90) {
      const part = docIds.slice(i, i + 90);
      linkRows.push(...(await all<LinkRow>(ctx.db, `SELECT from_node, kind, ord, to_path, label FROM links WHERE from_node IN (${qs(part.length)})`, ...part)));
    }
    const byFrom = new Map<string, LinkRow[]>();
    for (const r of linkRows) byFrom.set(r.from_node, [...(byFrom.get(r.from_node) ?? []), r]);

    const edges = new Map<string, z.infer<typeof GraphEdge>>();
    for (const d of docs) {
      const s = add(d);
      if (!s) continue;
      const want = (roles.get(d.id) ?? 0) >= ROLE.editor ? 'draft' : 'published';
      const srcPlaced = place(d, tree.skillFolders);
      for (const r of byFrom.get(d.id) ?? []) {
        if (r.kind !== want) continue;
        const t = (await resolvePath(tree, r.to_path)) as NodeRow | null;
        if (!readable(t)) continue;
        if (t.kind === 'folder' && !tree.skillFolders.has(t.id) && !tree.protoFolders.has(t.id)) continue;
        const tn = add(t);
        if (!tn || tn.id === s.id) continue;
        const key = s.id + '>' + tn.id;
        if (!edges.has(key)) edges.set(key, { from: s.id, to: tn.id, status: linkAllowed(srcPlaced, place(t, new Set())) ? 'ok' : 'wrong_direction', contains: false });
      }
    }
    // Every readable prototype is a node, even with no markdown inside it (its html, css and js files have no links).
    for (const id of tree.protoFolders) {
      const n = tree.byId.get(id);
      if (n) add(n);
    }
    // A skill and its sub-skills.
    for (const n of [...nodes.values()]) {
      if (n.kind !== 'folder') continue;
      const chain = chainIds(n.path).slice(0, -1);
      let parent: string | null = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (tree.skillFolders.has(chain[i]!)) {
          parent = chain[i]!;
          break;
        }
      }
      if (!parent || !nodes.has(parent)) continue;
      const key = parent + '>' + n.id;
      edges.set(key, { from: parent, to: n.id, status: 'ok', contains: true });
    }

    const list = [...nodes.values()];
    const info = await chainInfo(ctx.az, list);
    const mdOf = new Map<string, NodeRow>();
    for (const n of all_) if (n.kind === 'doc' && n.name === SKILL_MD && n.parent_id) mdOf.set(n.parent_id, n);
    return {
      nodes: list.map((n) => {
        const md = n.kind === 'folder' ? mdOf.get(n.id) : undefined;
        return {
          id: n.id,
          open_id: md?.id ?? n.id,
          kind: n.kind === 'doc' ? ('doc' as const) : tree.protoFolders.has(n.id) ? ('prototype' as const) : ('skill' as const),
          label: n.name,
          area: areaOfPath(n.path) ?? 'documentation',
          canonical_path: canonicalOf(info, n, roles.get(n.id) ?? 0),
          published: tree.protoFolders.has(n.id) ? (tree.kids.get(n.id) ?? []).some((k) => k.name.toLowerCase() === 'index.html' && k.published_version !== null) : (md ?? n).published_version !== null,
        };
      }),
      edges: [...edges.values()],
    };
  },
});

