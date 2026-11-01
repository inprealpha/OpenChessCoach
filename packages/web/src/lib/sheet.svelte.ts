// The panel of a phone's board frame as a sheet (docs/design/interface-guidelines.md, Phone): under
// a full-width board it shows its first lines; pulled up, or scrolled, it takes the height and the
// board shrinks to a strip beside the board bar, which a tap brings back. Only a phone held upright
// has the sheet: a desktop's panel sits beside the board, and a phone on its side scrolls as a page.
import type { Attachment } from 'svelte/attachments';
import { afterSwipe } from './swipe.ts';

const QUERY = '(max-width: 820px) and (min-height: 560px)';

export class Sheet {
  /** Pulled up: the panel takes the height and the board is a strip. */
  full = $state(false);
  /** The frame has a sheet: a phone held upright. */
  on = $state(typeof matchMedia === 'function' && matchMedia(QUERY).matches);

  constructor() {
    if (typeof matchMedia !== 'function') return;
    matchMedia(QUERY).addEventListener('change', (e) => {
      this.on = e.matches;
      if (!e.matches) this.full = false;
    });
  }

  toggle(): void {
    this.full = !this.full;
  }

  /**
   * On the panel's scrolling body: a swipe up in it pulls the sheet up before the rest scrolls, and
   * a pull down at its top lets it back down. A wheel turned down does as a swipe up.
   */
  readonly gestures: Attachment<HTMLElement> = (node) => {
    let startY: number | null = null;
    let startTop = 0;
    const start = (e: TouchEvent) => {
      startY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
      startTop = node.scrollTop;
    };
    const move = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (!this.on || startY === null || y === undefined) return;
      const next = afterSwipe(this.full, y - startY, Math.min(startTop, node.scrollTop));
      if (next === this.full) return;
      this.full = next;
      // One change per swipe: the rest of it scrolls the panel.
      startY = null;
    };
    const end = () => (startY = null);
    const wheel = (e: WheelEvent) => {
      if (this.on && !this.full && e.deltaY > 0) this.full = true;
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
  };
}
