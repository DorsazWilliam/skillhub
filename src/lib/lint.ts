import { splitFrontmatter } from './frontmatter';
import { distinctLinks, extractLinks, type LinkStatus } from './links';
import type { Area } from './areas';

/**
 * Authoring warnings. A pure port of the prototype's lintAll: same rules, codes and messages.
 * Warnings never block a write. Each has a key = code + '|' + fingerprint of the flagged text
 * (the description for desc-*, the link path for link-*, otherwise the message), so a dismissal
 * survives new versions until the flagged text changes.
 */

export const RULES_CAP = 8192;
const RULE_BYTES = 2048;

export type WarningCode =
  | 'desc-trigger'
  | 'desc-person'
  | 'body-long'
  | 'name-vague'
  | 'name-reserved'
  | 'refs-deep'
  | 'win-path'
  | 'dated'
  | 'rule-long'
  | 'rules-cap'
  | 'rule-procedure'
  | 'toc-missing'
  | 'link-direction'
  | 'link-broken'
  | 'link-locked';

export interface Warning {
  code: WarningCode;
  message: string;
  key: string;
  /** 'broken' for links that do not resolve or cannot be read, 'warn' otherwise. */
  level: 'warn' | 'broken';
}

/** Everything lint needs to know about the node, gathered by the caller (all lookups happen outside). */
export interface LintContext {
  kind: 'folder' | 'doc';
  area: Area | null;
  isAreaRoot: boolean;
  isSkillMd: boolean;
  isFile: boolean;
  /** Bytes of every published rule (the prototype's rulesBytes). */
  rulesBytes: number;
  /** Status of each distinct link path as written, from the caller's point of view. */
  links: ReadonlyMap<string, LinkStatus>;
  /** For SKILL.md: files of this skill it links to that link onward, as their path inside the skill. */
  nestedRefs: readonly string[];
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DATED = new RegExp('\\b(?:before|after|until)\\s+(?:' + MONTHS + ')\\.?\\s+\\d{4}\\b', 'i');
const WIN_PATH = /(?:^|[\s(`'"])((?:[\w.-]+\\)+[\w.-]+)/;
const bytes = (s: string): number => new TextEncoder().encode(s).length;

function hasToc(lines: string[]): boolean {
  const top = lines.slice(0, 25);
  return (
    top.some((l) => /^#{1,4}\s*(contents|table of contents|on this page|toc)\b/i.test(l)) ||
    top.filter((l) => /^\s*(?:[-*]|\d+\.)\s*\[[^\]]+\]\(#/.test(l)).length >= 3
  );
}

/** The prototype's tolerant frontmatter reader: never throws. */
function frontmatter(content: string): { fm: Record<string, unknown> | null; body: string } {
  try {
    const p = splitFrontmatter(content);
    return { fm: p.frontmatter, body: p.body };
  } catch {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
    return { fm: null, body: m ? content.slice(m[0].length) : content };
  }
}

export function lint(ctx: LintContext, content: string): Warning[] {
  const out: Warning[] = [];
  const add = (code: WarningCode, message: string, level: Warning['level'] = 'warn', fingerprint?: string): void => {
    out.push({ code, message, level, key: code + '|' + (fingerprint ?? message) });
  };

  if (ctx.kind === 'folder') {
    if (ctx.area === 'rules' && ctx.isAreaRoot && ctx.rulesBytes > RULES_CAP) add('rules-cap', 'Rules over 8 KB');
    return out;
  }
  if (ctx.isFile) return out;

  if (ctx.isSkillMd) {
    const { fm, body } = frontmatter(content);
    const name = typeof fm?.['name'] === 'string' ? (fm['name'] as string) : '';
    const desc = typeof fm?.['description'] === 'string' ? (fm['description'] as string) : '';
    if (desc && !/\bwhen\b/i.test(desc)) add('desc-trigger', 'Description: say when to use it', 'warn', desc);
    if (/\bI\b/.test(desc) || /\b(you|your)\b/i.test(desc)) add('desc-person', 'Description: write in third person', 'warn', desc);
    if (body.split('\n').length > 500) add('body-long', 'Over 500 lines: split into files');
    if (/^(helpers?|utils?|tools?|documents?|data|files?)$/.test(name)) add('name-vague', 'Vague name');
    if (/claude|anthropic/i.test(name)) add('name-reserved', 'Reserved word in name');
    for (const rel of ctx.nestedRefs) add('refs-deep', 'Nested reference: ' + rel);
    const w = WIN_PATH.exec(body);
    if (w) add('win-path', 'Use forward slashes: ' + w[1]);
    const dt = DATED.exec(content);
    if (dt) add('dated', 'Time-sensitive: ' + dt[0]);
  }

  if (ctx.area === 'rules') {
    if (bytes(content) > RULE_BYTES) add('rule-long', 'Rule over 2 KB');
    if (ctx.rulesBytes > RULES_CAP) add('rules-cap', 'Rules over 8 KB');
    let run = 0;
    let max = 0;
    for (const l of content.split('\n')) {
      run = /^\s*\d+\.\s/.test(l) ? run + 1 : l.trim() ? 0 : run;
      max = Math.max(max, run);
    }
    if (max > 5) add('rule-procedure', 'Long procedure: make it a skill');
  }

  if (ctx.area === 'documentation') {
    const lines = content.split('\n');
    if (lines.length > 100 && !hasToc(lines)) add('toc-missing', 'Long page: add contents');
  }

  for (const l of distinctLinks(content)) {
    const st = ctx.links.get(l.path);
    if (st === 'wrong_direction') add('link-direction', 'Wrong direction: ' + l.path, 'warn', l.path);
    else if (st === 'broken') add('link-broken', 'Not found: ' + l.path, 'broken', l.path);
    else if (st === 'locked') add('link-locked', 'Locked link', 'broken', l.path);
  }
  return out;
}

/** Links of a SKILL.md body (without frontmatter), used to find nested references. */
export function bodyLinks(content: string): string[] {
  return extractLinks(frontmatter(content).body).map((l) => l.path);
}
