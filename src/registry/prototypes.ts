import { z } from 'zod';
import puppeteer from '@cloudflare/puppeteer';
import { one, stmt, type NodeRow } from '../db/d1';
import { DbTree } from '../db/tree';
import { AppError, conflict, invalid, notFound } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import { PROTO_INDEX, areaOfPath, formatOfName, isFileFormat } from '../lib/areas';
import { validateName } from '../lib/names';
import { sha256Hex, toBase64 } from '../lib/crypto';
import { ulid } from '../lib/ulid';
import { PREVIEW_TTL_S, RENDER_TTL_S, signPreview, type PreviewMode } from '../lib/preview';
import { ROLE } from '../authz/roles';
import type { Authz } from '../authz/authorize';
import { defineOp, type OpContext } from './types';
import { NodeOut, NodeRef, canonicalPaths, displayPaths, getNodeById, nodeOuts } from './shared';
import { SkillFileOut, folderMembers, type SkillFileOutT, type SkillMember } from './content';
import { checkPlacement, isUnique } from './nodes';
import { PublishFileResult, publishMembers } from './skills';

/**
 * Prototypes: folders under prototypes/ holding an index.html plus whatever it loads (css, js, json, svg, notes).
 * Every file is versioned like any document. A prototype is shown through short-lived signed preview links
 * (/p/<token>/...), served with a sandbox CSP so its scripts never run with the viewer's session, and can be
 * screenshotted in a cloud browser (Browser Run) for agents that have no browser of their own.
 */

const PROTO_TEMPLATE = (name: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name.replace(/[<>&"]/g, '')}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>${name.replace(/[<>&"]/g, '')}</h1>
    <p>Edit index.html, styles.css and app.js.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
const CSS_TEMPLATE = `body { font-family: system-ui, sans-serif; margin: 0; padding: 48px; color: #0f172a; }\nh1 { letter-spacing: -0.02em; }\n`;
const JS_TEMPLATE = `// Runs inside the prototype only.\n`;

/** The nearest prototype folder containing (or being) this node, or null. */
export async function protoOf(db: D1Database, node: NodeRow): Promise<NodeRow | null> {
  return (await new DbTree(db).protoOf(node)) as NodeRow | null;
}

async function requireProto(ctx: OpContext): Promise<NodeRow> {
  const p = await protoOf(ctx.db, ctx.node!);
  if (!p) throw invalid('Not a prototype: a prototype is a folder under prototypes/ with an index.html');
  return p;
}

/** Prototype members the caller can read, as file rows (organisational folders walked through, nested prototypes as one entry). */
async function protoFiles(az: Authz, folder: NodeRow): Promise<{ files: SkillFileOutT[]; members: SkillMember[] }> {
  const members = await folderMembers(az.db, folder, PROTO_INDEX);
  const via = [...new Set(members.flatMap((m) => m.via))];
  const viaRows = via.length ? await new DbTree(az.db).getMany(via) : new Map<string, NodeRow>();
  const roles = await az.roles([...members.map((m) => m.node), ...viaRows.values()]);
  const files: SkillFileOutT[] = [];
  for (const m of members) {
    const role = roles.get(m.node.id) ?? 0;
    if (role === 0 || m.via.some((id) => (roles.get(id) ?? 0) === 0)) continue;
    const n = m.node;
    files.push({
      id: n.id,
      path: m.rel,
      kind: m.sub ? 'skill' : isFileFormat(n.format) ? 'file' : 'markdown',
      format: n.kind === 'doc' ? n.format : null,
      published_version: n.kind === 'doc' ? n.published_version : null,
      head_version: n.kind === 'doc' && role >= ROLE.editor ? n.head_version : null,
    });
  }
  return { files, members };
}

const Mode = z.enum(['published', 'working']).describe('published: what viewers see. working: drafts and unpublished versions (editors).');

/** Mode the caller may use: viewers are always on published. */
function modeFor(role: number, asked: PreviewMode | undefined): PreviewMode {
  if (asked === 'working' && role < ROLE.editor) throw new AppError('forbidden', 'The working copy needs editor access');
  return asked ?? (role >= ROLE.editor ? 'working' : 'published');
}

async function previewUrl(ctx: OpContext, proto: NodeRow, mode: PreviewMode, path = ''): Promise<{ url: string; expires_at: number }> {
  const e = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S;
  const token = await signPreview(ctx.env.SESSION_SECRET, { t: 'p', id: proto.id, m: mode, u: ctx.actor.user.id, e });
  const rel = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return { url: `${ctx.env.BASE_URL.replace(/\/+$/, '')}/p/${token}/${rel}`, expires_at: e * 1000 };
}

