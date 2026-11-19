/** The three fixed top-level areas. Seeded by migrations/0003 with these ids. */
export const AREA_IDS = {
  rules: '00000000000000000000000AR1',
  skills: '00000000000000000000000AS1',
  documentation: '00000000000000000000000AD1',
} as const;

export type Area = keyof typeof AREA_IDS;
export const AREAS: readonly Area[] = ['rules', 'skills', 'documentation'];

const BY_ID = new Map<string, Area>(AREAS.map((a) => [AREA_IDS[a], a]));

export function isAreaId(id: string): boolean {
  return BY_ID.has(id);
}

export function areaById(id: string): Area | null {
  return BY_ID.get(id) ?? null;
}

export function areaByName(name: string): Area | null {
  const n = name.toLowerCase();
  return (AREAS as readonly string[]).includes(n) ? (n as Area) : null;
}

/** Area of a node from its materialized path ('/<area id>/...'). */
export function areaOfPath(path: string): Area | null {
  const first = path.split('/').find(Boolean);
  return first ? areaById(first) : null;
}

/** Fixed display order: rules, skills, documentation. */
export function areaOrder(id: string): number {
  const a = areaById(id);
  return a ? AREAS.indexOf(a) : AREAS.length;
}

/** The document that makes its folder a skill. */
export const SKILL_MD = 'SKILL.md';

export function normalizeDocName(name: string): string {
  return name.toLowerCase() === 'skill.md' ? SKILL_MD : name;
}

/** Text file extensions stored as `file` documents: versioned like markdown, served as text, never executed. */
export const FILE_EXTS = ['sh', 'py', 'sql', 'js', 'ts', 'json', 'yaml', 'yml', 'toml', 'txt', 'csv', 'ps1'] as const;

/** 'markdown', or the extension when the name is a supported text file. */
export function formatOfName(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = m?.[1]?.toLowerCase();
  return ext && (FILE_EXTS as readonly string[]).includes(ext) ? ext : 'markdown';
}

export function isFileFormat(format: string | null | undefined): boolean {
  return !!format && format !== 'markdown';
}
