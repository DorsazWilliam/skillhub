import { z } from 'zod';
import { all, one, stmt, type NodeRow } from '../db/d1';
import { ftsReplace } from '../db/fts';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import { sha256Hex } from '../lib/crypto';
import { skillMeta, splitFrontmatter, validateFrontmatter } from '../lib/frontmatter';
import { assetIds, relativeLinks, resolveRelative } from '../lib/markdown';
import { unifiedDiff } from '../lib/diff';
import { ROLE } from '../authz/roles';
import type { Authz } from '../authz/authorize';
import { defineOp } from './types';
import { Cursor, Limit, NodeRef, decodeCursor, displayPaths, encodeCursor, resolveRef } from './shared';
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

/** Resolves relative document links to node ids the caller can read. */
async function resolveLinks(az: Authz, doc: NodeRow, markdown: string): Promise<{ href: string; id: string | null; path: string | null }[]> {
  const hrefs = relativeLinks(markdown).slice(0, 50);
  if (hrefs.length === 0) return [];
  const docPath = (await displayPaths(az, [doc])).get(doc.id)?.path ?? '/' + doc.name;
  const folderSegs = docPath.split('/').filter(Boolean).slice(0, -1);
  const out: { href: string; id: string | null; path: string | null }[] = [];
  for (const href of hrefs) {
    const segs = resolveRelative(folderSegs, href);
    let target: NodeRow | null = null;
    if (segs && segs.length) target = await resolveRef(az, '/' + segs.map(encodeURIComponent).join('/'));
    if (target && (await az.role(target)) > 0) out.push({ href, id: target.id, path: '/' + segs!.join('/') });
    else out.push({ href, id: null, path: null });
  }
  return out;
}

export const SkillOut = z.object({
  id: z.string(),
  path: z.string(),
  version: z.number().nullable().describe('null when returning the draft'),
  published_version: z.number().nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
  markdown: z.string(),
  links: z.array(z.object({ href: z.string(), id: z.string().nullable(), path: z.string().nullable() })),
  assets: z.array(z.object({ id: z.string(), url: z.string() })),
});

export const getSkill = defineOp({
  name: 'get_skill',
  summary: 'Read a document or skill. Viewers get the published version. Editors may ask for any version or the draft.',
  scope: 'read',
  target: { kind: 'node', field: 'doc', minRole: ROLE.viewer, nodeKind: 'doc' },
  input: z.object({
    doc: DocRef,
    version: z.union([z.number().int().positive(), z.literal('draft')]).optional().describe('Version number or "draft". Default: published'),
  }),
  output: SkillOut,
  rest: { method: 'GET', path: '/docs/{doc}' },
  mcp: { tool: 'get_skill', readOnly: true },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const editor = ctx.role >= ROLE.editor;
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
    const path = (await displayPaths(ctx.az, [doc])).get(doc.id)?.path ?? '/' + doc.name;
    let frontmatter: Record<string, unknown> | null = null;
    try {
      frontmatter = splitFrontmatter(markdown).frontmatter;
    } catch {
      frontmatter = null;
    }
    return {
      id: doc.id,
      path,
      version,
      published_version: doc.published_version,
      frontmatter,
      markdown,
      links: await resolveLinks(ctx.az, doc, markdown),
      assets: assetIds(markdown).map((id) => ({ id, url: `${ctx.env.BASE_URL}/a/${id}` })),
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
  summary: 'Create or replace the draft. Pass the etag you last saw; a stale etag returns conflict with the current draft.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({
    doc: DocRef,
    content: z.string(),
    etag: z.string().max(64).nullable().optional().describe('Etag of the draft you edited. Omit or null when no draft exists yet.'),
  }),
  output: z.object({ etag: z.string(), base_version: z.number(), updated_at: z.number() }),
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
    return { etag, base_version: current?.base_version ?? doc.head_version, updated_at: now };
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
    return { discarded: (res.meta.changes ?? 0) > 0 };
  },
});

export const commitVersion = defineOp({
  name: 'commit_version',
  summary: 'Turn the draft into the next immutable version. Frontmatter is validated.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, message: z.string().max(500).optional(), etag: z.string().max(64).optional() }),
  output: z.object({ version: z.number(), sha256: z.string(), is_skill: z.boolean() }),
  rest: { method: 'POST', path: '/docs/{doc}/versions' },
  mcp: { tool: 'commit_version' },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const draft = await getDraftRow(ctx.db, doc.id);
    if (!draft) throw invalid('Nothing to commit: there is no draft');
    if (input.etag && input.etag !== draft.etag) throw conflict('The draft changed since you loaded it', { etag: draft.etag });
    if (byteLen(draft.content) > LIMITS.docBytes) throw invalid('Document is larger than 256 KB');
    const meta = validateFrontmatter(draft.content);
    const n = doc.head_version + 1;
    const sha = await sha256Hex(draft.content);
    const now = Date.now();
    try {
      const res = await ctx.db.batch([
        stmt(ctx.db, 'INSERT INTO doc_versions (doc_id, n, content, sha256, message, author_id, created_at) VALUES (?,?,?,?,?,?,?)', doc.id, n, draft.content, sha, input.message ?? null, ctx.actor.user.id, now),
        stmt(ctx.db, 'UPDATE nodes SET head_version = ?, updated_at = ? WHERE id = ? AND head_version = ?', n, now, doc.id, doc.head_version),
        stmt(ctx.db, 'DELETE FROM drafts WHERE doc_id = ? AND etag = ?', doc.id, draft.etag),
      ]);
      if ((res[1]?.meta.changes ?? 0) !== 1) throw conflict('Another commit happened at the same time');
    } catch (e) {
      if (isUnique(e)) throw conflict('Another commit happened at the same time');
      throw e;
    }
    ctx.audit.version = n;
    ctx.audit.detail = { message: input.message ?? null };
    return { version: n, sha256: sha, is_skill: meta !== null };
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

export const publishVersion = defineOp({
  name: 'publish_version',
  summary: 'Make version n the published version of a document. Rolling back is publishing an older n.',
  scope: 'publish',
  target: { kind: 'node', field: 'doc', minRole: ROLE.publisher, nodeKind: 'doc' },
  input: z.object({ doc: DocRef, version: z.number().int().positive() }),
  output: z.object({ doc: z.string(), published_version: z.number(), previous_version: z.number().nullable(), is_skill: z.boolean() }),
  rest: { method: 'POST', path: '/docs/{doc}/publish' },
  mcp: { tool: 'publish_version' },
  handler: async (ctx, input) => {
    const doc = ctx.node!;
    const v = await getVersion(ctx.db, doc.id, input.version);
    if (!v) throw notFound('Version not found');
    const meta = skillMeta(v.content);
    await ctx.db.batch([
      stmt(ctx.db, 'UPDATE nodes SET published_version = ?, is_skill = ?, updated_at = ? WHERE id = ?', v.n, meta ? 1 : 0, Date.now(), doc.id),
      ...ftsReplace(ctx.db, doc.id, v.content),
    ]);
    ctx.audit.version = v.n;
    ctx.audit.detail = { previous: doc.published_version };
    return { doc: doc.id, published_version: v.n, previous_version: doc.published_version, is_skill: meta !== null };
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
      ...ftsReplace(ctx.db, doc.id, null),
    ]);
    ctx.audit.detail = { previous: doc.published_version };
    return { doc: doc.id, previous_version: doc.published_version };
  },
});
