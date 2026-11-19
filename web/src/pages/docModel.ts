import { useNode, useSkill, role, useWarnings, useDraft, type NodeT, type Skill } from '../api/hooks';
import { useUI, type Viewing } from '../state';
import { splitFM, areaKey, type AreaKey } from '../lib/util';

/** What the document page shows, derived like the prototype's defaultView/currentView. */
export interface DocModel {
  node: NodeT | undefined;
  r: number;
  v: number | 'draft' | null;
  content: Skill | undefined;
  loading: boolean;
  error: unknown;
  skillId: string | null;
  head: Skill | undefined;
  area: AreaKey;
  isCode: boolean;
  isSkillMd: boolean;
}

export function viewFor(node: NodeT | undefined, viewing: Viewing): number | 'draft' | null {
  if (!node) return null;
  const pub = node.published_version ?? null;
  if (role(node) < 2) return pub;
  const head = node.head_version ?? 0;
  let v: Viewing = viewing;
  if (v === 'draft' && !node.has_draft) v = null;
  if (typeof v === 'number' && v > head) v = null;
  return v ?? pub ?? (head || (node.has_draft ? 'draft' : null));
}

export function useDocModel(id: string | null): DocModel {
  const nq = useNode(id);
  const node = nq.data;
  const viewing = useUI((s) => s.viewing);
  const r = role(node);
  const v = node && node.kind === 'doc' ? viewFor(node, viewing) : null;
  const editor = r >= 2;
  const cq = useSkill(id, editor ? v : null, !!node && node.kind === 'doc' && v != null);
  const content = cq.data;
  const skillId = content?.skill_id ?? null;
  const ownFiles = !!content?.files;
  const hq = useSkill(skillId, null, !!skillId && !ownFiles);
  return {
    node,
    r,
    v,
    content,
    loading: nq.isLoading || (v != null && cq.isLoading),
    error: nq.error ?? cq.error,
    skillId,
    head: ownFiles ? content : hq.data,
    area: areaKey(node?.area),
    isCode: !!node && node.kind === 'doc' && !!node.format && node.format !== 'markdown',
    isSkillMd: node?.name === 'SKILL.md',
  };
}

export function skillMeta(head: Skill | undefined): { name: string | null; description: string | null } {
  if (!head) return { name: null, description: null };
  const fm = head.frontmatter as Record<string, unknown> | null;
  if (fm) return { name: typeof fm['name'] === 'string' ? fm['name'] : null, description: typeof fm['description'] === 'string' ? fm['description'] : null };
  const { fm: f } = splitFM(head.markdown);
  return { name: f?.['name'] ?? null, description: f?.['description'] ?? null };
}

/** Files of the skill that have a newer committed version than the published one (prototype pendingFiles). */
export function pendingFiles(head: Skill | undefined): NonNullable<Skill['files']> {
  return (head?.files ?? []).filter((f) => f.kind !== 'skill' && (f.head_version ?? 0) > (f.published_version ?? 0));
}

/** Warnings shown for the viewed version (prototype lintActive on lintContent). Editors only. */
export function useLint(node: NodeT | undefined, v: number | 'draft' | null, enabled = true) {
  const isRulesArea = !!node && node.is_area && node.area === 'rules';
  const on = enabled && !!node && role(node) >= 2 && ((node.kind === 'doc' && v != null && node.format === 'markdown') || isRulesArea);
  return useWarnings(node?.id ?? null, node?.kind === 'doc' ? v : null, on);
}

export function useDraftInfo(node: NodeT | undefined) {
  return useDraft(node?.id ?? null, !!node && role(node) >= 2 && !!node.has_draft);
}
