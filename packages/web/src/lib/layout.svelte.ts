// Five trial layouts of the board frame, to compare on a real phone before one is chosen (the
// owner's sign-off), switched in Settings so the switch costs the board screens no room. The
// choice is kept on this device, read synchronously before the first paint, and set on <html> as
// `data-layout`, which `layouts.css` keys every trial's rules on. "current" is the frame as
// released in 0.5.1, which the journeys and the guidelines describe.

export const LAYOUTS = ['current', 'doop', 'rail', 'dock', 'focus', 'peek'] as const;
export type Layout = (typeof LAYOUTS)[number];

export const LAYOUT_TEXT: Record<Layout, { name: string; detail: string }> = {
  current: { name: '0.5.1 (as released)', detail: 'The frame as it shipped: the board sized to leave the panel room.' },
  doop: { name: '1 · Doop, as drawn', detail: 'The full-width board, the step bar under it, tabs and the Ask box in the sheet.' },
  rail: { name: '2 · Side rail', detail: 'The step buttons in a column right of the board, so the panel gets the bar’s row.' },
  dock: { name: '3 · Thumb dock', detail: 'Steps, tools and Ask in one bar at the foot of the screen; the Ask box opens on demand.' },
  focus: { name: '4 · One header', detail: 'The app’s header and the screen’s line merged, a thin Winning Chances line, a compact bar.' },
  peek: { name: '5 · Board first', detail: 'Board and bar only, with one line of the panel; the tabs and the Ask box open on demand.' },
};

const KEY = 'layout';

function read(): Layout {
  try {
    const v = localStorage.getItem(KEY);
    return (LAYOUTS as readonly string[]).includes(v ?? '') ? (v as Layout) : 'current';
  } catch {
    return 'current';
  }
}

class LayoutChoice {
  value = $state<Layout>(read());

  constructor() {
    this.apply();
  }

  /** The Ask box opens on demand from a button in the board's bar, rather than sitting docked. */
  get askOnDemand(): boolean {
    return this.value === 'dock' || this.value === 'peek';
  }

  /** A trial layout, not the released frame. */
  get trial(): boolean {
    return this.value !== 'current';
  }

  set(next: Layout): void {
    this.value = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage is blocked: the layout still changes, it just isn't remembered.
    }
    this.apply();
  }

  private apply(): void {
    if (typeof document === 'undefined') return;
    if (this.value === 'current') delete document.documentElement.dataset.layout;
    else document.documentElement.dataset.layout = this.value;
  }
}

export const layout = new LayoutChoice();
