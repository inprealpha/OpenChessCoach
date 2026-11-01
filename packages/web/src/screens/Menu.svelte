<script lang="ts">
  // The main menu: a Continue card that follows the Player (an Engine Game in progress, or their
  // next Lesson), then three equal choices, Learn, Play and Review your games, and a prompt to
  // import games while the Player has none (with a sample Review to try first). The Board, Settings
  // and the Player Profile are in the header. On a desktop without a phone paired, it asks the
  // Player to pair one (PhoneReminder).
  import { SIDE_NAMES } from '@chess-coach/shared/chess';
  import { suggestNext } from '@chess-coach/shared/content/course';
  import type { GameSummary } from '@chess-coach/shared/protocol';
  import PhoneReminder from '../components/PhoneReminder.svelte';
  import { ApiError, api } from '../lib/api.svelte.ts';
  import { gameInProgress, type GameInProgress } from '../lib/game-in-progress.ts';
  import { keptGames } from '../lib/kept-games.ts';
  import { lessonCatalogue } from '../lib/content.ts';
  import { lessonProgress } from '../lib/lesson-progress.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { router } from '../lib/router.svelte.ts';

  /**
   * Which games the Player has: none, only the sample game (which isn't theirs), or games of their
   * own; from the desktop, else from the list this device kept; null while unknown.
   */
  let games = $state<'none' | 'sample' | 'own' | null>(null);

  function whichGames(list: { games: GameSummary[]; total: number }): 'none' | 'sample' | 'own' {
    if (list.total === 0) return 'none';
    // There is only ever one sample game, so a second game is the Player's own.
    return list.total === 1 && list.games[0]?.source === 'sample' ? 'sample' : 'own';
  }

  async function checkForGames(): Promise<void> {
    if (api.state === 'online') {
      try {
        games = whichGames(await api.request('games.list', { limit: 1 }));
        return;
      } catch {
        // fall back to the list this device kept
      }
    }
    const kept = await keptGames();
    games = kept ? whichGames(kept) : null;
  }

  $effect(() => {
    void api.reconnects;
    void api.state;
    void checkForGames();
  });

  const offline = $derived(api.state === 'offline');
  /** Importing needs the desktop: offline, the import links are greyed out instead of leading to a screen where nothing works. */
  const importLink = $derived(
    offline ? { role: 'link', 'aria-disabled': 'true' as const } : { href: '#/games/import' },
  );

  /** The Engine Game this device has in progress, if any. */
  let inProgress = $state<GameInProgress | null>(null);
  $effect(() => {
    void gameInProgress().then((g) => (inProgress = g));
  });

  let trying = $state(false);
  let sampleError = $state('');

  /** Imports the sample game (once: a second try finds it) and opens its Review. */
  async function trySample(): Promise<void> {
    trying = true;
    sampleError = '';
    try {
      const { game } = await api.request('games.importSample', {});
      router.go(`review/${game.id}`);
    } catch (err) {
      sampleError = err instanceof ApiError ? err.message : 'The sample game could not be imported.';
    } finally {
      trying = false;
    }
  }

  const choices = [
    { href: '#/learn', title: 'Learn', text: 'Lessons on Themes, endgames, openings and how to think during a game, and Puzzles to practise them.', offline: true },
    { href: '#/engine-game', title: 'Play a game', text: 'An Engine Game at your strength, with Live Coaching and Hints.', offline: true },
    { href: '#/games', title: 'Review your games', text: 'The Coach walks you through the key moments of the games you played.', offline: false },
  ];

  const progress = lessonProgress();
  /** The Player's next Lesson: the one they left unfinished, else the next one for their level. */
  const nextLesson = $derived(suggestNext(lessonCatalogue, progress.list, profile.player));
</script>

