import { skillMeta, splitFrontmatter } from '../lib/frontmatter';
import { stripMarkdown } from '../lib/markdown';
import { stmt } from './d1';

/** Statements that replace a document's FTS row. Run them in the same batch as the publish pointer change. */
export function ftsReplace(db: D1Database, docId: string, markdown: string | null): D1PreparedStatement[] {
  const out = [stmt(db, 'DELETE FROM skill_fts WHERE doc_id = ?', docId)];
  if (markdown === null) return out;
  const meta = skillMeta(markdown);
  if (!meta) return out;
  const body = stripMarkdown(splitFrontmatter(markdown).body);
  out.push(stmt(db, 'INSERT INTO skill_fts (doc_id, name, description, body) VALUES (?,?,?,?)', docId, meta.name, meta.description, body));
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
