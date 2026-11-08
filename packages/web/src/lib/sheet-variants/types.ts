// PROTOTYPE (#80): what each version of the phone's panel sheet provides. A version owns the
// sheet's gestures and motion through these attachments, and its own CSS scoped under
// `:root[data-sheet="vN"]` (src/sheet-vN.css). Screens and components only call the hooks.
import type { Sheet } from '../sheet.svelte.ts';

/** Attaches to an element and returns what removes it again. */
export type SheetHook = (sheet: Sheet, node: HTMLElement) => () => void;

export interface SheetDriver {
  /** The panel's scrolling body (`.panel-body`): swipes in it. */
  panel: SheetHook;
  /** The grab handle's button: taps and drags on it. Owns its click, too. */
  handle: SheetHook;
  /** The board strip's button while the sheet is up: a tap brings the board back. */
  strip: SheetHook;
  /** The screen's `.board-screen` section: for motion of the whole frame (the board and the sheet). */
  frame: SheetHook;
}

export const none = () => () => undefined;
