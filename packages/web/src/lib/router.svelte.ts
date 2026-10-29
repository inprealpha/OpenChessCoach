// A tiny hash router: #/menu, #/lesson/italian-game, #/review/12, #/board?fen=… ...
import { tick } from 'svelte';
import { parseRoute, type Route } from './route.ts';

export type { Route };

/** The state of a step in the history the Player has been on: a key the router knows it by, and where it was scrolled to. */
interface Step {
  key: string;
  y?: number;
}

function stepOf(state: unknown): Step | undefined {
  return state !== null && typeof state === 'object' && typeof (state as Step).key === 'string' ? (state as Step) : undefined;
}

/** Marks the step the browser is on as one the router has seen, keeping anything else in its state. */
function markStep(): string {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  history.replaceState({ ...(history.state ?? {}), key }, '');
  return key;
}

const SAVE_DELAY_MS = 150;

class Router {
  route = $state<Route>(parseRoute(location.hash));
  /** The step showing now. */
  #key: string;
  /** Where the Player had scrolled to on each step since the page loaded. */
  #places = new Map<string, number>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.#key = stepOf(history.state)?.key ?? markStep();
    // Back and Forward return to a step at the place the Player had scrolled to. The browser's own
    // restoring can't be relied on: it may put the place back on the screen still showing, and cut it
    // short when that screen is shorter. So the router keeps each step's place, in memory and in the
    // step's own state (which outlasts a reload), and scrolls there once the step's screen has rendered.
    window.addEventListener('scroll', () => this.#remember(), { passive: true });
    window.addEventListener('hashchange', () => {
      const next = parseRoute(location.hash);
      const step = stepOf(history.state);
      clearTimeout(this.#saveTimer);
      this.#key = step?.key ?? markStep();
      const y = step ? (this.#places.get(step.key) ?? step.y) : undefined;
      const moved = next.name !== this.route.name || next.params.join('/') !== this.route.params.join('/');
      this.route = next;
      // A new step opens at the top of its screen, not at the scroll position of the one before. A
      // screen that loads its content later and keeps its own place, such as the game list, scrolls
      // there itself once it has loaded.
      if (y !== undefined) void tick().then(() => scrollTo(0, y));
      else if (moved) scrollTo(0, 0);
    });
  }

  /** Keeps the place of the step showing; the step's state follows once scrolling stops (browsers limit how often it can change). */
  #remember(): void {
    const key = this.#key;
    this.#places.set(key, scrollY);
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      if (stepOf(history.state)?.key === key) history.replaceState({ ...history.state, y: this.#places.get(key) }, '');
    }, SAVE_DELAY_MS);
  }

  go(path: string): void {
    location.hash = `#/${path}`;
  }
  /** Changes the address in place, with no new step in the history: a screen dropping a link it has opened. */
  replace(path: string): void {
    history.replaceState(history.state, '', `#/${path}`);
    this.route = parseRoute(location.hash);
  }
}

export const router = new Router();
