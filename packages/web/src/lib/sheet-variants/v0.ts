// The panel sheet as it is on main (#80's "Today"): kept to compare the three versions against.
// Moved here unchanged from sheet.svelte.ts and SheetHandle.svelte.
import { afterSwipe, SWIPE } from '../swipe.ts';
import { none, type SheetDriver } from './types.ts';

export const v0: SheetDriver = {
  /**
   * A swipe up in the panel pulls the sheet up before the rest scrolls, and a pull down that
   * starts at its top lets it back down. A wheel turned down does as a swipe up.
   */
  panel: (sheet, node) => {
    let startY: number | null = null;
    let startTop = 0;
    const start = (e: TouchEvent) => {
      startY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
      startTop = node.scrollTop;
    };
    const move = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (!sheet.on || startY === null || y === undefined) return;
      // From where the swipe started: one that scrolls the panel back to its top doesn't drop the sheet.
      const next = afterSwipe(sheet.full, y - startY, startTop);
      if (next === sheet.full) return;
      sheet.full = next;
      // One change per swipe: the rest of it scrolls the panel.
      startY = null;
    };
    const end = () => (startY = null);
    const wheel = (e: WheelEvent) => {
      if (sheet.on && !sheet.full && e.deltaY > 0) sheet.full = true;
    };
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    node.addEventListener('touchend', end, { passive: true });
    node.addEventListener('touchcancel', end, { passive: true });
    node.addEventListener('wheel', wheel, { passive: true });
    return () => {
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
      node.removeEventListener('wheel', wheel);
    };
  },
  /** A tap or a swipe on the handle pulls the sheet up or lets it down. */
  handle: (sheet, node) => {
    let startY: number | null = null;
    /** The pointer moved far enough to be a swipe: the click that ends it is not a tap. */
    let swiped = false;
    const down = (e: PointerEvent) => {
      startY = e.clientY;
      swiped = false;
    };
    const move = (e: PointerEvent) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) < SWIPE) return;
      // A swipe, whether or not it moves the sheet (up when it is already up): never a tap as well.
      swiped = true;
      sheet.full = afterSwipe(sheet.full, dy, 0);
      startY = null;
    };
    const up = () => (startY = null);
    const click = (e: MouseEvent) => {
      // A keyboard's Enter or Space (no pointer, detail 0) always toggles, whatever a swipe left behind.
      if (e.detail === 0 || !swiped) sheet.toggle();
      swiped = false;
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('click', click);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('click', click);
    };
  },
  /** A tap on the strip brings the board back full size. */
  strip: (sheet, node) => {
    const click = () => (sheet.full = false);
    node.addEventListener('click', click);
    return () => node.removeEventListener('click', click);
  },
  frame: none,
};
