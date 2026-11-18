import { z } from 'zod';
import { one, stmt } from '../db/d1';
import { AppError, invalid, notFound } from '../lib/errors';
import { LIMITS } from '../lib/limits';
import { fromBase64, sha256Hex, toBase64 } from '../lib/crypto';
import { sniffImage } from '../lib/sniff';
import { ulid } from '../lib/ulid';
import { ROLE } from '../authz/roles';
import { defineOp } from './types';
import { NodeRef, getNodeById } from './shared';

export interface AssetRow {
  id: string;
  doc_id: string | null;
  r2_key: string;
  sha256: string;
  mime: string;
  bytes: number;
  uploaded_by: string;
  created_at: number;
  deleted_at: number | null;
}

export const uploadAsset = defineOp({
  name: 'upload_asset',
  summary: 'Upload an image (png, jpeg, webp, gif) for a document. Returns the markdown to insert. SVG is rejected.',
  scope: 'write',
  target: { kind: 'node', field: 'doc', minRole: ROLE.editor, nodeKind: 'doc' },
  input: z.object({
    doc: NodeRef,
    data_base64: z.string().min(1).describe('Image bytes, base64. MCP uploads are capped at 1 MB, REST multipart at 5 MB.'),
    alt: z.string().max(200).optional(),
  }),
  output: z.object({ id: z.string(), mime: z.string(), bytes: z.number(), url: z.string(), markdown: z.string() }),
  rest: { method: 'POST', path: '/docs/{doc}/assets', multipart: true },
  mcp: { tool: 'upload_asset' },
  handler: async (ctx, input) => {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(input.data_base64.replace(/^data:[^,]*,/, ''));
    } catch {
      throw invalid('data_base64 is not valid base64');
    }
    const cap = ctx.actor.via === 'mcp' ? LIMITS.mcpImageBytes : LIMITS.imageBytes;
    if (bytes.length > cap) throw invalid(`Image is larger than ${Math.round(cap / 1024 / 1024)} MB`);
    const mime = sniffImage(bytes);
    if (!mime) throw invalid('Only png, jpeg, webp and gif images are allowed');
    const id = ulid();
    const key = `assets/${id}`;
    const sha = await sha256Hex(bytes);
    await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    await stmt(
      ctx.db,
      'INSERT INTO assets (id, doc_id, r2_key, sha256, mime, bytes, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      ctx.node!.id,
      key,
      sha,
      mime,
      bytes.length,
      ctx.actor.user.id,
      Date.now(),
    ).run();
    ctx.audit.detail = { asset: id, mime, bytes: bytes.length };
    const alt = (input.alt ?? '').replace(/[[\]]/g, '');
    return { id, mime, bytes: bytes.length, url: `${ctx.env.BASE_URL}/a/${id}`, markdown: `![${alt}](asset://${id})` };
  },
});

export const getAsset = defineOp({
  name: 'get_asset',
  summary: 'Get an image attached to a document. Viewers can only fetch images used by the published version.',
  scope: 'read',
  target: { kind: 'user' },
  input: z.object({ id: z.string().min(1).max(64), include_data: z.boolean().default(true).describe('Return base64 bytes (images up to 1 MB)') }),
  output: z.object({
    id: z.string(),
    doc: z.string(),
    mime: z.string(),
    bytes: z.number(),
    url: z.string(),
    r2_key: z.string().optional(),
    data_base64: z.string().nullable(),
  }),
  rest: { method: 'GET', path: '/assets/{id}' },
  mcp: { tool: 'get_asset', readOnly: true },
  handler: async (ctx, input) => {
    const asset = await one<AssetRow>(ctx.db, 'SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL', input.id);
    if (!asset || !asset.doc_id) throw notFound();
    const doc = await getNodeById(ctx.db, asset.doc_id);
    if (!doc) throw notFound();
    ctx.audit.nodeId = doc.id;
    const role = await ctx.az.authorize({ scope: 'read', kind: 'node', minRole: ROLE.viewer }, { node: doc });
    if (role < ROLE.editor) {
      // Viewers only see what the published version references.
      if (!doc.published_version) throw notFound();
      const pub = await one<{ hit: number }>(
        ctx.db,
        "SELECT instr(content, ?) AS hit FROM doc_versions WHERE doc_id = ? AND n = ?",
        `asset://${asset.id}`,
        doc.id,
        doc.published_version,
      );
      if (!pub || !pub.hit) throw notFound();
    }
    let data: string | null = null;
    if (input.include_data) {
      if (asset.bytes > LIMITS.mcpImageBytes) data = null;
      else {
        const obj = await ctx.env.BUCKET.get(asset.r2_key);
        if (!obj) throw new AppError('not_found', 'Asset content missing');
        data = toBase64(new Uint8Array(await obj.arrayBuffer()));
      }
    }
    return {
      id: asset.id,
      doc: doc.id,
      mime: asset.mime,
      bytes: asset.bytes,
      url: `${ctx.env.BASE_URL}/a/${asset.id}`,
      r2_key: input.include_data ? undefined : asset.r2_key,
      data_base64: data,
    };
  },
});
