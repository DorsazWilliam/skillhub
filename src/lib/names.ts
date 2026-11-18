import { LIMITS } from './limits';
import { invalid } from './errors';

export function validateName(raw: string): string {
  const name = raw.trim();
  if (!name) throw invalid('Name is required');
  if (name.length > LIMITS.nameChars) throw invalid(`Name is longer than ${LIMITS.nameChars} characters`);
  if (name.includes('/')) throw invalid('Name cannot contain "/"');
  if (name === '.' || name === '..') throw invalid('Name is reserved');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw invalid('Name contains control characters');
  return name;
}
