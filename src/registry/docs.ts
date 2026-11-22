import { z } from 'zod';
import { all, one, stmt, type NodeRow } from '../db/d1';
import { ftsReplace, isSkillDoc, skillFlag } from '../db/fts';
import { DbTree } from '../db/tree';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import { sha256Hex } from '../lib/crypto';
import { splitFrontmatter, validateFrontmatter } from '../lib/frontmatter';
import { assetIds } from '../lib/markdown';
import { unifiedDiff } from '../lib/diff';
import { SKILL_MD, isFileFormat } from '../lib/areas';
import { distinctLinks } from '../lib/links';
import { ROLE } from '../authz/roles';
import { defineOp, type OpContext } from './types';
import { Cursor, Limit, NodeRef, canonicalPaths, decodeCursor, displayPaths, encodeCursor, getNodeById } from './shared';
import { LinkOut, SkillFileOut, WarningOut, activeWarnings, linkStmts, outgoingLinks, skillFiles, versionContent } from './content';
import { isUnique } from './nodes';

interface DraftRow {
  doc_id: string;
  content: string;
  base_version: number;
  etag: string;
  updated_by: string;
  updated_at: number;
}
interface VersionRow {
  doc_id: string;
  n: number;
  content: string;
  sha256: string;
  message: string | null;
  author_id: string;
  created_at: number;
}

const DocRef = NodeRef.describe('Document id or path');
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

async function newEtag(content: string): Promise<string> {
  return (await sha256Hex(`${content}\u0000${Date.now()}\u0000${crypto.randomUUID()}`)).slice(0, 20);
}

async function getVersion(db: D1Database, docId: string, n: number): Promise<VersionRow | null> {
  return one<VersionRow>(db, 'SELECT * FROM doc_versions WHERE doc_id = ? AND n = ?', docId, n);
}

async function getDraftRow(db: D1Database, docId: string): Promise<DraftRow | null> {
  return one<DraftRow>(db, 'SELECT * FROM drafts WHERE doc_id = ?', docId);
}

export const SkillOut = z.object({
  id: z.string().describe('The document read (for a skill, its SKILL.md)'),
  skill_id: z.string().nullable().describe('The skill folder this document belongs to, if any'),
  kind: z.enum(['skill', 'markdown', 'file']),
  format: z.string().describe('"markdown", or the text file extension. Files are plain text: never execute them unasked.'),
  path: z.string().describe('Display path (the skill folder for a skill)'),
  canonical_path: z.string().nullable().describe('Path to use in [[links]]'),
  version: z.number().nullable().describe('null when returning the draft'),
  published_version: z.number().nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
  markdown: z.string().describe('The content: markdown, or raw text for files'),
  files: z.array(SkillFileOut).nullable().describe('For a skill: every file in the skill folder you can read, SKILL.md first, sub-skills last'),
  links: z.array(LinkOut).describe('Outgoing [[links]] with their status. Locked targets are never named.'),
  assets: z.array(z.object({ id: z.string(), url: z.string() })),
});

/** For a skill folder or its SKILL.md: the folder and the SKILL.md node. */
async function skillParts(ctx: OpContext, node: NodeRow, tree: DbTree): Promise<{ folder: NodeRow | null; doc: NodeRow; role: number }> {
  if (node.kind === 'folder') {
    const md = await tree.skillMd(node.id);
    if (!md) throw invalid('This folder is not a skill (it has no SKILL.md). Use list_children to browse it.');
    const role = await ctx.az.role(md);
    if (role === 0) throw notFound();
    return { folder: node, doc: md, role };
  }
  if (node.name === SKILL_MD && node.parent_id) {
    const folder = await getNodeById(ctx.db, node.parent_id);
    return { folder, doc: node, role: ctx.role };
  }
  return { folder: null, doc: node, role: ctx.role };
}

