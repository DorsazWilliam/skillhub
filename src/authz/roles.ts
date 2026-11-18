export const ROLE = { none: 0, viewer: 1, editor: 2, publisher: 3, manager: 4 } as const;
export type RoleName = Exclude<keyof typeof ROLE, 'none'>;
export const ROLE_NAMES: RoleName[] = ['viewer', 'editor', 'publisher', 'manager'];

export function roleName(rank: number): RoleName | 'none' {
  return (['none', 'viewer', 'editor', 'publisher', 'manager'] as const)[rank] ?? 'none';
}

export function roleRank(name: RoleName): number {
  return ROLE[name];
}
