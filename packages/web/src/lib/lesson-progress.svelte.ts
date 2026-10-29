// The Player's Lesson progress for a screen that shows it: the cached Player Profile's at first, then
// the desktop's, asked afresh whenever the desktop can be reached. Progress saved while the desktop
// can't be reached is kept on this device, shown in the lists with the rest, and sent to the desktop
// once it is back (ADR 0003: the desktop's database stays the single source of truth).
import type { LessonProgress } from '@chess-coach/shared/protocol';
import { api } from './api.svelte.ts';
import { profile } from './profile.svelte.ts';
import { store } from './storage.ts';

const UNSENT = 'lessonProgressUnsent';

/** Progress the desktop hasn't taken yet, one entry per Lesson. Raw, not reactive inside: IndexedDB can't store a reactive proxy. */
let unsent = $state.raw<LessonProgress[]>([]);
const loaded = store.get<LessonProgress[]>(UNSENT).then((list) => {
  unsent = list ?? [];
});

async function keepUnsent(list: LessonProgress[]): Promise<void> {
  unsent = list;
  await store.set(UNSENT, list);
}

/** Saves a Lesson's progress on the desktop, or keeps it on this device until the desktop is back. */
export async function saveLessonProgress(lessonId: string, step: number, completed: boolean): Promise<void> {
  await loaded;
  // A Lesson finished while the desktop was away stays finished.
  const done = completed || unsent.some((p) => p.lessonId === lessonId && p.completed);
  const others = unsent.filter((p) => p.lessonId !== lessonId);
  if (api.state === 'online') {
    try {
      await api.request('lessons.update', { lessonId, step, completed: done });
      await keepUnsent(others);
      return;
    } catch {
      // kept on this device below
    }
  }
  // A timestamp, never changed: nothing reactive.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const updatedAt = new Date().toISOString();
  await keepUnsent([...others, { lessonId, step, completed: done, updatedAt }]);
}

let syncing: Promise<void> | undefined;

/**
 * Sends the progress kept on this device to the desktop, where it is further than the desktop's own:
 * a Lesson played on another device in the meantime is never moved back.
 */
export function syncLessonProgress(): Promise<void> {
  syncing ??= (async () => {
    await loaded;
    if (!unsent.length || api.state !== 'online') return;
    try {
      const { lessons } = await api.request('lessons.progress', {});
      for (const p of unsent) {
        const d = lessons.find((l) => l.lessonId === p.lessonId);
        if (!d || (p.completed && !d.completed) || p.step > d.step) await api.request('lessons.update', { lessonId: p.lessonId, step: p.step, completed: p.completed });
        await keepUnsent(unsent.filter((x) => x !== p));
      }
    } catch {
      // kept for the next time the desktop is back
    }
  })().finally(() => (syncing = undefined));
  return syncing;
}

/** Progress from the desktop (or its cached copy) with what this device hasn't sent yet. */
function withUnsent(list: readonly LessonProgress[]): LessonProgress[] {
  if (!unsent.length) return [...list];
  const merged = list.map((p) => {
    const u = unsent.find((x) => x.lessonId === p.lessonId);
    return u ? { ...p, step: Math.max(p.step, u.step), completed: p.completed || u.completed, updatedAt: u.updatedAt } : p;
  });
  return [...merged, ...unsent.filter((u) => !list.some((p) => p.lessonId === u.lessonId))];
}

/** Call it as the screen is created. */
export function lessonProgress(): { readonly list: LessonProgress[] } {
  let fetched = $state<LessonProgress[] | null>(null);
  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') {
      // Progress kept on this device goes first, so the desktop's answer includes it.
      void syncLessonProgress()
        .then(() => api.request('lessons.progress', {}))
        .then((r) => (fetched = r.lessons))
        .catch(() => undefined);
    }
  });
  const list = $derived(withUnsent(fetched ?? profile.profile?.lessons ?? []));
  return {
    get list() {
      return list;
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
