// PROTOTYPE (not for merging): how dense the phone's board screens are drawn, to try on a phone.
// Today is the app as built; Compact and Tight are the levels from the sizing research, set in
// `density.css` under `:root[data-density=…]`. Stored on this device, like the folds (lib/folds.ts):
// read synchronously before the first paint, wrapped so blocked storage only loses the memory.
// `?density=compact|tight|today` in the address forces a level for that page load, for screenshots
// and links, without storing it.

export const DENSITIES = ['today', 'compact', 'tight'] as const;
export type Density = (typeof DENSITIES)[number];

const KEY = 'density';

function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (DENSITIES as readonly string[]).includes(v);
}

/** The level the address asks for, if any. */
function fromAddress(): Density | null {
  try {
    const v = new URLSearchParams(location.search).get('density');
    return isDensity(v) ? v : null;
  } catch {
    return null;
  }
}

/** The level this device draws at: the address's, else the stored one, else Today. */
export function currentDensity(): Density {
  const forced = fromAddress();
  if (forced) return forced;
  try {
    const v = localStorage.getItem(KEY);
    return isDensity(v) ? v : 'today';
  } catch {
    return 'today';
  }
}

function apply(level: Density): void {
  if (level === 'today') delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = level;
}

/** Sets the root's `data-density` from the address or this device's choice. Call before mounting. */
export function applyDensity(): void {
  apply(currentDensity());
}

/** Stores the Player's choice on this device and applies it; drops a `?density=` that would override it. */
export function chooseDensity(level: Density): void {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    // Storage is blocked: the level applies until the page is reloaded.
  }
  if (fromAddress()) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('density');
      history.replaceState(history.state, '', url);
    } catch {
      // The address can't be changed here: the level still applies until a reload.
    }
  }
  apply(level);
}
