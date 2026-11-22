import { QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, ApiError, type GetNodeOutput, type GetSkillOutput, type ListChildrenOutput, type WhoamiOutput } from './client';
import { ROLE_N, type Access } from '../lib/util';

/** React Query wrappers around the generated client. Every call goes through `api` (the registry's REST surface). */

export type Item = ListChildrenOutput['items'][number];
export type NodeT = GetNodeOutput & Partial<Pick<Item, 'skill' | 'author' | 'links' | 'children'>>;
export type Skill = GetSkillOutput;
export type Me = WhoamiOutput;

export const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

export const role = (n: { access: Access } | null | undefined): number => (n ? ROLE_N[n.access] : 0);

export function useMe(): UseQueryResult<Me> {
  return useQuery({ queryKey: ['me'], queryFn: () => api.whoami(), staleTime: 300_000 });
}

/** Children of a folder (or the three areas when folder is null). Seeds the node cache for crumbs and lookups. */
export async function fetchChildren(folder: string | null): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await api.list_children({ ...(folder ? { folder } : {}), limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  for (const it of out) qc.setQueryData(['node', it.id], it);
  return out;
}

export function useChildren(folder: string | null, enabled = true): UseQueryResult<Item[]> {
  return useQuery({ queryKey: ['children', folder], queryFn: () => fetchChildren(folder), enabled });
}

export async function fetchNode(id: string): Promise<NodeT> {
  const cached = qc.getQueryData<NodeT>(['node', id]);
  if (cached) return cached;
  return qc.fetchQuery({ queryKey: ['node', id], queryFn: () => api.get_node({ node: id }) });
}

export function useNode(id: string | null): UseQueryResult<NodeT> {
  return useQuery({ queryKey: ['node', id], queryFn: () => api.get_node({ node: id! }), enabled: !!id });
}

/** The readable ancestors of a node, top first, ending with the node. */
export function useChain(id: string | null): UseQueryResult<NodeT[]> {
  return useQuery({
    queryKey: ['chain', id],
    enabled: !!id,
    queryFn: async () => {
      const out: NodeT[] = [];
      let cur: string | null = id;
      for (let i = 0; cur && i < 40; i++) {
        const n: NodeT = await fetchNode(cur);
        out.unshift(n);
        cur = n.parent_id;
      }
      return out;
    },
  });
}

export function useSkill(id: string | null, version?: number | 'draft' | null, enabled = true): UseQueryResult<Skill> {
  return useQuery({
    queryKey: ['skill', id, version ?? null],
    enabled: !!id && enabled,
    queryFn: () => api.get_skill({ doc: id!, ...(version != null ? { version } : {}) }),
  });
}

export function useLinks(id: string | null, enabled = true) {
  return useQuery({ queryKey: ['links', id], enabled: !!id && enabled, queryFn: () => api.get_links({ node: id! }) });
}

/** A prototype's files and a signed preview link (valid an hour; refetched well before it expires). */
export function usePrototype(id: string | null, mode?: 'published' | 'working') {
  return useQuery({
    queryKey: ['prototype', id, mode ?? null],
    enabled: !!id,
    staleTime: 20 * 60_000,
    refetchInterval: 40 * 60_000,
    queryFn: () => api.get_prototype({ prototype: id!, ...(mode ? { version: mode } : {}) }),
  });
}

export function useGraph(enabled = true) {
  return useQuery({ queryKey: ['graph'], enabled, queryFn: () => api.get_graph({}) });
}

export function useVersions(id: string | null, enabled = true) {
  return useQuery({ queryKey: ['versions', id], enabled: !!id && enabled, queryFn: () => api.list_versions({ doc: id!, limit: 100 }) });
}

export function useDraft(id: string | null, enabled = true) {
  return useQuery({ queryKey: ['draft', id], enabled: !!id && enabled, queryFn: () => api.get_draft({ doc: id! }) });
}

export function useWarnings(id: string | null, version: number | 'draft' | 'latest' | 'published' | null, enabled = true) {
  return useQuery({
    queryKey: ['warnings', id, version],
    enabled: !!id && enabled,
    queryFn: () => api.get_warnings({ node: id!, ...(version != null ? { version } : {}) }),
  });
}

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ['users'],
    enabled,
    staleTime: 120_000,
    queryFn: async () => {
      const out: Awaited<ReturnType<typeof api.list_users>>['items'] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const p = await api.list_users({ limit: 100, ...(cursor ? { cursor } : {}) });
        out.push(...p.items);
        if (!p.next_cursor) break;
        cursor = p.next_cursor;
      }
      return out;
    },
  });
}

export function useTeams(enabled = true) {
  return useQuery({ queryKey: ['teams'], enabled, queryFn: () => api.list_teams({}) });
}

export function useRulesSize(enabled = true) {
  return useQuery({ queryKey: ['rulesSize'], enabled, queryFn: () => api.get_rules_size({}) });
}

/** Refresh everything that depends on document content or the tree after a mutation. */
export function invalidateContent(): void {
  for (const k of ['children', 'node', 'chain', 'skill', 'links', 'graph', 'versions', 'draft', 'warnings', 'rulesSize', 'grants', 'access', 'audit', 'trash', 'search', 'diff', 'prototype']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

export function invalidate(...keys: string[]): void {
  for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
}
