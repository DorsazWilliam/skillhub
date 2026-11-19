import { describe, expect, it } from 'vitest';
import { lint, type LintContext } from '../src/lib/lint';
import { extractLinks, canonFromChain, linkAllowed, type Placed } from '../src/lib/links';

const base: LintContext = {
  kind: 'doc',
  area: 'skills',
  isAreaRoot: false,
  isSkillMd: true,
  isFile: false,
  rulesBytes: 0,
  links: new Map(),
  nestedRefs: [],
};
const ctx = (o: Partial<LintContext> = {}): LintContext => ({ ...base, ...o });
const skill = (name: string, description: string, body = '# Steps\n\n1. Run it.\n'): string => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const codes = (c: LintContext, content: string): string[] => lint(c, content).map((w) => w.code);
const GOOD = 'Use when reviewing a pull request.';

describe('lint rules (prototype lintAll)', () => {
  it('desc-trigger: description must say when', () => {
    expect(codes(ctx(), skill('review', 'Reviews pull requests.'))).toContain('desc-trigger');
    expect(codes(ctx(), skill('review', GOOD))).not.toContain('desc-trigger');
  });

  it('desc-person: third person only', () => {
    expect(codes(ctx(), skill('review', 'Use when you review a pull request.'))).toContain('desc-person');
    expect(codes(ctx(), skill('review', 'Use when I review code.'))).toContain('desc-person');
    expect(codes(ctx(), skill('review', GOOD))).not.toContain('desc-person');
  });

  it('body-long: over 500 lines', () => {
    expect(codes(ctx(), skill('review', GOOD, 'x\n'.repeat(501)))).toContain('body-long');
    expect(codes(ctx(), skill('review', GOOD, 'x\n'.repeat(400)))).not.toContain('body-long');
  });

  it('name-vague and name-reserved', () => {
    expect(codes(ctx(), skill('helpers', GOOD))).toContain('name-vague');
    expect(codes(ctx(), skill('data', GOOD))).toContain('name-vague');
    expect(codes(ctx(), skill('data-review', GOOD))).not.toContain('name-vague');
    expect(codes(ctx(), skill('claude-helper', GOOD))).toContain('name-reserved');
    expect(codes(ctx(), skill('code-review', GOOD))).not.toContain('name-reserved');
  });

  it('refs-deep: one warning per nested reference, keyed on its path', () => {
    const w = lint(ctx({ nestedRefs: ['templates/comment'] }), skill('review', GOOD));
    expect(w.find((x) => x.code === 'refs-deep')).toMatchObject({ message: 'Nested reference: templates/comment', key: 'refs-deep|Nested reference: templates/comment' });
    expect(codes(ctx(), skill('review', GOOD))).not.toContain('refs-deep');
  });

  it('win-path and dated', () => {
    expect(lint(ctx(), skill('review', GOOD, 'Run scripts\\check.py first.\n')).find((w) => w.code === 'win-path')?.message).toBe('Use forward slashes: scripts\\check.py');
    expect(codes(ctx(), skill('review', GOOD, 'Run scripts/check.py first.\n'))).not.toContain('win-path');
    expect(codes(ctx(), skill('review', GOOD, 'Use the old API until March 2027.\n'))).toContain('dated');
    expect(codes(ctx(), skill('review', GOOD, 'Use the new API.\n'))).not.toContain('dated');
  });

  it('skill-only rules do not apply to other documents', () => {
    expect(codes(ctx({ isSkillMd: false, area: 'documentation' }), skill('helpers', 'Reviews you.'))).toEqual([]);
  });

  it('rule-long, rules-cap and rule-procedure', () => {
    const rule = ctx({ isSkillMd: false, area: 'rules' });
    expect(codes(rule, 'x'.repeat(2049))).toContain('rule-long');
    expect(codes(rule, 'x'.repeat(2000))).not.toContain('rule-long');
    expect(codes({ ...rule, rulesBytes: 9000 }, 'short')).toContain('rules-cap');
    expect(codes({ ...rule, rulesBytes: 8000 }, 'short')).not.toContain('rules-cap');
    const steps = (n: number): string => Array.from({ length: n }, (_, i) => `${i + 1}. Step`).join('\n\n');
    expect(codes(rule, steps(6))).toContain('rule-procedure');
    expect(codes(rule, steps(5))).not.toContain('rule-procedure');
    // The rules area folder carries the cap warning too.
    expect(codes(ctx({ kind: 'folder', area: 'rules', isAreaRoot: true, isSkillMd: false, rulesBytes: 9000 }), '')).toEqual(['rules-cap']);
    expect(codes(ctx({ kind: 'folder', area: 'rules', isAreaRoot: true, isSkillMd: false, rulesBytes: 100 }), '')).toEqual([]);
  });

  it('toc-missing: long documentation pages need contents', () => {
    const doc = ctx({ isSkillMd: false, area: 'documentation' });
    const long = 'line\n'.repeat(120);
    expect(codes(doc, long)).toContain('toc-missing');
    expect(codes(doc, '## Contents\n\n' + long)).not.toContain('toc-missing');
    expect(codes(doc, 'line\n'.repeat(50))).not.toContain('toc-missing');
  });

  it('link problems, keyed on the path', () => {
    const md = 'See [[documentation/a]], [[rules/b]], [[documentation/c]] and [[documentation/d]].';
    const links = new Map([
      ['documentation/a', 'ok' as const],
      ['rules/b', 'wrong_direction' as const],
      ['documentation/c', 'broken' as const],
      ['documentation/d', 'locked' as const],
    ]);
    const w = lint(ctx({ isSkillMd: false, area: 'documentation', links }), md);
    expect(w.map((x) => [x.code, x.message, x.key, x.level])).toEqual([
      ['link-direction', 'Wrong direction: rules/b', 'link-direction|rules/b', 'warn'],
      ['link-broken', 'Not found: documentation/c', 'link-broken|documentation/c', 'broken'],
      ['link-locked', 'Locked link', 'link-locked|documentation/d', 'broken'],
    ]);
  });

  it('files get no warnings', () => {
    expect(lint(ctx({ isFile: true, isSkillMd: false }), 'C:\\temp\\x until March 2027 [[nope]]')).toEqual([]);
  });

  it('desc-* keys follow the description text, other keys the message', () => {
    const a = lint(ctx(), skill('review', 'Reviews pull requests.')).find((w) => w.code === 'desc-trigger')!;
    expect(a.key).toBe('desc-trigger|Reviews pull requests.');
    const b = lint(ctx(), skill('helpers', GOOD)).find((w) => w.code === 'name-vague')!;
    expect(b.key).toBe('name-vague|Vague name');
  });
});

