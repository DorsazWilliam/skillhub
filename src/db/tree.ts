import { AREA_IDS, PROTO_INDEX, SKILL_MD } from '../lib/areas';
import { chainOf, type TNode, type TreeSource } from '../lib/links';
import { all, one, qs, type NodeRow } from './d1';

const CHUNK = 90;

function subtreeBounds(p: string): [string, string] {
  return [p, p.slice(0, -1) + '0'];
}

function childNames(seg: string): string[] {
  const s = seg.toLowerCase();
  return [...new Set([s, s + '.md', s.endsWith('.md') ? s.slice(0, -3) : s])];
}

/** Tree lookups against D1, memoized for one request. Never checks access. */
export class DbTree implements TreeSource {
  private nodes = new Map<string, NodeRow | null>();
  private skills = new Map<string, boolean>();
  private protos = new Map<string, boolean>();
  private children = new Map<string, NodeRow | null>();
  private found = new Map<string, NodeRow | null>();

  constructor(readonly db: D1Database) {}

  async get(id: string): Promise<NodeRow | null> {
    if (!this.nodes.has(id)) this.nodes.set(id, await one<NodeRow>(this.db, 'SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL', id));
    return this.nodes.get(id) ?? null;
  }

  async getMany(ids: string[]): Promise<Map<string, NodeRow>> {
    const missing = [...new Set(ids)].filter((id) => !this.nodes.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const part = missing.slice(i, i + CHUNK);
      const rows = await all<NodeRow>(this.db, `SELECT * FROM nodes WHERE id IN (${qs(part.length)}) AND deleted_at IS NULL`, ...part);
      const got = new Map(rows.map((r) => [r.id, r]));
      for (const id of part) this.nodes.set(id, got.get(id) ?? null);
    }
    const out = new Map<string, NodeRow>();
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) out.set(id, n);
    }
    return out;
  }

  async child(parentId: string, seg: string): Promise<NodeRow | null> {
    const key = parentId + '/' + seg.toLowerCase();
    if (!this.children.has(key)) {
      const names = childNames(seg);
      const row = await one<NodeRow>(
        this.db,
        `SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL AND lower(name) IN (${qs(names.length)}) ORDER BY lower(name) = ? DESC LIMIT 1`,
        parentId,
        ...names,
        seg.toLowerCase(),
      );
      this.children.set(key, row);
      if (row) this.nodes.set(row.id, row);
    }
    return this.children.get(key) ?? null;
  }

  async findSkill(name: string): Promise<NodeRow | null> {
    const key = name.toLowerCase();
    if (!this.found.has(key)) {
      const [lo, hi] = subtreeBounds(`/${AREA_IDS.skills}/`);
      const row = await one<NodeRow>(
        this.db,
        `SELECT f.* FROM nodes f WHERE f.kind = 'folder' AND f.deleted_at IS NULL AND lower(f.name) = ? AND f.path >= ? AND f.path < ?
         AND EXISTS (SELECT 1 FROM nodes s WHERE s.parent_id = f.id AND s.name = ? AND s.deleted_at IS NULL)
         ORDER BY length(f.path), f.id LIMIT 1`,
        key,
        lo,
        hi,
        SKILL_MD,
      );
      this.found.set(key, row);
    }
    return this.found.get(key) ?? null;
  }

  async skillSet(folderIds: string[]): Promise<Set<string>> {
    const missing = [...new Set(folderIds)].filter((id) => !this.skills.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const part = missing.slice(i, i + CHUNK);
      const rows = await all<{ parent_id: string }>(
        this.db,
        `SELECT parent_id FROM nodes WHERE parent_id IN (${qs(part.length)}) AND name = ? AND kind = 'doc' AND deleted_at IS NULL`,
        ...part,
        SKILL_MD,
      );
      const hit = new Set(rows.map((r) => r.parent_id));
      for (const id of part) this.skills.set(id, hit.has(id));
    }
    return new Set(folderIds.filter((id) => this.skills.get(id)));
  }

  /** Which of these folder ids are prototypes (under prototypes/, with a live index.html). */
  async protoSet(folderIds: string[]): Promise<Set<string>> {
    const missing = [...new Set(folderIds)].filter((id) => !this.protos.has(id));
    const prefix = `/${AREA_IDS.prototypes}/`;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const part = missing.slice(i, i + CHUNK);
      const rows = await all<{ parent_id: string }>(
        this.db,
        `SELECT parent_id FROM nodes WHERE parent_id IN (${qs(part.length)}) AND lower(name) = ? AND kind = 'doc' AND deleted_at IS NULL AND substr(path, 1, ?) = ?`,
        ...part,
        PROTO_INDEX,
        prefix.length,
        prefix,
      );
      const hit = new Set(rows.map((r) => r.parent_id));
      for (const id of part) this.protos.set(id, hit.has(id));
    }
    return new Set(folderIds.filter((id) => this.protos.get(id)));
  }

  /** The nearest prototype folder containing this node (a prototype folder contains itself), or null. */
  async protoOf(node: TNode): Promise<NodeRow | null> {
    const chain = chainOf(node.path);
    const folders = node.kind === 'doc' ? chain.slice(0, -1) : chain;
    const set = await this.protoSet(folders);
    for (let i = folders.length - 1; i >= 0; i--) if (set.has(folders[i]!)) return this.get(folders[i]!);
    return null;
  }

  /** SKILL.md of a skill folder, or null. */
  async skillMd(folderId: string): Promise<NodeRow | null> {
    return one<NodeRow>(this.db, "SELECT * FROM nodes WHERE parent_id = ? AND name = ? AND kind = 'doc' AND deleted_at IS NULL", folderId, SKILL_MD);
  }

  /** Folder ids along the chains of these nodes that are skill folders. */
  async chainSkills(nodes: TNode[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const n of nodes) for (const id of chainOf(n.path)) ids.add(id);
    return this.skillSet([...ids]);
  }
}

