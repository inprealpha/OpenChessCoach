<script lang="ts">
  // The Lesson catalogue: openings by colour, then Themes and endgames, with each Lesson's progress
  // from the Player Profile.
  import type { LessonProgress } from '@chess-coach/shared/protocol';
  import { api } from '../lib/api.svelte.ts';
  import { lessonCatalogue, type CatalogueItem } from '../lib/content.ts';
  import { profile } from '../lib/profile.svelte.ts';

  let progress = $state<LessonProgress[]>(profile.profile?.lessons ?? []);

  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') {
      void api.request('lessons.progress', {}).then((r) => (progress = r.lessons)).catch(() => undefined);
    }
  });

  const sections: { title: string; items: CatalogueItem[] }[] = [
    { title: 'Openings for White', items: lessonCatalogue.filter((l) => l.kind === 'opening' && l.side === 'white') },
    { title: 'Defences for Black', items: lessonCatalogue.filter((l) => l.kind === 'opening' && l.side === 'black') },
    { title: 'Themes', items: lessonCatalogue.filter((l) => l.kind === 'theme') },
    { title: 'Endgames', items: lessonCatalogue.filter((l) => l.kind === 'endgame') },
  ];

  function status(id: string, total: number): string {
    const p = progress.find((x) => x.lessonId === id);
    if (!p) return 'Not started';
    if (p.completed) return 'Complete';
    return `${p.step} of ${total} decisions`;
  }
</script>

<section class="screen">
  <h1>Lessons</h1>
  <p class="muted">
    Each Lesson asks you to choose your moves: in an opening, in positions that show a Theme such as a fork or a pin, or in a basic endgame. The Engine
    grades each choice and the Coach explains it.
  </p>
  {#each sections as { title, items } (title)}
    <h2>{title}</h2>
    <ul class="list" aria-label={title}>
      {#each items as l (l.id)}
        <li>
          <a class="card item" href={`#/lesson/${l.id}`} aria-label={`${l.name}: ${status(l.id, l.decisions)}`}>
            <strong>{l.name}</strong>
            <span class="muted">{l.eco ? `${l.eco} · ` : ''}{l.decisions} decisions</span>
            <span class="progress" data-lesson={l.id}>{status(l.id, l.decisions)}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/each}
</section>

<style>
  h2 { font-size: 1.05rem; margin: 1rem 0 0.5rem; }
  .list { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .item { display: flex; flex-direction: column; gap: 0.25rem; text-decoration: none; color: var(--text); }
  .item:hover { border-color: var(--accent); }
  .progress { font-size: 0.85rem; font-weight: 600; }
</style>