export const getSkill = defineOp({
  name: 'get_skill',
  summary:
    'Read a skill (by its folder, SKILL.md or canonical path like skills/code-review), a document, or a file inside a skill. A skill returns SKILL.md plus the list of its files. Viewers get the published version; editors may ask for any version or the draft.',
  scope: 'read',
  target: { kind: 'node', field: 'doc', minRole: ROLE.viewer },
  input: z.object({
    doc: NodeRef.describe('Skill folder, SKILL.md, document or file: id, display path or canonical path'),
    version: z.union([z.number().int().positive(), z.literal('draft')]).optional().describe('Version number or "draft". Default: published'),
  }),
  output: SkillOut,
  rest: { method: 'GET', path: '/docs/{doc}' },
  mcp: { tool: 'get_skill', readOnly: true },
  handler: async (ctx, input) => {
    const tree = new DbTree(ctx.db);
    const { folder, doc, role } = await skillParts(ctx, ctx.node!, tree);
    const editor = role >= ROLE.editor;
    let markdown: string;
    let version: number | null;
    if (input.version === 'draft') {
      if (!editor) throw new AppError('forbidden', 'Drafts need editor access');
      const d = await getDraftRow(ctx.db, doc.id);
      if (!d) throw notFound('No draft');
      markdown = d.content;
      version = null;
    } else {
      let n = input.version ?? doc.published_version ?? (editor ? doc.head_version : null);
      if (!editor && n !== doc.published_version) n = null;
      if (!n) throw notFound(editor ? 'No versions yet' : 'Not published');
      const v = await getVersion(ctx.db, doc.id, n);
      if (!v) throw notFound('Version not found');
      markdown = v.content;
      version = n;
    }
    ctx.audit.version = version;
    const shown = folder ?? doc;
    const path = (await displayPaths(ctx.az, [shown])).get(shown.id)?.path ?? '/' + shown.name;
    const file = isFileFormat(doc.format);
    let frontmatter: Record<string, unknown> | null = null;
    if (!file) {
      try {
        frontmatter = splitFrontmatter(markdown).frontmatter;
      } catch {
        frontmatter = null;
      }
    }
    let skillId = folder?.id ?? null;
    if (!skillId) {
      const chain = doc.path.split('/').filter(Boolean).slice(0, -1);
      const skills = await tree.skillSet(chain);
      skillId = [...chain].reverse().find((id) => skills.has(id)) ?? null;
    }
    // A read of a skill or any file in it counts for the skill. Drafts and old versions are authoring, not use.
    if (version !== null && version === doc.published_version) ctx.usage.load = skillId ?? doc.id;
    return {
      id: doc.id,
      skill_id: skillId,
      kind: folder ? ('skill' as const) : file ? ('file' as const) : ('markdown' as const),
      format: doc.format ?? 'markdown',
      path,
      canonical_path: (await canonicalPaths(ctx.az, [shown])).get(shown.id) ?? null,
      version,
      published_version: doc.published_version,
      frontmatter,
      markdown,
      files: folder ? await skillFiles(ctx.az, folder) : null,
      links: await outgoingLinks(ctx.az, tree, doc, distinctLinks(markdown)),
      assets: file ? [] : assetIds(markdown).map((id) => ({ id, url: `${ctx.env.BASE_URL}/a/${id}` })),
    };
  },
});

const DraftOut = z.object({
  draft: z
    .object({ content: z.string(), etag: z.string(), base_version: z.number(), updated_by: z.string(), updated_at: z.number() })
    .nullable(),
  head_version: z.number(),
});

export const getDraft = defineOp({
  name: 'get_draft',
  summary: 'Get the shared working draft of a document, with its etag.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef }),
  output: DraftOut,
  rest: { method: 'GET', path: '/docs/{doc}/draft' },
  mcp: { tool: 'get_draft', readOnly: true },
  handler: async (ctx) => {
    const d = await getDraftRow(ctx.db, ctx.node!.id);
    return {
      draft: d ? { content: d.content, etag: d.etag, base_version: d.base_version, updated_by: d.updated_by, updated_at: d.updated_at } : null,
      head_version: ctx.node!.head_version,
    };
  },
});

