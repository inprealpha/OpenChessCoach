// A tiny hash router: #/menu, #/lesson/italian-game, #/review/12, #/board?fen=… ...
import { tick } from 'svelte';
import { parseRoute, type Route } from './route.ts';

export type { Route };

/** The state of a step in the history the Player has been on: a key the router knows it by. */
interface Step {
  key: string;
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

/**
 * Where the Player had scrolled to on each step, kept for the tab's life so it outlasts a reload. Any
 * step's place can be written at any time, unlike a step's own state, which only the step showing can
 * change, and only so often.
 */
const savedPlaces = {
  get(key: string): number | undefined {
    try {
      const y = sessionStorage.getItem(`place:${key}`);
      return y === null ? undefined : Number(y);
    } catch {
      return undefined;
    }
  },
  set(key: string, y: number): void {
    try {
      sessionStorage.setItem(`place:${key}`, String(y));
    } catch {
      // kept in memory only
    }
  },
};

class Router {
  route = $state<Route>(parseRoute(location.hash));
  /** The step showing now. */
  #key: string;
  /** Where the Player had scrolled to on each step since the page loaded. */
  #places = new Map<string, number>();
  /** The place to put back on the step showing, once its screen has rendered. */
  #restore: number | undefined;
  /** Whether the step's screen is still loading its content (`loadsLater`). */
  #loading = false;
  /** Whether the step's place is kept as the Player scrolls (`opensAtTop` stops it). */
  #keeping = true;

  constructor() {
    this.#key = stepOf(history.state)?.key ?? markStep();
    // Back and Forward return to a step at the place the Player had scrolled to. The browser's own
    // restoring can't be relied on: it may put the place back on the screen still showing, and cut it
    // short when that screen is shorter. So the router keeps each step's place and scrolls there once
    // the step's screen has rendered its content.
    window.addEventListener('scroll', () => this.#remember(), { passive: true });
    window.addEventListener('hashchange', () => {
      const next = parseRoute(location.hash);
      const step = stepOf(history.state);
      const key = (this.#key = step?.key ?? markStep());
      this.#loading = false;
      this.#keeping = true;
      this.#restore = step ? (this.#places.get(key) ?? savedPlaces.get(key)) : undefined;
      const moved = next.name !== this.route.name || next.params.join('/') !== this.route.params.join('/');
      this.route = next;
      // A new step opens at the top of its screen, not at the scroll position of the one before.
      if (this.#restore !== undefined) {
        void tick().then(() => {
          if (key === this.#key && !this.#loading) this.#putBack();
        });
      } else if (moved) scrollTo(0, 0);
    });
  }

  /**
   * For a screen that loads its content later, called as it is created: the router neither puts back
   * nor keeps its place, which would be cut short, until the screen calls the function returned once
   * its content has rendered.
   */
  loadsLater(): () => void {
    const key = this.#key;
    this.#loading = true;
    return () => {
      if (key !== this.#key || !this.#loading) return;
      this.#loading = false;
      this.#putBack();
    };
  }

  /**
   * For a screen whose content from here on won't be there when the Player comes back to the step (a
   * Lesson past its intro reopens on its intro): the step reopens at the top, and the router keeps
   * no place on it until the step changes.
   */
  opensAtTop(): void {
    this.#keeping = false;
    this.#places.set(this.#key, 0);
    savedPlaces.set(this.#key, 0);
  }

  #putBack(): void {
    const y = this.#restore;
    this.#restore = undefined;
    if (y !== undefined) scrollTo(0, y);
  }

  /**
   * Keeps the place of the step showing. Not once its screen opens at the top, nor while its screen is
   * loading or its place is still to be put back, nor once the browser has moved to another step and
   * the router hasn't heard yet: the browser's own restoring may scroll then.
   */
  #remember(): void {
    const key = this.#key;
    if (!this.#keeping || this.#loading || this.#restore !== undefined || stepOf(history.state)?.key !== key) return;
    this.#places.set(key, scrollY);
    savedPlaces.set(key, scrollY);
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