describe('links (prototype extractLinks, canon, linkAllowed)', () => {
  it('extracts [[path]] and [[path|label]], ignoring code', () => {
    expect(extractLinks('a [[documentation/x]] b [[skills/y/z.sh|the script]] `[[rules/no]]`\n```\n[[rules/no2]]\n```')).toEqual([
      { path: 'documentation/x', label: null },
      { path: 'skills/y/z.sh', label: 'the script' },
    ]);
  });

  it('canonical paths: skills by short name, sub-skills under their parent skill, SKILL.md dropped', () => {
    const area = { id: 'AS', name: 'skills', kind: 'folder' as const };
    const org = { id: 'ENG', name: 'engineering', kind: 'folder' as const };
    const dep = { id: 'DEP', name: 'deploy-service', kind: 'folder' as const };
    const can = { id: 'CAN', name: 'canary', kind: 'folder' as const };
    const md = { id: 'MD', name: 'SKILL.md', kind: 'doc' as const };
    const scripts = { id: 'SC', name: 'scripts', kind: 'folder' as const };
    const sh = { id: 'SH', name: 'smoke-test.sh', kind: 'doc' as const };
    const skills = new Set(['DEP', 'CAN']);
    expect(canonFromChain([area, org, dep], skills).path).toBe('skills/deploy-service');
    expect(canonFromChain([area, org, dep, md], skills).path).toBe('skills/deploy-service');
    expect(canonFromChain([area, org, dep, scripts, sh], skills).path).toBe('skills/deploy-service/scripts/smoke-test.sh');
    expect(canonFromChain([area, org, dep, can, md], skills).path).toBe('skills/deploy-service/canary');
    expect(canonFromChain([area, org], skills).path).toBe('skills/engineering');
    const docs = { id: 'AD', name: 'documentation', kind: 'folder' as const };
    expect(canonFromChain([docs, { id: 'E', name: 'engineering', kind: 'folder' }, { id: 'X', name: 'architecture', kind: 'doc' }], skills).path).toBe(
      'documentation/engineering/architecture',
    );
  });

  it('allowed directions', () => {
    const p = (area: Placed['area'], chain: string[] = [], skillId: string | null = null): Placed => ({ id: 'x', area, chain, skillId });
    expect(linkAllowed(p('rules'), p('skills'))).toBe(true);
    expect(linkAllowed(p('rules'), p('documentation'))).toBe(true);
    expect(linkAllowed(p('rules'), p('rules'))).toBe(false);
    expect(linkAllowed(p('skills', [], 'S1'), p('documentation'))).toBe(true);
    expect(linkAllowed(p('skills', [], 'S1'), p('skills', ['AS', 'S1', 'F']))).toBe(true);
    expect(linkAllowed(p('skills', [], 'S1'), p('skills', ['AS', 'S2']))).toBe(false);
    expect(linkAllowed(p('skills', [], 'S1'), p('rules'))).toBe(false);
    expect(linkAllowed(p('documentation'), p('documentation'))).toBe(true);
    expect(linkAllowed(p('documentation'), p('skills'))).toBe(false);
  });
});
