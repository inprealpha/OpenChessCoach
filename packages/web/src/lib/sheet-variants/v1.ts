// PROTOTYPE (#80): version 1 of the phone's panel sheet, "follows the finger, with a slide when let
// go": a drag moves the sheet by transforms alone, frame by frame, and every move slides
// (motion-v1.ts). Its CSS lives in src/sheet-v1.css, scoped under :root[data-sheet="v1"].
import { Motion, motions } from './motion-v1.ts';
import type { SheetDriver } from './types.ts';

/** The Motion of the board screen an element is on. */
const motionOf = (node: Element): Motion | undefined => {
  const frame = node.closest<HTMLElement>('.board-screen');
  return frame ? motions.get(frame) : undefined;
};

export const v1: SheetDriver = {
  /** A wheel turned down at rest pulls the sheet up, as a swipe up does. */
  panel: (sheet, node) => {
    const wheel = (e: WheelEvent) => {
      if (sheet.on && !sheet.full && e.deltaY > 0) sheet.full = true;
    };
    node.addEventListener('wheel', wheel, { passive: true });
    return () => node.removeEventListener('wheel', wheel);
  },

  /** A tap toggles the sheet, sliding; a drag drags it (a touch through the frame, a mouse here). */
  handle: (sheet, node) => {
    let mouse = false;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      mouse = true;
      node.setPointerCapture(e.pointerId);
      motionOf(node)?.press(e.clientX, e.clientY, node);
    };
    const move = (e: PointerEvent) => {
      if (mouse) motionOf(node)?.move(e.clientX, e.clientY, e);
    };
    const up = (e: PointerEvent) => {
      if (!mouse) return;
      mouse = false;
      motionOf(node)?.release(e.timeStamp);
    };
    const click = (e: MouseEvent) => {
      // A keyboard's Enter or Space (no pointer, detail 0) always toggles; a drag's click never does.
      if (e.detail !== 0 && motionOf(node)?.swallows()) return;
      sheet.toggle();
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

  /** A tap on the strip brings the board back full size, sliding. */
  strip: (sheet, node) => {
    const click = () => (sheet.full = false);
    node.addEventListener('click', click);
    return () => node.removeEventListener('click', click);
  },

  /**
   * The screen: its sheet's Motion, the touches on the sheet, every change of `full` the app makes
   * and the keyboard coming and going (the Ask box's `typing`, CoachPanel.svelte).
   */
  frame: (sheet, frame) => {
    const motion = new Motion(sheet, frame);
    motions.set(frame, motion);
    // A screen opens with its sheet down, as drawn: nothing slides before its first frame.
    const first = requestAnimationFrame(() => requestAnimationFrame(() => (motion.ready = true)));
    const unlisten = sheet.listen((full) => motion.go('full', full));

    const onSheet = (e: TouchEvent) => e.target instanceof Element && Boolean(e.target.closest('.side.panel'));
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        // A second finger: the sheet goes where it is, and the rest of this touch is nobody's.
        motion.release(e.timeStamp, true);
        return;
      }
      const t = e.touches[0]!;
      if (onSheet(e)) motion.press(t.clientX, t.clientY, e.target as Element);
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t && e.touches.length === 1) motion.move(t.clientX, t.clientY, e);
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length === 0) motion.release(e.timeStamp);
    };
    // A drag that ended on a button doesn't press it.
    const click = (e: MouseEvent) => {
      if (e.detail !== 0 && motion.swallows() && e.target instanceof Element && e.target.closest('.side.panel')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const turned = () => motion.stop();

    // The keyboard: the Ask box's `typing` class shrinks the board to a strip (app.css), and back.
    const watched = new WeakSet<Element>();
    const typing = new MutationObserver((records) => {
      for (const r of records) {
        const input = r.target as Element;
        const now = input.classList.contains('typing');
        if (now === (r.oldValue ?? '').split(/\s+/).includes('typing')) continue;
        if (!sheet.full) motion.go('typing', now);
      }
    });
    const focus = (e: FocusEvent) => {
      const input = e.target instanceof Element ? e.target.closest('.coach input') : null;
      if (!input || watched.has(input)) return;
      watched.add(input);
      typing.observe(input, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    };

    frame.addEventListener('touchstart', start, { passive: true });
    frame.addEventListener('touchmove', move, { passive: false });
    frame.addEventListener('touchend', end, { passive: true });
    frame.addEventListener('touchcancel', end, { passive: true });
    frame.addEventListener('click', click, { capture: true });
    frame.addEventListener('focusin', focus, { capture: true });
    addEventListener('resize', turned);
    return () => {
      cancelAnimationFrame(first);
      unlisten();
      typing.disconnect();
      frame.removeEventListener('touchstart', start);
      frame.removeEventListener('touchmove', move);
      frame.removeEventListener('touchend', end);
      frame.removeEventListener('touchcancel', end);
      frame.removeEventListener('click', click, { capture: true });
      frame.removeEventListener('focusin', focus, { capture: true });
      removeEventListener('resize', turned);
      motion.detach();
      motions.delete(frame);
    };
  },
};
