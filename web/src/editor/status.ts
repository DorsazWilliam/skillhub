import { useSyncExternalStore } from 'react';

/** Autosave state of the open editor, shared with the phone navigation bar (kept out of the lazy editor chunk). */
export type SaveState = 'saved' | 'pending' | 'saving';

let save: SaveState = 'saved';
const subs = new Set<() => void>();

export function setSave(s: SaveState): void {
  if (s === save) return;
  save = s;
  for (const f of subs) f();
}

export function useSave(): SaveState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => save,
  );
}
