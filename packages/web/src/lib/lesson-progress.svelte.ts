// The Player's Lesson progress for a screen that shows it: the cached Player Profile's at first, then
// the desktop's, asked afresh whenever the desktop can be reached.
import type { LessonProgress } from '@chess-coach/shared/protocol';
import { api } from './api.svelte.ts';
import { profile } from './profile.svelte.ts';

/** Call it as the screen is created. */
export function lessonProgress(): { readonly list: LessonProgress[] } {
  let fetched = $state<LessonProgress[] | null>(null);
  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') {
      void api
        .request('lessons.progress', {})
        .then((r) => (fetched = r.lessons))
        .catch(() => undefined);
    }
  });
  return {
    get list() {
      return fetched ?? profile.profile?.lessons ?? [];
    },
  };
}

/** "Not started", "3 of 7 decisions" or "Complete": how far the Player got in a Lesson. */
export function lessonStatus(progress: readonly LessonProgress[], id: string, decisions: number): string {
  const p = progress.find((x) => x.lessonId === id);
  if (!p) return 'Not started';
  if (p.completed) return 'Complete';
  return `${p.step} of ${decisions} decisions`;
}