export const updateDraft = defineOp({
  name: 'update_draft',
  summary:
    'Create or replace the draft. Pass the etag you last saw; a stale etag returns conflict with the current draft. Returns authoring warnings: fix them, or tell the human why not, before committing.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({
    doc: DocRef,
    content: z.string(),
    etag: z.string().max(64).nullable().optional().describe('Etag of the draft you edited. Omit or null when no draft exists yet.'),
  }),
  output: z.object({ etag: z.string(), base_version: z.number(), updated_at: z.number(), warnings: z.array(WarningOut) }),
  rest: { method: 'PUT', path: '/docs/{doc}/draft' },
  mcp: { tool: 'update_draft' },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    if (byteLen(input.content) > LIMITS.docBytes) throw invalid('Document is larger than 256 KB');
    const etag = await newEtag(input.content);
    const now = Date.now();
    const current = await getDraftRow(ctx.db, doc.id);
    const stale = (d: DraftRow | null): AppError =>
      conflict('The draft changed since you loaded it', { etag: d?.etag ?? null, content: d?.content ?? null, updated_by: d?.updated_by ?? null });
    if (current) {
      if (!input.etag || input.etag !== current.etag) throw stale(current);
      const res = await stmt(
        ctx.db,
        'UPDATE drafts SET content = ?, etag = ?, updated_by = ?, updated_at = ? WHERE doc_id = ? AND etag = ?',
        input.content,
        etag,
        ctx.actor.user.id,
        now,
        doc.id,
        current.etag,
      ).run();
      if ((res.meta.changes ?? 0) !== 1) throw stale(await getDraftRow(ctx.db, doc.id));
    } else {
      if (input.etag) throw stale(null);
      const res = await stmt(
        ctx.db,
        'INSERT INTO drafts (doc_id, content, base_version, etag, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(doc_id) DO NOTHING',
        doc.id,
        input.content,
        doc.head_version,
        etag,
        ctx.actor.user.id,
        now,
      ).run();
      if ((res.meta.changes ?? 0) !== 1) throw stale(await getDraftRow(ctx.db, doc.id));
    }
    ctx.audit.detail = { bytes: byteLen(input.content) };
    const tree = new DbTree(ctx.db);
    await ctx.db.batch(await linkStmts(ctx.db, tree, doc, 'draft', input.content));
    return {
      etag,
      base_version: current?.base_version ?? doc.head_version,
      updated_at: now,
      warnings: await activeWarnings(ctx.az, tree, doc, input.content),
    };
  },
});

export const discardDraft = defineOp({
  name: 'discard_draft',
  summary: 'Throw away the current draft.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, etag: z.string().max(64).optional() }),
  output: z.object({ discarded: z.boolean() }),
  rest: { method: 'DELETE', path: '/docs/{doc}/draft' },
  mcp: { tool: 'discard_draft', destructive: true },
  handler: async (ctx, input) => {
    const res = input.etag
      ? await stmt(ctx.db, 'DELETE FROM drafts WHERE doc_id = ? AND etag = ?', ctx.node!.id, input.etag).run()
      : await stmt(ctx.db, 'DELETE FROM drafts WHERE doc_id = ?', ctx.node!.id).run();
    if (input.etag && (res.meta.changes ?? 0) === 0 && (await getDraftRow(ctx.db, ctx.node!.id))) throw conflict('The draft changed since you loaded it');
    const doc = ctx.node!;
    await ctx.db.batch(await linkStmts(ctx.db, new DbTree(ctx.db), doc, 'draft', await versionContent(ctx.db, doc.id, doc.head_version || null)));
    return { discarded: (res.meta.changes ?? 0) > 0 };
  },
});

