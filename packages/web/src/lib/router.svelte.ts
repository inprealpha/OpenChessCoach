// A tiny hash router: #/menu, #/lesson/italian-game, #/review/12, #/board?fen=… ...
import { parseRoute, type Route } from './route.ts';

export type { Route };

class Router {
  route = $state<Route>(parseRoute(location.hash));
  constructor() {
    window.addEventListener('hashchange', () => {
      const next = parseRoute(location.hash);
      // Another screen opens at its top, not at the scroll position of the one before. A screen
      // that keeps its own place, such as the game list, scrolls there once it has loaded.
      if (next.name !== this.route.name || next.params.join('/') !== this.route.params.join('/')) scrollTo(0, 0);
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
