import { createTwoFilesPatch, diffLines } from 'diff';

export interface DiffResult {
  patch: string;
  added: number;
  removed: number;
}

export function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string): DiffResult {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(a, b)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { patch: createTwoFilesPatch(aLabel, bLabel, a, b, '', '', { context: 3 }), added, removed };
}