export const commitVersion = defineOp({
  name: 'commit_version',
  summary: 'Turn the draft into the next immutable version. Markdown frontmatter is validated. Returns authoring warnings for the new version.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, message: z.string().max(500).optional(), etag: z.string().max(64).optional() }),
  output: z.object({ version: z.number(), sha256: z.string(), is_skill: z.boolean(), warnings: z.array(WarningOut) }),
  rest: { method: 'POST', path: '/docs/{doc}/versions' },
  mcp: { tool: 'commit_version' },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const draft = await getDraftRow(ctx.db, doc.id);
    if (!draft) throw invalid('Nothing to commit: there is no draft');
    if (input.etag && input.etag !== draft.etag) throw conflict('The draft changed since you loaded it', { etag: draft.etag });
    if (byteLen(draft.content) > LIMITS.docBytes) throw invalid('Document is larger than 256 KB');
    const meta = isFileFormat(doc.format) ? null : validateFrontmatter(draft.content);
    const n = doc.head_version + 1;
    const sha = await sha256Hex(draft.content);
    const now = Date.now();
    const tree = new DbTree(ctx.db);
    const links = await linkStmts(ctx.db, tree, doc, 'draft', draft.content);
    try {
      const res = await ctx.db.batch([
        stmt(ctx.db, 'INSERT INTO doc_versions (doc_id, n, content, sha256, message, author_id, created_at) VALUES (?,?,?,?,?,?,?)', doc.id, n, draft.content, sha, input.message ?? null, ctx.actor.user.id, now),
        stmt(ctx.db, 'UPDATE nodes SET head_version = ?, updated_at = ? WHERE id = ? AND head_version = ?', n, now, doc.id, doc.head_version),
        stmt(ctx.db, 'DELETE FROM drafts WHERE doc_id = ? AND etag = ?', doc.id, draft.etag),
        ...links,
      ]);
      if ((res[1]?.meta.changes ?? 0) !== 1) throw conflict('Another commit happened at the same time');
    } catch (e) {
      if (isUnique(e)) throw conflict('Another commit happened at the same time');
      throw e;
    }
    ctx.audit.version = n;
    ctx.audit.detail = { message: input.message ?? null };
    return {
      version: n,
      sha256: sha,
      is_skill: meta !== null && isSkillDoc(doc),
      warnings: await activeWarnings(ctx.az, tree, doc, draft.content),
    };
  },
});

export const listVersions = defineOp({
  name: 'list_versions',
  summary: 'List versions of a document, newest first.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, cursor: Cursor, limit: Limit }),
  output: z.object({
    items: z.array(
      z.object({ n: z.number(), message: z.string().nullable(), author_id: z.string(), author_name: z.string().nullable(), created_at: z.number(), sha256: z.string(), published: z.boolean() }),
    ),
    published_version: z.number().nullable(),
    head_version: z.number(),
    next_cursor: z.string().nullable(),
  }),
  rest: { method: 'GET', path: '/docs/{doc}/versions' },
  mcp: { tool: 'list_versions', readOnly: true },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const limit = input.limit ?? 50;
    const before = decodeCursor(input.cursor)?.[0];
    const rows = await all<{ n: number; message: string | null; author_id: string; author_name: string | null; created_at: number; sha256: string }>(
      ctx.db,
      `SELECT v.n, v.message, v.author_id, u.name AS author_name, v.created_at, v.sha256 FROM doc_versions v LEFT JOIN users u ON u.id = v.author_id
       WHERE v.doc_id = ? AND v.n < ? ORDER BY v.n DESC LIMIT ?`,
      doc.id,
      typeof before === 'number' ? before : Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({ ...r, published: r.n === doc.published_version })),
      published_version: doc.published_version,
      head_version: doc.head_version,
      next_cursor: rows.length > limit ? encodeCursor([page[page.length - 1]!.n]) : null,
    };
  },
});

export const getVersionOp = defineOp({
  name: 'get_version',
  summary: 'Get the full content of one version.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, version: z.number().int().positive() }),
  output: z.object({ n: z.number(), content: z.string(), message: z.string().nullable(), author_id: z.string(), created_at: z.number(), sha256: z.string() }),
  rest: { method: 'GET', path: '/docs/{doc}/versions/{version}' },
  mcp: { tool: 'get_version', readOnly: true },
  handler: async (ctx, input) => {
    const v = await getVersion(ctx.db, ctx.node!.id, input.version);
    if (!v) throw notFound('Version not found');
    ctx.audit.version = v.n;
    return { n: v.n, content: v.content, message: v.message, author_id: v.author_id, created_at: v.created_at, sha256: v.sha256 };
  },
});

const Side = z.union([z.number().int().positive(), z.enum(['draft', 'published', 'head'])]);

