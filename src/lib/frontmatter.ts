import { parse, stringify } from 'yaml';
import { invalid } from './errors';

export interface Parsed {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function splitFrontmatter(markdown: string): Parsed {
  const m = FM_RE.exec(markdown);
  if (!m) return { frontmatter: null, body: markdown };
  let data: unknown;
  try {
    data = parse(m[1] ?? '', { schema: 'core', maxAliasCount: 0 });
  } catch (e) {
    throw invalid('Frontmatter is not valid YAML', { reason: e instanceof Error ? e.message : String(e) });
  }
  if (data === null || data === undefined) return { frontmatter: {}, body: markdown.slice(m[0].length) };
  if (typeof data !== 'object' || Array.isArray(data)) throw invalid('Frontmatter must be a YAML mapping');
  return { frontmatter: data as Record<string, unknown>, body: markdown.slice(m[0].length) };
}

export interface SkillMeta {
  name: string;
  description: string;
}

/** Validates frontmatter. Returns skill meta when the document is a skill, null for a plain document. */
export function validateFrontmatter(markdown: string): SkillMeta | null {
  const { frontmatter } = splitFrontmatter(markdown);
  if (!frontmatter) return null;
  const { name, description } = frontmatter;
  if (name === undefined && description === undefined) return null;
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || name.length > 64) {
    throw invalid('Frontmatter name must be lowercase letters, digits and hyphens, max 64 characters', { field: 'name' });
  }
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 1024) {
    throw invalid('Frontmatter description is required and must be at most 1024 characters', { field: 'description' });
  }
  return { name, description: description.trim() };
}

/** Reads skill meta without throwing. */
export function skillMeta(markdown: string): SkillMeta | null {
  try {
    return validateFrontmatter(markdown);
  } catch {
    return null;
  }
}

/** Writes name/description into frontmatter, preserving every other key. */
export function withFrontmatter(markdown: string, fields: Partial<SkillMeta>): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const next: Record<string, unknown> = { ...(frontmatter ?? {}) };
  if (fields.name !== undefined) next['name'] = fields.name;
  if (fields.description !== undefined) next['description'] = fields.description;
  return `---\n${stringify(next).trimEnd()}\n---\n${body}`;
}
