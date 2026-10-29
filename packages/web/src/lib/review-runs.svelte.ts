// Reviews this device asked the desktop to make, kept outside the Review screen: a Player who
// leaves while one is being made and comes back finds it still going, with its progress, and the
// screen follows it to the end without asking the desktop again. A dropped connection doesn't
// lose it either: the request is made again once the desktop is back. A reload forgets these, but
// the desktop goes on making the Review and says so, and the screen asks again to join it.
import type { Review } from '@chess-coach/shared/protocol';
import { api, ApiError } from './api.svelte.ts';

/** How many dropped connections one Review rides out before it gives up. */
const RETRIES = 5;

/** Whether a request failed because the connection to the desktop dropped. */
export function droppedConnection(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'offline';
}

/**
 * Resolves once the desktop can be reached again. The short wait first lets a connection that is
 * closing finish closing, so a caller retrying in a loop never spins.
 */
export async function desktopBack(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await api.whenOnline();
}

export class ReviewRun {
  /** Grading every move on the desktop's Engine, then the Coach writing the overview and explaining the key moments. */
  phase = $state<'grading' | 'explaining'>('grading');
  progress = $state({ done: 0, total: 0 });
  /** The Coach's overview of the whole game, as it is written; empty with the overview turned off. */
  overview = $state('');
  /** The Coach's explanation of each key moment, as it is written. */
  streaming = $state<string[]>([]);
  /** True while the connection to the desktop is down: the Review goes on once it is back. */
  interrupted = $state(false);
  readonly done: Promise<Review>;

  constructor(gameId: number, moves: number) {
    this.progress = { done: 0, total: moves };
    this.done = this.make(gameId);
    // Forgotten once finished either way: the desktop has saved it, or it can be started again.
    const forget = () => void runs.delete(gameId);
    this.done.then(forget, forget);
  }

  private async make(gameId: number): Promise<Review> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.request(
          'review.start',
          { gameId },
          (text, part) => {
            this.phase = 'explaining';
            if (part === 'overview') {
              this.overview += text;
              return;
            }
            const i = part ?? 0;
            const next = [...this.streaming];
            next[i] = (next[i] ?? '') + text;
            this.streaming = next;
          },
          // The desktop reports positions analysed; a move is graded once the position after it is.
          (done, total) => {
            this.progress = { done: Math.max(0, done - 1), total: total - 1 };
            if (done === total) this.phase = 'explaining';
          },
        );
      } catch (err) {
        if (!droppedConnection(err) || attempt >= RETRIES) throw err;
        this.interrupted = true;
        await desktopBack();
        this.interrupted = false;
        // Asked again, the desktop returns the Review it finished meanwhile, joins the one it is
        // still making from where it has got to, or starts over if it was restarted.
        this.overview = '';
        this.streaming = [];
      }
    }
  }
}

// A plain registry, not state: the screen renders from each run, never from the map.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const runs = new Map<number, ReviewRun>();

/** The Review of a game this device is waiting for, if any. */
export function runningReview(gameId: number): ReviewRun | undefined {
  return runs.get(gameId);
}

/** Asks the desktop for a game's Review, or returns the request already waiting for it. */
export function startReview(gameId: number, moves: number): ReviewRun {
  let run = runs.get(gameId);
  if (!run) runs.set(gameId, (run = new ReviewRun(gameId, moves)));
  return run;
}
