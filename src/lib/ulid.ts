const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic-enough ULID (time + crypto randomness). */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
