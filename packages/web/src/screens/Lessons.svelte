<script lang="ts">
  // The Lessons (ADR 0012): the Player's next Lesson first, then the four tracks, each by level in
  // the course order, with each Lesson's progress from the Player Profile. Nothing is locked: the
  // next Lesson only says where to go next. With about sixty Lessons, links at the top jump to a track.
  import { SIDE_NAMES } from '@chess-coach/shared/chess';
  import { LEVEL_NAMES, suggestNext, TRACK_NAMES, type CatalogueItem, type Suggestion } from '@chess-coach/shared/content/course';
  import { COURSE_LEVELS, TRACKS, type Track } from '@chess-coach/shared/content/lessons';
  import { lessonCatalogue } from '../lib/content.ts';
  import { lessonProgress, lessonStatus } from '../lib/lesson-progress.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { router } from '../lib/router.svelte.ts';

  const progress = lessonProgress();
  const level = $derived(profile.profile?.level ?? 'beginner');
  const suggestion = $derived(suggestNext(lessonCatalogue, progress.list, level));

  const tracks = TRACKS.map((track) => {
    const items = lessonCatalogue.filter((l) => l.track === track);
    return {
      track,
      ...TRACK_NAMES[track],
      items,
      levels: COURSE_LEVELS.map((lv) => ({ level: lv, items: items.filter((l) => l.level === lv) })).filter((g) => g.items.length),
    };
  });

  const status = (l: CatalogueItem) => lessonStatus(progress.list, l.id, l.decisions);
  const completeIn = (items: CatalogueItem[]) => items.filter((l) => progress.list.some((p) => p.lessonId === l.id && p.completed)).length;

  /** "Opening code C54 · as White · 7 decisions": an opening's code and colour, then how many choices the Lesson asks for. */
  function about(l: CatalogueItem): string {
    const opening = l.kind === 'opening' ? [l.eco && `Opening code ${l.eco}`, `as ${SIDE_NAMES[l.side]}`].filter(Boolean) : [];
    return [...opening, `${l.decisions} decisions`].join(' · ');
  }

  /** One line on why this Lesson comes next. */
  function because(s: Suggestion): string {
    const { lesson: l } = s;
    if (s.why === 'unfinished') {
      const p = progress.list.find((x) => x.lessonId === l.id);
      return `You started this Lesson and have made ${p?.step ?? 0} of its ${l.decisions} decisions.`;
    }
    if (s.why === 'first') return level !== 'beginner' && l.level !== 'beginner' ? 'Start here. At your level you can skip the beginner Lessons.' : 'Start here.';
    if (s.why === 'ready') return 'You have done the Lessons it builds on.';
    return 'It comes next in the order of the Lessons.';
  }

  /** Brings a track's heading into view and gives it the focus, so the keyboard carries on from there. */
  function jump(track: Track): void {
    const heading = document.getElementById(`track-${track}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }

  // A link with a track (`#/lessons?track=endgames`) opens at that track.
  $effect(() => {
    const track = router.route.query.track;
    if (track && (TRACKS as readonly string[]).includes(track)) jump(track as Track);
  });
</script>

<section class="screen">
  <h1>Lessons</h1>
  <p class="muted intro">
    From your first moves to the end of intermediate level, in four tracks. Open any Lesson at any time. In each one you choose moves, the Engine grades each choice and the Coach
    explains it.
  </p>

  <div class="top">
    <section class="card next" aria-labelledby="next-heading">
      <h2 id="next-heading">Your next Lesson</h2>
      {#if suggestion}
        {@const s = suggestion.lesson}
        <h3>{s.name}</h3>
        <p class="muted small">{TRACK_NAMES[s.track].name} · {LEVEL_NAMES[s.level]}{s.kind === 'opening' ? ` · ${about(s)}` : ''}</p>
        {#if s.goal}<p>{s.goal}</p>{/if}
        <p class="why">{because(suggestion)}</p>
        <a class="button" href={`#/lesson/${s.id}`}>{suggestion.why === 'unfinished' ? 'Resume' : 'Start'} {s.name}</a>
      {:else}
        <p>You have done every Lesson. Go over any of them again, or practise with <a href="#/puzzles">Puzzles</a>.</p>
      {/if}
    </section>

    <nav class="jump" aria-label="Tracks">
      <ul>
        {#each tracks as t (t.track)}
          <li>
            <a href={`#/lessons?track=${t.track}`} onclick={(e) => { e.preventDefault(); jump(t.track); }}>
              <strong>{t.name}</strong>
              <span class="muted small">{t.items.length ? `${completeIn(t.items)} of ${t.items.length} complete` : 'No Lessons yet'}</span>
            </a>
          </li>
        {/each}
      </ul>
    </nav>
  </div>

  {#each tracks as t (t.track)}
    <section class="track" aria-labelledby={`track-${t.track}`}>
      <h2 id={`track-${t.track}`} tabindex="-1">{t.name}</h2>
      <p class="muted">{t.text}</p>
      {#each t.levels as g (g.level)}
        <h3>{LEVEL_NAMES[g.level]}</h3>
        <ul class="list" aria-label={`${t.name}, ${LEVEL_NAMES[g.level]}`}>
          {#each g.items as l (l.id)}
            {@const st = status(l)}
            <li>
              <a class="card item" href={`#/lesson/${l.id}`} aria-label={`${l.name}: ${st}`}>
                <strong>{l.name}</strong>
                {#if l.goal}<span class="goal">{l.goal}</span>{/if}
                <span class="foot">
                  <span class="muted small">{about(l)}</span>
                  <span class="progress" class:complete={st === 'Complete'} class:started={st !== 'Complete' && st !== 'Not started'} data-lesson={l.id}>{st}</span>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">No Lessons in this track yet.</p>
      {/each}
    </section>
  {/each}
</section>

<style>
  .intro { max-width: 46rem; margin-top: -0.5rem; }
  .small { font-size: 0.85rem; }
  h2 { font-size: 1.15rem; margin: 0 0 0.3rem; }
  h3 { font-size: 1rem; margin: 0.9rem 0 0.5rem; }

  /* The next Lesson, then the tracks: beside it on a wide screen, under it otherwise. */
  .top { display: grid; gap: 0.75rem; margin: 1rem 0 0.5rem; }
  @media (min-width: 900px) { .top { grid-template-columns: minmax(0, 46rem) minmax(12rem, 1fr); } }
  .next { border: 2px solid var(--accent); display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; }
  .next h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0; }
  .next h3 { font-size: 1.25rem; margin: 0; }
  .next p { margin: 0; }
  .next .why { font-weight: 600; }
  .button {
    display: inline-block; background: var(--accent); color: var(--accent-text); border-radius: 8px; margin-top: 0.4rem;
    padding: 0.6rem 1.1rem; text-decoration: none; font-weight: 600; text-align: center;
  }
  .button:hover { filter: brightness(1.08); }

  .jump ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  @media (max-width: 760px) { .jump ul { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 900px) { .jump ul { grid-template-columns: 1fr; grid-auto-rows: 1fr; height: 100%; } }
  .jump a {
    display: flex; flex-direction: column; gap: 0.1rem; height: 100%; padding: 0.5rem 0.7rem;
    border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); text-decoration: none;
  }
  .jump a:hover { border-color: var(--accent); }

  .track { margin-top: 1.5rem; scroll-margin-top: 0.5rem; }
  .track > h2 { font-size: 1.25rem; scroll-margin-top: 0.75rem; }
  /* Focused by a jump link so the keyboard carries on from the track: a quiet ring, none after a click. */
  .track > h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  .track > h2:focus:not(:focus-visible) { outline: none; }
  .track > p { margin: 0 0 0.3rem; }
  .list { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .item { display: flex; flex-direction: column; gap: 0.25rem; height: 100%; text-decoration: none; color: var(--text); }
  .item:hover { border-color: var(--accent); }
  /* The goal in short: the Lesson's intro shows it whole. */
  .goal { font-size: 0.9rem; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  /* How long the Lesson is and how far the Player got, on one line under the goal. */
  .foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0 0.6rem; margin-top: auto; padding-top: 0.15rem; }
  .progress { font-size: 0.85rem; font-weight: 600; color: var(--muted); }
  .progress.started { color: var(--text); }
  .progress.complete { color: var(--accent); }
  .progress.complete::before { content: '✓ '; }
</style>