export const createPrototype = defineOp({
  name: 'create_prototype',
  summary:
    'Create a prototype: a folder under prototypes/ with an index.html draft (plus styles.css and app.js unless bare). Add more files with create_doc, edit them with update_draft, then commit and publish_prototype.',
  scope: 'write',
  target: { kind: 'node', field: 'parent', minRole: ROLE.editor, nodeKind: 'folder' },
  input: z.object({
    parent: NodeRef.describe('prototypes/ or a folder in it'),
    name: z.string().min(1).max(LIMITS.nameChars).describe('Folder name, e.g. checkout-flow'),
    html: z.string().max(LIMITS.docBytes).optional().describe('Initial index.html. Default: a small page that loads styles.css and app.js'),
    bare: z.boolean().optional().describe('Only index.html, no styles.css or app.js'),
  }),
  output: z.object({ folder: NodeOut, files: z.array(NodeOut) }),
  rest: { method: 'POST', path: '/prototypes' },
  mcp: { tool: 'create_prototype' },
  handler: async (ctx, input) => {
    const parent = ctx.node!;
    if (areaOfPath(parent.path) !== 'prototypes') throw invalid('Prototypes live under prototypes/');
    if (await protoOf(ctx.db, parent)) throw invalid('This folder is already inside a prototype: add files to it with create_doc');
    const name = validateName(input.name);
    await checkPlacement(ctx.db, parent, 'folder', name);
    const folderId = ulid();
    const folderPath = parent.path + folderId + '/';
    if (folderPath.split('/').filter(Boolean).length > LIMITS.folderDepth) throw invalid(`Folders can be at most ${LIMITS.folderDepth} levels deep`);
    const now = Date.now();
    const uid = ctx.actor.user.id;
    const files: [string, string][] = [[PROTO_INDEX, input.html ?? PROTO_TEMPLATE(name)]];
    if (!input.bare && input.html === undefined) files.push(['styles.css', CSS_TEMPLATE], ['app.js', JS_TEMPLATE]);
    const stmts = [stmt(ctx.db, "INSERT INTO nodes (id, parent_id, kind, name, path, inherit, created_by, created_at, updated_at) VALUES (?,?, 'folder', ?,?,1,?,?,?)", folderId, parent.id, name, folderPath, uid, now, now)];
    const ids: string[] = [];
    for (const [fname, content] of files) {
      const id = ulid();
      ids.push(id);
      const format = formatOfName(fname);
      const etag = (await sha256Hex(`${content}:${now}:${crypto.randomUUID()}`)).slice(0, 20);
      stmts.push(
        stmt(ctx.db, "INSERT INTO nodes (id, parent_id, kind, name, path, inherit, format, created_by, created_at, updated_at) VALUES (?,?, 'doc', ?,?,1,?,?,?,?)", id, folderId, fname, folderPath + id + '/', format, uid, now, now),
        stmt(ctx.db, 'INSERT INTO drafts (doc_id, content, base_version, etag, updated_by, updated_at) VALUES (?,?,0,?,?,?)', id, content, etag, uid, now),
      );
    }
    try {
      await ctx.db.batch(stmts);
    } catch (e) {
      if (isUnique(e)) throw conflict(`"${name}" already exists here`);
      throw e;
    }
    ctx.audit.nodeId = folderId;
    ctx.audit.detail = { name, parent: parent.id };
    ctx.az.reset();
    const rows = [(await getNodeById(ctx.db, folderId))!, ...(await Promise.all(ids.map((id) => getNodeById(ctx.db, id)))).filter((x): x is NodeRow => !!x)];
    const [folder, ...docs] = await nodeOuts(ctx.az, rows);
    return { folder: folder!, files: docs };
  },
});

