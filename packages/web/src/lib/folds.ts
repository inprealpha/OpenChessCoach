// Whether the Player last opened or closed each collapsible section, remembered on this device.
// Read synchronously before the first paint, so nothing jumps, and wrapped so blocked storage only
// loses the memory, never the screen. Not the offline store (lib/storage.ts), which is
// asynchronous and holds the pairing token and games (ADR 0003).
const PREFIX = 'fold:';

/** Whether the section `name` was left open, or `fallback` when this device never said. */
export function foldOpen(name: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + name);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** Remembers whether the section `name` is open. */
export function rememberFold(name: string, open: boolean): void {
  try {
    localStorage.setItem(PREFIX + name, open ? '1' : '0');
  } catch {
    // Storage is blocked: the section still opens and closes, it just isn't remembered.
  }
}

/**
 * Folds the section `name` from the next visit on, unless the Player already opened or closed it:
 * for a section read once, such as a Review's overview, then in the way.
 */
export function foldFromNextVisit(name: string): void {
  try {
    if (localStorage.getItem(PREFIX + name) === null) localStorage.setItem(PREFIX + name, '0');
  } catch {
    // Storage is blocked: the section opens on every visit instead.
  }
}

/**
 * Carries a section's memory over from an older name: a section the Player has met under `old`
 * (opened, closed, or folded after a first visit) counts as met under `name`, closed, and the old
 * name is dropped.
 */
export function renameFold(old: string, name: string): void {
  try {
    if (localStorage.getItem(PREFIX + old) === null) return;
    if (localStorage.getItem(PREFIX + name) === null) localStorage.setItem(PREFIX + name, '0');
    localStorage.removeItem(PREFIX + old);
  } catch {
    // Storage is blocked: nothing was remembered under either name.
  }
}
