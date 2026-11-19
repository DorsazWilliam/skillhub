import type { WhoamiOutput } from '../api/client';

/** Product name and organisation label for the top bar. brand.json may set "org"; otherwise the sign-in domain is used. */
let name = 'SkillHub';

export function setBrand(me: WhoamiOutput | undefined): void {
  const n = me?.brand?.['name'];
  if (typeof n === 'string' && n) name = n;
}

export function brandName(): string {
  return name;
}

export function brandOrg(me: WhoamiOutput | undefined): string {
  const o = me?.brand?.['org'];
  if (typeof o === 'string' && o) return o;
  const dom = (me?.user.email ?? '').split('@')[1]?.split('.')[0] ?? '';
  return dom ? dom[0]!.toUpperCase() + dom.slice(1) : '';
}