/** The whole live tree in memory, for the graph (a few thousand nodes). */
export class MemTree implements TreeSource {
  readonly byId = new Map<string, NodeRow>();
  readonly kids = new Map<string, NodeRow[]>();
  readonly skillFolders = new Set<string>();
  readonly protoFolders = new Set<string>();
  private skillByName = new Map<string, NodeRow>();

  constructor(rows: NodeRow[]) {
    for (const r of rows) {
      this.byId.set(r.id, r);
      if (r.parent_id) {
        const list = this.kids.get(r.parent_id) ?? [];
        list.push(r);
        this.kids.set(r.parent_id, list);
      }
      if (r.kind === 'doc' && r.name === SKILL_MD && r.parent_id) this.skillFolders.add(r.parent_id);
      if (r.kind === 'doc' && r.name.toLowerCase() === PROTO_INDEX && r.parent_id && r.path.startsWith(`/${AREA_IDS.prototypes}/`)) this.protoFolders.add(r.parent_id);
    }
    const skillsPrefix = `/${AREA_IDS.skills}/`;
    const candidates = [...this.skillFolders]
      .map((id) => this.byId.get(id))
      .filter((n): n is NodeRow => !!n && n.path.startsWith(skillsPrefix))
      .sort((a, b) => a.path.length - b.path.length || (a.id < b.id ? -1 : 1));
    for (const f of candidates) {
      const k = f.name.toLowerCase();
      if (!this.skillByName.has(k)) this.skillByName.set(k, f);
    }
  }

  static async load(db: D1Database): Promise<MemTree> {
    return new MemTree(await all<NodeRow>(db, 'SELECT * FROM nodes WHERE deleted_at IS NULL'));
  }

  async get(id: string): Promise<NodeRow | null> {
    return this.byId.get(id) ?? null;
  }

  async child(parentId: string, seg: string): Promise<NodeRow | null> {
    const names = childNames(seg);
    const list = (this.kids.get(parentId) ?? []).filter((c) => names.includes(c.name.toLowerCase()));
    return list.find((c) => c.name.toLowerCase() === seg.toLowerCase()) ?? list[0] ?? null;
  }

  async findSkill(name: string): Promise<NodeRow | null> {
    return this.skillByName.get(name.toLowerCase()) ?? null;
  }

  async skillSet(folderIds: string[]): Promise<Set<string>> {
    return new Set(folderIds.filter((id) => this.skillFolders.has(id)));
  }
}