export const getPrototype = defineOp({
  name: 'get_prototype',
  summary:
    'Get a prototype (its folder, or any file in it): its files and a preview URL valid for one hour. Open the URL in your own browser to look at it and interact with it; edit files with update_draft and reload. Without a browser, use render_prototype.',
  scope: 'read',
  target: { kind: 'node', field: 'prototype', minRole: ROLE.viewer },
  input: z.object({ prototype: NodeRef.describe('The prototype folder or a file in it, e.g. prototypes/checkout-flow'), version: Mode.optional() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    canonical_path: z.string().nullable(),
    mode: Mode,
    preview_url: z.string().describe('Signed link to index.html, valid until expires_at. Treat it like a password: anyone with it can view.'),
    expires_at: z.number(),
    published: z.boolean().describe('index.html has a published version'),
    files: z.array(SkillFileOut).describe('Files inside the prototype, index.html first. kind "skill" marks a nested prototype.'),
  }),
  rest: { method: 'GET', path: '/prototypes/{prototype}' },
  mcp: { tool: 'get_prototype', readOnly: true },
  handler: async (ctx, input) => {
    const proto = await requireProto(ctx);
    const role = await ctx.az.role(proto);
    if (role === 0) throw notFound();
    const mode = modeFor(role, input.version);
    const { files } = await protoFiles(ctx.az, proto);
    const index = files.find((f) => f.path.toLowerCase() === PROTO_INDEX);
    const path = (await displayPaths(ctx.az, [proto])).get(proto.id)?.path ?? '/' + proto.name;
    const link = await previewUrl(ctx, proto, mode);
    ctx.audit.nodeId = proto.id;
    ctx.audit.detail = { mode };
    return {
      id: proto.id,
      name: proto.name,
      path,
      canonical_path: (await canonicalPaths(ctx.az, [proto])).get(proto.id) ?? null,
      mode,
      preview_url: link.url,
      expires_at: link.expires_at,
      published: !!index?.published_version,
      files,
    };
  },
});

export const publishPrototype = defineOp({
  name: 'publish_prototype',
  summary: 'Publish a whole prototype at once: the latest committed version of every changed file in it, atomically. Commit drafts first.',
  scope: 'publish',
  target: { kind: 'node', field: 'prototype', minRole: ROLE.publisher, nodeKind: 'folder' },
  input: z.object({ prototype: NodeRef.describe('The prototype folder') }),
  output: z.object({ prototype: z.string(), published: z.number(), files: z.array(PublishFileResult) }),
  rest: { method: 'POST', path: '/prototypes/{prototype}/publish' },
  mcp: { tool: 'publish_prototype' },
  handler: async (ctx) => {
    const folder = ctx.node!;
    const tree = new DbTree(ctx.db);
    if (!(await tree.protoSet([folder.id])).has(folder.id)) throw invalid('This folder is not a prototype (it has no index.html)');
    const r = await publishMembers(ctx, tree, folder, await folderMembers(ctx.db, folder, PROTO_INDEX));
    return { prototype: folder.id, published: r.published, files: r.files };
  },
});

const ConsoleLine = z.object({ level: z.string(), text: z.string() });

