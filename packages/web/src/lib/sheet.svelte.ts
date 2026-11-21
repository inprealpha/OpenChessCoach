// The panel of a phone's board frame as a sheet (docs/design/interface-guidelines.md, Phone): under
// the board it shows its first lines; pulled up it takes the height and the board shrinks to a strip
// that a tap brings back. Only a phone held upright has the sheet: a
// desktop's panel sits beside the board, and a phone on its side scrolls as a page.
// One sheet for the app, as one board screen shows at a time: its handle lets it down as a screen
// opens, and the Coach's Ask box pulls it up for the answer on every screen.
import type { Attachment } from 'svelte/attachments';
import { driver } from './sheet-variants/index.ts';

const query = typeof matchMedia === 'function' ? matchMedia('(max-width: 820px) and (min-height: 560px)') : null;

export class Sheet {
  #full = $state(false);
  /** The frame has a sheet: a phone held upright. */
  on = $state(query?.matches ?? false);
  /** PROTOTYPE (#80): told of every change of `full`, so a version can animate the moves the app makes itself. */
  // Not state: nothing renders from the listeners themselves.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #listeners = new Set<(full: boolean) => void>();

  constructor() {
    query?.addEventListener('change', (e) => {
      this.on = e.matches;
      if (!e.matches) this.full = false;
    });
  }

  /** Pulled up: the panel takes the height and the board is a strip. */
  get full(): boolean {
    return this.#full;
  }

  set full(value: boolean) {
    if (value === this.#full) return;
    this.#full = value;
    for (const listen of this.#listeners) listen(value);
  }

  /** PROTOTYPE (#80): calls `listen` on every change of `full`; returns what stops it. */
  listen(listen: (full: boolean) => void): () => void {
    this.#listeners.add(listen);
    return () => this.#listeners.delete(listen);
  }

  /** Pulled up where the frame has a sheet: what a screen's class follows. */
  get shown(): boolean {
    return this.on && this.full;
  }

  toggle(): void {
    this.full = !this.full;
  }

  /** Pulls the sheet up where there is one, such as for the Coach's answer. */
  pullUp(): void {
    if (this.on) this.full = true;
  }

  // PROTOTYPE (#80): each hook hands its element to the version this page load uses (lib/sheet-variants/).
  /** On the panel's scrolling body. */
  readonly gestures: Attachment<HTMLElement> = (node) => driver.panel(this, node);
  /** On the grab handle's button. */
  readonly handle: Attachment<HTMLElement> = (node) => driver.handle(this, node);
  /** On the board strip's button. */
  readonly strip: Attachment<HTMLElement> = (node) => driver.strip(this, node);
  /** On the screen's `.board-screen` section. */
  readonly frame: Attachment<HTMLElement> = (node) => driver.frame(this, node);
}

export const sheet = new Sheet();
