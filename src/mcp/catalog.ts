import type { Authz } from '../authz/authorize';
import { LIMITS } from '../lib/limits';
import { catalog } from '../registry/search';

const TTL_SECONDS = 60;

/**
 * find_skills description with the caller's readable skills appended ("name: one-line description").
 * Replaces the native skill listing chat clients lack. Cached in KV per user for 60 seconds, capped at 4 KB.
 */
export async function findSkillsDescription(kv: KVNamespace, az: Authz, base: string): Promise<string> {
  const key = `skillhub:catalog:v1:${az.actor.user.id}`;
  const cached = await kv.get(key).catch(() => null);
  if (cached !== null) return cached;
  const skills = await catalog(az, LIMITS.catalogEntries);
  let desc = base;
  if (skills.length) {
    desc += '\n\nSkills you can use:';
    for (const s of skills) {
      const line = `\n- ${s.name}: ${s.description.split('\n')[0]!.slice(0, 160)}`;
      if (new TextEncoder().encode(desc + line).length > LIMITS.catalogBytes) break;
      desc += line;
    }
  }
  await kv.put(key, desc, { expirationTtl: TTL_SECONDS }).catch(() => undefined);
  return desc;
}