export const renderPrototype = defineOp({
  name: 'render_prototype',
  summary:
    'Screenshot a prototype in a cloud browser and return the image, plus console messages and page errors. For agents without a browser; with one, open get_prototype\'s preview_url instead (faster, interactive).',
  scope: 'read',
  target: { kind: 'node', field: 'prototype', minRole: ROLE.viewer },
  input: z.object({
    prototype: NodeRef.describe('The prototype folder or a file in it'),
    version: Mode.optional(),
    page: z.string().max(500).optional().describe('File to open inside the prototype, default index.html. May end with #fragment or ?query.'),
    width: z.number().int().min(320).max(2560).optional().describe('Viewport width in CSS pixels, default 1280 (phone: 390)'),
    height: z.number().int().min(320).max(2560).optional().describe('Viewport height, default 800 (phone: 844)'),
    full_page: z.boolean().optional().describe('Capture the whole scrollable page, up to 6000 px tall'),
    wait_ms: z.number().int().min(0).max(5000).optional().describe('Extra wait after load, for animations'),
    color_scheme: z.enum(['light', 'dark']).optional().describe('prefers-color-scheme, default light'),
  }),
  output: z.object({
    image_url: z.string().describe('PNG, valid for 24 hours'),
    expires_at: z.number(),
    width: z.number(),
    height: z.number(),
    mime: z.literal('image/png'),
    bytes: z.number(),
    console: z.array(ConsoleLine).describe('Up to 50 console messages'),
    errors: z.array(z.string()).describe('Uncaught errors and failed requests'),
    image_base64: z.string().nullable().describe('The PNG (up to 1 MB). MCP clients receive it as an image.'),
  }),
  rest: { method: 'POST', path: '/prototypes/{prototype}/render' },
  mcp: { tool: 'render_prototype', readOnly: true },
  handler: async (ctx, input) => {
    if (!ctx.env.BROWSER) throw invalid('Rendering is not configured on this hub (no Browser Run binding). Open the preview_url from get_prototype instead.');
    const proto = await requireProto(ctx);
    const role = await ctx.az.role(proto);
    if (role === 0) throw notFound();
    const mode = modeFor(role, input.version);
    const width = input.width ?? 1280;
    const height = input.height ?? 800;
    const target = (input.page ?? '').replace(/^\/+/, '');
    const [pathPart, suffix = ''] = target.split(/(?=[?#])/);
    const link = await previewUrl(ctx, proto, mode, pathPart ?? '');
    const token = link.url.split('/p/')[1]!.split('/')[0]!;
    const scrub = (s: string): string => s.split(token).join('<token>').slice(0, 500);

    const consoleLines: z.infer<typeof ConsoleLine>[] = [];
    const errors: string[] = [];
    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    try {
      browser = await puppeteer.launch(ctx.env.BROWSER);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', op: 'render_prototype', msg: 'browser launch failed', err: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
      throw new AppError('internal', 'Could not start the cloud browser. Try again later, or open the preview_url from get_prototype.');
    }
    let png: Uint8Array;
    let shotH = height;
    try {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      // Light unless asked: the cloud browser's own default should not decide what the agent sees.
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: input.color_scheme ?? 'light' }]);
      page.on('console', (m) => {
        if (consoleLines.length < 50) consoleLines.push({ level: m.type(), text: scrub(m.text()) });
      });
      page.on('pageerror', (e) => {
        if (errors.length < 50) errors.push(scrub(e instanceof Error ? e.message : String(e)));
      });
      page.on('requestfailed', (r) => {
        // The browser asks for /favicon.ico on its own: not the prototype's doing.
        if (new URL(r.url()).pathname === '/favicon.ico') return;
        if (errors.length < 50) errors.push(scrub(`Failed to load ${r.url()}: ${r.failure()?.errorText ?? 'error'}`));
      });
      const res = await page.goto(link.url + suffix, { waitUntil: 'networkidle0', timeout: 20_000 });
      if (res && !res.ok()) errors.push(`The page answered ${res.status()}`);
      if (input.wait_ms) await new Promise((r) => setTimeout(r, input.wait_ms));
      if (input.full_page) {
        // Runs in the page: a string so the worker's types do not need the DOM.
        const h = await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');
        shotH = Math.min(6000, Math.max(height, Math.ceil(Number(h) || height)));
        await page.setViewport({ width, height: shotH, deviceScaleFactor: 1 });
      }
      png = (await page.screenshot({ type: 'png' })) as Uint8Array;
    } finally {
      await browser.close().catch(() => undefined);
    }
    const id = ulid();
    await ctx.env.BUCKET.put(`renders/${id}.png`, png, { httpMetadata: { contentType: 'image/png' }, customMetadata: { proto: proto.id, mode } });
    const e = Math.floor(Date.now() / 1000) + RENDER_TTL_S;
    const rtoken = await signPreview(ctx.env.SESSION_SECRET, { t: 'r', id, u: ctx.actor.user.id, e });
    ctx.audit.nodeId = proto.id;
    ctx.audit.detail = { mode, width, height, render: id, errors: errors.length };
    return {
      image_url: `${ctx.env.BASE_URL.replace(/\/+$/, '')}/r/${rtoken}`,
      expires_at: e * 1000,
      width,
      height: shotH,
      mime: 'image/png' as const,
      bytes: png.length,
      console: consoleLines,
      errors,
      image_base64: png.length <= LIMITS.mcpImageBytes ? toBase64(png) : null,
    };
  },
});

/** The file at `rel` inside a prototype (organisational folders walked by name), or null. Never checks access. */
export async function protoFileAt(db: D1Database, proto: NodeRow, rel: string): Promise<NodeRow | null> {
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0 || rel.endsWith('/')) segs.push(PROTO_INDEX);
  const childNamed = (parentId: string, name: string): Promise<NodeRow | null> =>
    one<NodeRow>(db, 'SELECT * FROM nodes WHERE parent_id = ? AND lower(name) = ? AND deleted_at IS NULL LIMIT 1', parentId, name.toLowerCase());
  let cur: NodeRow | null = proto;
  for (const s of segs) {
    if (!cur || cur.kind !== 'folder') return null;
    cur = await childNamed(cur.id, s);
  }
  // A folder path opens its index.html.
  if (cur && cur.kind === 'folder') cur = await childNamed(cur.id, PROTO_INDEX);
  return cur && cur.kind === 'doc' ? cur : null;
}