<section class="screen menu">
  <h1 class="visually-hidden">Main menu</h1>
  {#if offline}
    <p class="card muted" role="note">Your desktop can’t be reached. The board, the Engine, Engine Games and bundled Lessons still work; Coach features are greyed out.</p>
  {/if}
  <nav aria-label="Main menu">
    <!-- One card that follows the Player: the game they left, or their next Lesson. -->
    {#if inProgress}
      <section class="card continue-card" aria-labelledby="continue-heading">
        <div>
          <h2 id="continue-heading">Continue</h2>
          <p class="muted">Your Engine Game: move {inProgress.moveNumber}, you play {SIDE_NAMES[inProgress.playerSide]}.</p>
        </div>
        <a class="button" href="#/engine-game">Continue your game</a>
      </section>
    {:else if nextLesson}
      <section class="card continue-card" aria-labelledby="continue-heading">
        <div>
          <h2 id="continue-heading">{nextLesson.why === 'unfinished' ? 'Continue' : 'Your next Lesson'}</h2>
          <p class="muted">{nextLesson.lesson.name}</p>
        </div>
        <a class="button" href={`#/lesson/${nextLesson.lesson.id}`}>{nextLesson.why === 'unfinished' ? 'Continue the Lesson' : 'Start the Lesson'}</a>
      </section>
    {/if}

    <ul class="choices">
      {#each choices as c (c.href)}
        <li class="card choice">
          <a class="main" href={c.href}>
            <h2>{c.title}</h2>
            <span class="muted">{c.text}</span>
          </a>
          {#if offline}
            <p class="small {c.offline ? 'works' : 'needs'}">{c.offline ? 'Works without your desktop' : 'Needs your desktop'}</p>
          {/if}
          {#if c.href === '#/games' && games === 'own'}
            <a class="button secondary more" class:disabled={offline} {...importLink}>Import more</a>
          {/if}
        </li>
      {/each}
    </ul>

    {#if games === 'none' || games === 'sample'}
      <section class="card import" aria-labelledby="import-heading">
        <div>
          <h2 id="import-heading">Import your games</h2>
          <p>Bring in the games you played on Lichess or chess.com, or paste a PGN, and get a Review of their key moments.</p>
          {#if offline}<p class="needs small">Needs your desktop</p>{/if}
        </div>
        <a class="button" class:disabled={offline} {...importLink}>Import your games</a>
        {#if games === 'none'}
          <div class="sample">
            <button type="button" class="secondary" onclick={trySample} disabled={offline || trying}>{trying ? 'Opening the sample…' : 'Try a sample Review'}</button>
            <span class="muted small">No games at hand? See a Review of a real game first.</span>
            {#if sampleError}<p class="error small" role="alert">{sampleError}</p>{/if}
          </div>
        {/if}
      </section>
    {/if}

  </nav>
  <PhoneReminder />
</section>

<style>
  .menu { display: flex; flex-direction: column; gap: 1rem; padding-top: 1.5rem; }
  nav { display: flex; flex-direction: column; gap: 1rem; }
  h2 { margin: 0 0 0.3rem; }
  .import {
    display: flex; flex-wrap: wrap; gap: 0.8rem 1.5rem; align-items: center; justify-content: space-between;
    border: 2px solid var(--accent); padding: 1.1rem 1.25rem;
  }
  .import h2 { font-size: 1.3rem; }
  .import p { margin: 0; }
  .import > div { flex: 1 1 20rem; }
  .button {
    display: inline-block; background: var(--accent); color: var(--accent-text); border-radius: 8px;
    padding: 0.6rem 1.1rem; text-decoration: none; font-weight: 600; text-align: center;
  }
  .button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; padding: 0.4rem 0.9rem; }
  .button:hover { filter: brightness(1.08); }
  .button.disabled { opacity: 0.5; cursor: not-allowed; filter: none; }
  .button.secondary:hover { border-color: var(--accent); }
  .choices { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.8rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 760px) { .choices { grid-template-columns: 1fr; } }
  .choice { display: flex; flex-direction: column; gap: 0.6rem; padding: 0 0 1.1rem; }
  .choice:hover { border-color: var(--accent); }
  .main { display: flex; flex-direction: column; flex: 1; gap: 0.2rem; padding: 1.1rem 1.25rem 0; text-decoration: none; color: var(--text); }
  @media (min-width: 761px) { .main { min-height: 7.5rem; } }
  .main h2 { font-size: 1.25rem; }
  .choice > p, .more { margin: 0 1.25rem; }
  .more { align-self: flex-start; }
  .small { font-size: 0.85rem; }
  .works::before { content: '● '; color: #2e9b47; }
  .needs::before { content: '● '; color: #c27c00; }
  .continue-card {
    display: flex; flex-wrap: wrap; gap: 0.6rem 1.5rem; align-items: center; justify-content: space-between;
    border: 2px solid var(--accent); padding: 1rem 1.25rem;
  }
  .continue-card p { margin: 0; }
  .continue-card h2 { font-size: 1.2rem; }
  .import > .sample { flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.8rem; }
  .sample .error { flex-basis: 100%; margin: 0; }
</style>