export const diffVersions = defineOp({
  name: 'diff_versions',
  summary: 'Unified diff between two versions. Each side is a number, "draft", "published" or "head".',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, from: Side.default('published'), to: Side.default('head') }),
  output: z.object({ from: z.string(), to: z.string(), patch: z.string(), added: z.number(), removed: z.number() }),
  rest: { method: 'GET', path: '/docs/{doc}/diff' },
  mcp: { tool: 'diff_versions', readOnly: true },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const load = async (side: z.infer<typeof Side>): Promise<{ label: string; text: string }> => {
      if (side === 'draft') {
        const d = await getDraftRow(ctx.db, doc.id);
        if (!d) throw notFound('No draft');
        return { label: 'draft', text: d.content };
      }
      const n = side === 'published' ? doc.published_version : side === 'head' ? doc.head_version : side;
      if (!n) return { label: side === 'published' ? 'unpublished' : 'empty', text: '' };
      const v = await getVersion(ctx.db, doc.id, n);
      if (!v) throw notFound(`Version ${n} not found`);
      return { label: `v${n}`, text: v.content };
    };
    const [a, b] = await Promise.all([load(input.from), load(input.to)]);
    const d = unifiedDiff(a.text, b.text, a.label, b.label);
    return { from: a.label, to: b.label, ...d };
  },
});

/** Statements that make version v the published version of doc: pointer, skill flag, search rows and published links. */
export async function publishStmts(db: D1Database, tree: DbTree, doc: NodeRow, v: { n: number; content: string }): Promise<D1PreparedStatement[]> {
  return [
    stmt(db, 'UPDATE nodes SET published_version = ?, is_skill = ?, updated_at = ? WHERE id = ?', v.n, skillFlag(doc, v.content), Date.now(), doc.id),
    ...ftsReplace(db, doc, v.content),
    ...(await linkStmts(db, tree, doc, 'published', v.content)),
  ];
}

export const publishVersion = defineOp({
  name: 'publish_version',
  summary: 'Make version n the published version of one document. Rolling back is publishing an older n. To publish a whole skill folder at once, use publish_skill.',
  scope: 'publish',
  target: { kind: 'node', field: 'doc', minRole: ROLE.publisher, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, version: z.number().int().positive() }),
  output: z.object({
    doc: z.string(),
    published_version: z.number(),
    previous_version: z.number().nullable(),
    is_skill: z.boolean(),
    warnings: z.array(WarningOut),
  }),
  rest: { method: 'POST', path: '/docs/{doc}/publish' },
  mcp: { tool: 'publish_version' },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const v = await getVersion(ctx.db, doc.id, input.version);
    if (!v) throw notFound('Version not found');
    const tree = new DbTree(ctx.db);
    await ctx.db.batch(await publishStmts(ctx.db, tree, doc, v));
    ctx.audit.version = v.n;
    ctx.audit.detail = { previous: doc.published_version };
    ctx.az.reset();
    return {
      doc: doc.id,
      published_version: v.n,
      previous_version: doc.published_version,
      is_skill: skillFlag(doc, v.content) === 1,
      warnings: await activeWarnings(ctx.az, tree, { ...doc, published_version: v.n }, v.content),
    };
  },
});

export const unpublish = defineOp({
  name: 'unpublish',
  summary: 'Remove the published pointer. Viewers lose access to the content.',
  scope: 'publish',
  target: { kind: 'node', field: 'doc', minRole: ROLE.publisher, nodeKind: 'doc' },
  input: z.object({ doc: DocRef }),
  output: z.object({ doc: z.string(), previous_version: z.number().nullable() }),
  rest: { method: 'POST', path: '/docs/{doc}/unpublish' },
  mcp: { tool: 'unpublish', destructive: true },
  handler: async (ctx) => {
    const doc = ctx.node!;
    await ctx.db.batch([
      stmt(ctx.db, 'UPDATE nodes SET published_version = NULL, is_skill = 0, updated_at = ? WHERE id = ?', Date.now(), doc.id),
      ...ftsReplace(ctx.db, doc, null),
      stmt(ctx.db, "DELETE FROM links WHERE from_node = ? AND kind = 'published'", doc.id),
    ]);
    ctx.audit.detail = { previous: doc.published_version };
    ctx.az.reset();
    return { doc: doc.id, previous_version: doc.published_version };
  },
});
