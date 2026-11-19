import { skillMeta, splitFrontmatter } from '../lib/frontmatter';
import { stripMarkdown } from '../lib/markdown';
import { SKILL_MD, areaOfPath } from '../lib/areas';
import { stmt } from './d1';

/** A SKILL.md inside skills/: its published frontmatter decides whether its folder is a skill. */
export function isSkillDoc(node: { kind: string; name: string; path: string }): boolean {
  return node.kind === 'doc' && node.name === SKILL_MD && areaOfPath(node.path) === 'skills';
}

/** is_skill flag for a document with this published content. */
export function skillFlag(node: { kind: string; name: string; path: string }, markdown: string | null): 0 | 1 {
  return markdown !== null && isSkillDoc(node) && skillMeta(markdown) ? 1 : 0;
}

/**
 * Statements that replace a document's search rows. Run them in the same batch as the publish pointer change.
 * SKILL.md of a skill goes to skill_fts (find_skills and search); every other document and file goes to doc_fts (search only).
 */
export function ftsReplace(db: D1Database, node: { id: string; kind: string; name: string; path: string }, markdown: string | null): D1PreparedStatement[] {
  const out = [stmt(db, 'DELETE FROM skill_fts WHERE doc_id = ?', node.id), stmt(db, 'DELETE FROM doc_fts WHERE doc_id = ?', node.id)];
  if (markdown === null) return out;
  if (isSkillDoc(node)) {
    const meta = skillMeta(markdown);
    if (!meta) return out;
    const body = stripMarkdown(splitFrontmatter(markdown).body);
    out.push(stmt(db, 'INSERT INTO skill_fts (doc_id, name, description, body) VALUES (?,?,?,?)', node.id, meta.name, meta.description, body));
    return out;
  }
  out.push(stmt(db, 'INSERT INTO doc_fts (doc_id, name, body) VALUES (?,?,?)', node.id, node.name, markdown));
  return out;
}

/** Turns free text into a safe FTS5 expression: quoted tokens OR-ed, prefix match on the last. */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' OR ');
}
