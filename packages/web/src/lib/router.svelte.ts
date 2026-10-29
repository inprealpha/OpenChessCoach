// A tiny hash router: #/menu, #/lesson/italian-game, #/review/12, #/board?fen=… ...
import { parseRoute, type Route } from './route.ts';

export type { Route };

/** The state of a step in the history the Player has been on. */
const VISITED = { visited: true };

class Router {
  route = $state<Route>(parseRoute(location.hash));
  constructor() {
    if (history.state === null) history.replaceState(VISITED, '');
    window.addEventListener('hashchange', () => {
      const next = parseRoute(location.hash);
      // A new step in the history has no state until the router marks it. Back and Forward return
      // to a marked step, where the browser puts back the place the Player had scrolled to.
      const fresh = history.state === null;
      if (fresh) history.replaceState(VISITED, '');
      // Another screen opens at its top, not at the scroll position of the one before. A screen
      // that keeps its own place, such as the game list, scrolls there once it has loaded.
      if (fresh && (next.name !== this.route.name || next.params.join('/') !== this.route.params.join('/'))) scrollTo(0, 0);
      this.route = next;
    });
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
