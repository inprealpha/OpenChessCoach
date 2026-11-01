// What a vertical swipe does to a phone's panel sheet (lib/sheet.svelte.ts), apart from the DOM.

/** How far a finger moves before a swipe counts, in CSS pixels: less is a tap or a wobble. */
export const SWIPE = 24;

/**
 * Whether the sheet is pulled up after a vertical swipe of `dy` (negative: the finger moved up) on
 * a panel scrolled `scrollTop` from its top. Up pulls the sheet up; down at the panel's top lets it
 * back down, as a page pulled past its top would. Anything else leaves it, so the panel scrolls.
 */
export function afterSwipe(full: boolean, dy: number, scrollTop: number): boolean {
  if (!full && dy <= -SWIPE) return true;
  if (full && dy >= SWIPE * 2 && scrollTop <= 0) return false;
  return full;
}
