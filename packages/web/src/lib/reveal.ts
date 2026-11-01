/**
 * Scrolling a row into a panel's view, clear of what the panel keeps stuck at its top (the
 * Review's Moments and Moves tabs): a row scrolled to the panel's edge would sit under them.
 */

/** How much of `box`'s top its sticky children cover. */
export function coveredTop(box: HTMLElement): number {
  const top = box.getBoundingClientRect().top;
  let covered = 0;
  for (const child of box.children) {
    if (getComputedStyle(child).position !== 'sticky') continue;
    const r = child.getBoundingClientRect();
    if (r.top <= top + 1) covered = Math.max(covered, r.bottom - top);
  }
  return covered;
}

/**
 * Scrolls `box` so `item` shows whole in the part of it nothing covers: to that part's top with
 * `start`, or the least that brings it in with `nearest`. A box that doesn't scroll is left alone.
 */
export function reveal(box: HTMLElement, item: Element, align: 'start' | 'nearest'): void {
  const b = box.getBoundingClientRect();
  const top = b.top + coveredTop(box);
  const at = item.getBoundingClientRect();
  if (align === 'start') {
    if (at.top < top || at.bottom > b.bottom) box.scrollTop += at.top - top;
  } else if (at.top < top) box.scrollTop -= top - at.top;
  else if (at.bottom > b.bottom) box.scrollTop += Math.min(at.bottom - b.bottom, at.top - top);
}
