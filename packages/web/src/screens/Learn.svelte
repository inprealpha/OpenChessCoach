<script lang="ts">
  // Learn: the Lessons and the Puzzles that practise them, one choice on the main menu, with the
  // suggested next Lesson a click away.
  import { suggestNext } from '@chess-coach/shared/content/course';
  import { lessonCatalogue } from '../lib/content.ts';
  import { lessonProgress } from '../lib/lesson-progress.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';

  const entries = [
    {
      href: '#/lessons',
      title: 'Lessons',
      text: 'From your first moves to club level, in four tracks: Themes, endgames, openings, and how to think during a game. Choose moves and the Coach explains each choice.',
    },
    { href: '#/puzzles', title: 'Puzzles', text: 'Find the strongest move in positions from real games, picked near your level.' },
  ];

  const progress = lessonProgress();
  const suggestion = $derived(suggestNext(lessonCatalogue, progress.list, profile.profile?.level ?? 'beginner'));
</script>

<section class="screen learn">
  <h1>Learn</h1>
  <nav aria-label="Learn">
    <ul>
      {#each entries as e (e.href)}
        <li>
          <a class="card entry" href={e.href}>
            <h2>{e.title}</h2>
            <span class="muted">{e.text}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>
  {#if suggestion}
    <p class="next">
      Suggested next Lesson: <a href={`#/lesson/${suggestion.lesson.id}`}>{suggestion.lesson.name}</a>
    </p>
  {/if}
</section>

<style>
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.8rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (max-width: 760px) { ul { grid-template-columns: 1fr; } }
  .entry { display: flex; flex-direction: column; gap: 0.2rem; text-decoration: none; color: var(--text); height: 100%; padding: 1.1rem 1.25rem; }
  .entry:hover { border-color: var(--accent); }
  h2 { font-size: 1.25rem; margin: 0 0 0.3rem; }
  .next { margin: 1rem 0 0; }
</style>
