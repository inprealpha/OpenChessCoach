// PROTOTYPE (#80): which version of the phone's panel sheet this device uses, so the owner can
// compare three on a phone and pick one. Settings has the choice; `?sheet=0|1|2|3` in the address
// forces one for that page load. Removed with the losing versions once the owner picks.
export type SheetVariant = 'v0' | 'v1' | 'v2' | 'v3';

export const SHEET_VARIANTS: readonly { id: SheetVariant; name: string; about: string }[] = [
  { id: 'v0', name: 'Today', about: 'The panel as it is on main, to compare against.' },
  { id: 'v1', name: 'Version 1', about: 'Follows the finger, with a slide when let go.' },
  { id: 'v2', name: 'Version 2', about: 'Scrolls like a native list, snapping open or shut.' },
  { id: 'v3', name: 'Version 3', about: 'Slides over the board, which keeps its size.' },
];

const KEY = 'sheetVariant';
const isVariant = (v: string | null): v is SheetVariant => v === 'v0' || v === 'v1' || v === 'v2' || v === 'v3';

function fromAddress(): SheetVariant | null {
  if (typeof location === 'undefined') return null;
  const n = new URLSearchParams(location.search).get('sheet');
  const v = n === null ? null : `v${n}`;
  return isVariant(v) ? v : null;
}

function stored(): SheetVariant | null {
  try {
    const v = localStorage.getItem(KEY);
    return isVariant(v) ? v : null;
  } catch {
    return null;
  }
}

/** The version this page load uses: the address, then this device's choice, then today's. */
export const sheetVariant: SheetVariant = fromAddress() ?? stored() ?? 'v0';
/** Whether the address forced the version, so Settings can say so. */
export const sheetVariantFromAddress = fromAddress() !== null;

/** Picks a version for this device and reloads, dropping `?sheet=` so the choice sticks. */
export function chooseSheetVariant(v: SheetVariant): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private browsing: the choice lasts this page load only.
  }
  const url = new URL(location.href);
  url.searchParams.delete('sheet');
  location.replace(url.toString());
}

if (typeof document !== 'undefined') document.documentElement.dataset.sheet = sheetVariant;
