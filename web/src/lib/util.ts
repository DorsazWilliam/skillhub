/** Small helpers ported from the prototype. Pure, no DOM. */

export const MIN = 6e4;
export const HR = 36e5;
export const DAY = 864e5;

export function ago(ts: number | null | undefined): string {
  if (!ts) return '-';
  const s = Date.now() - ts;
  if (s < 45e3) return 'now';
  if (s < HR) return Math.round(s / MIN) + 'm';
  if (s < DAY) return Math.round(s / HR) + 'h';
  if (s < 30 * DAY) return Math.round(s / DAY) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function hue(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const initials = (n: string): string =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const ROLES = ['None', 'Viewer', 'Editor', 'Publisher', 'Manager'] as const;
export const RICON = ['ban', 'eye', 'pencil', 'rocket', 'shield'] as const;
export type Access = 'none' | 'viewer' | 'editor' | 'publisher' | 'manager';
export const ROLE_N: Record<Access, number> = { none: 0, viewer: 1, editor: 2, publisher: 3, manager: 4 };
export const ROLE_KEY = ['none', 'viewer', 'editor', 'publisher', 'manager'] as const;

/** The three fixed areas. Keys follow the prototype (docs), names follow the API (documentation). */
export type AreaKey = 'rules' | 'skills' | 'docs';
export type AreaName = 'rules' | 'skills' | 'documentation';
export const AREAS: Record<AreaKey, { name: AreaName; icon: string; label: string; tip: string }> = {
  rules: { name: 'rules', icon: 'scroll', label: 'Rules', tip: 'Always on' },
  skills: { name: 'skills', icon: 'sparkles', label: 'Skills', tip: 'Loaded when relevant' },
  docs: { name: 'documentation', icon: 'book', label: 'Documentation', tip: 'Linked reference' },
};
export const AREA_KEYS: AreaKey[] = ['rules', 'skills', 'docs'];
export const areaKey = (a: AreaName | null | undefined): AreaKey => (a === 'rules' ? 'rules' : a === 'skills' ? 'skills' : 'docs');
export const LINK_RULE: Record<AreaKey, string> = {
  rules: 'Rules link to skills and documentation',
  skills: 'Skills link to documentation and their own files',
  docs: 'Documentation links to documentation',
};
export const RULES_CAP = 8192;

export const FILE_RE = /\.(sh|py|sql|js|ts|json|ya?ml|toml|txt|csv|ps1)$/i;
export const isCodeName = (name: string): boolean => FILE_RE.test(name);

export const SCOPES: [string, string, string, string][] = [
  ['read', 'eye', 'Read', 'Find and read published skills'],
  ['write', 'pencil', 'Write', 'Create docs, edit drafts, commit'],
  ['publish', 'rocket', 'Publish', 'Publish and unpublish versions'],
  ['manage', 'users', 'Manage', 'Change access, move, delete'],
  ['admin', 'shield', 'Admin', 'Users, teams and audit'],
];

export const CLIENT_C: Record<string, string> = { Claude: '#c96442', ChatGPT: '#10a37f', 'Copilot Studio': '#6b5bd6' };

export const OPI: Record<string, string> = {
  get_skill: 'eye', find_skills: 'search', commit_version: 'commit', publish_version: 'rocket', publish_skill: 'rocket', unpublish: 'eye-off', update_draft: 'pencil',
  get_draft: 'pencil', discard_draft: 'rotate', grant_access: 'user-plus', revoke_access: 'user-minus', set_inherit: 'link-off', move_node: 'move', rename_node: 'type',
  create_doc: 'file-plus', create_folder: 'folder-plus', create_skill: 'sparkles', delete_node: 'trash', restore_node: 'undo', set_user_status: 'ban', set_user_role: 'crown',
  mint_api_token: 'key', revoke_api_token: 'key', revoke_mcp_connection: 'plug', add_team_member: 'user-plus', remove_team_member: 'user-minus', create_team: 'users',
  rename_team: 'type', delete_team: 'trash', export_tree: 'download', login: 'logout', logout: 'logout', dismiss_warning: 'eye-off', restore_warnings: 'undo',
};
export const OPL: Record<string, string> = {
  get_skill: 'read', find_skills: 'found', commit_version: 'committed', publish_version: 'published', publish_skill: 'published skill', unpublish: 'unpublished',
  update_draft: 'edited draft', get_draft: 'opened draft', discard_draft: 'discarded draft', grant_access: 'shared', revoke_access: 'removed access',
  set_inherit: 'changed inheritance', move_node: 'moved', rename_node: 'renamed', create_doc: 'created', create_folder: 'created', create_skill: 'created',
  delete_node: 'deleted', restore_node: 'restored', dismiss_warning: 'dismissed a warning', restore_warnings: 'restored warnings',
};
export const VIA: Record<string, [string, string]> = { ui: ['pointer', 'Web'], rest: ['terminal', 'API'], mcp: ['bot', 'Agent'], system: ['cog', 'System'] };

export const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Frontmatter helpers for the SKILL.md form (prototype splitFM/buildFM/fmError). Unknown keys are preserved verbatim. */
export function splitFM(src: string): { fm: Record<string, string> | null; body: string; rest: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: null, body: src, rest: '' };
  const fm: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const k = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (k) {
      let v = (k[2] ?? '').trim();
      if (/^".*"$/.test(v)) {
        try {
          v = JSON.parse(v) as string;
        } catch {
          v = v.slice(1, -1);
        }
      } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
      fm[k[1]!] = v;
      if (k[1] !== 'name' && k[1] !== 'description') rest.push(line);
    } else rest.push(line);
  }
  return { fm, body: src.slice(m[0].length), rest: rest.length ? rest.join('\n') + '\n' : '' };
}

function yamlScalar(s: string): string {
  // Quote when plain YAML would change the meaning (colons, leading symbols, hashes).
  if (s === '' || /[:#]\s|^[\s'"!&*?|>%@`{}[\],-]|\s$/.test(s) || /^(true|false|null|yes|no|~|\d[\d.]*)$/i.test(s)) return JSON.stringify(s);
  return s;
}

export function buildFM(name: string, desc: string, rest: string): string {
  if (!name && !desc && !rest) return '';
  let s = '---\n';
  if (name) s += 'name: ' + yamlScalar(name) + '\n';
  if (desc) s += 'description: ' + yamlScalar(desc.replace(/\n/g, ' ')) + '\n';
  return s + (rest || '') + '---\n';
}

export function fmError(name: string, desc: string, skillMd: boolean): string {
  if (!skillMd) return '';
  if (!name && !desc) return 'Add a name and a description.';
  if (!name) return 'Add a name, or clear the description to make this a plain document.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return 'Lowercase letters, digits and single hyphens.';
  if (name.length > 64) return 'Max 64 characters.';
  if (!desc) return 'Add a description so agents know when to use it.';
  if (desc.length > 1024) return 'Max 1024 characters.';
  return '';
}

export function downloadName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-');
}
