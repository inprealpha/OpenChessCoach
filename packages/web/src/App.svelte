<script lang="ts">
  import { api } from './lib/api.svelte.ts';
  import { lessonCatalogue } from './lib/content.ts';
  import { pageTitle } from './lib/page-title.svelte.ts';
  import { profile } from './lib/profile.svelte.ts';
  import { router } from './lib/router.svelte.ts';
  import Pair from './screens/Pair.svelte';
  import Menu from './screens/Menu.svelte';
  import BoardScreen from './screens/BoardScreen.svelte';
  import FirstRun from './screens/FirstRun.svelte';
  import Profile from './screens/Profile.svelte';
  import Settings from './screens/Settings.svelte';
  import Learn from './screens/Learn.svelte';
  import Lessons from './screens/Lessons.svelte';
  import Lesson from './screens/Lesson.svelte';
  import Puzzles from './screens/Puzzles.svelte';
  import Games from './screens/Games.svelte';
  import Review from './screens/Review.svelte';
  import EngineGame from './screens/EngineGame.svelte';
  import PlayOut from './screens/PlayOut.svelte';
  import { syncOfflineGames } from './lib/offline.ts';
  import { engineStatus } from './lib/engine/engine.svelte.ts';

  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') {
      void profile.load();
      void syncOfflineGames();
    } else if (api.state === 'offline' && !profile.loaded) void profile.load();
  });

  const route = $derived(router.route);
  const needsFirstRun = $derived(profile.loaded && profile.profile !== null && !profile.profile.onboarded);

  /** Each screen's name in the page title, so tabs, history and screen readers tell them apart. */
  const TITLES: Record<string, string> = {
    'first-run': 'Welcome',
    board: 'Board',
    profile: 'Player Profile',
    settings: 'Settings',
    learn: 'Learn',
    lessons: 'Lessons',
    lesson: 'Lesson',
    'play-out': 'Play it out',
    puzzles: 'Puzzles',
    games: 'Your games',
    review: 'Review',
    'engine-game': 'Engine Game',
  };
  /** The screen's name, or what it shows: "Lesson: Italian Game", or a Review's game (`titleFrom`). */
  function screenTitle(): string | undefined {
    if (api.state === 'unpaired') return 'Pair this device';
    if (needsFirstRun && route.name === '') return TITLES['first-run'];
    if (pageTitle.text) return pageTitle.text;
    // Own names only: `#/constructor` must not find Object's.
    const name = Object.hasOwn(TITLES, route.name) ? TITLES[route.name] : undefined;
    const lesson = (route.name === 'lesson' || route.name === 'puzzles') && lessonCatalogue.find((l) => l.id === route.params[0]);
    return lesson ? `${name}: ${lesson.name}` : name;
  }
  $effect(() => {
    const name = screenTitle();
    document.title = name ? `${name} · OpenChessCoach` : 'OpenChessCoach';
  });
</script>

<header class="top">
  <a href="#/" class="brand">OpenChessCoach</a>
  <div class="end">
    <span class="conn {api.state}" role="status" aria-label="Connection">
      <span class="conn-text">{#if api.state === 'online'}Desktop connected{:else if api.state === 'offline'}Desktop offline{:else if api.state === 'unpaired'}Not paired{:else}Connecting…{/if}</span>
    </span>
    {#if api.state !== 'unpaired'}
      <!-- Settings and the Player Profile, on every screen once the device is paired. -->
      <a href="#/profile" class="icon" aria-label="Player Profile" title="Player Profile" aria-current={route.name === 'profile' ? 'page' : undefined}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5" />
        </svg>
      </a>
      <a href="#/settings" class="icon" aria-label="Settings" title="Settings" aria-current={route.name === 'settings' ? 'page' : undefined}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </a>
    {/if}
  </div>
</header>

{#if engineStatus.error}<p class="engine-error error" role="alert">{engineStatus.error}</p>{/if}

<main>
  {#if api.state === 'unpaired'}
    <Pair />
  {:else if api.state === 'starting'}
    <p class="screen muted">Connecting to your desktop…</p>
  {:else if route.name === 'first-run' || (needsFirstRun && route.name === '')}
    <FirstRun />
  {:else if route.name === 'board'}
    <BoardScreen fen={route.query.fen} />
  {:else if route.name === 'profile'}
    <Profile />
  {:else if route.name === 'settings'}
    <Settings />
  {:else if route.name === 'learn'}
    <Learn />
  {:else if route.name === 'lessons'}
    <Lessons />
  {:else if route.name === 'lesson'}
    {#key route.params[0]}<Lesson lessonId={route.params[0] ?? ''} />{/key}
  {:else if route.name === 'play-out'}
    {#key route.params[0]}<PlayOut lessonId={route.params[0] ?? ''} />{/key}
  {:else if route.name === 'puzzles'}
    {#key route.params.join('/')}<Puzzles opening={route.params[0]} />{/key}
  {:else if route.name === 'games'}
    {#key route.params[0]}<Games startImport={route.params[0] === 'import'} />{/key}
  {:else if route.name === 'review'}
    {#key route.params[0]}<Review gameId={Number(route.params[0])} />{/key}
  {:else if route.name === 'engine-game'}
    <EngineGame />
  {:else}
    <Menu />
  {/if}
</main>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.9rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .engine-error { margin: 0; padding: 0.5rem 0.9rem; border-bottom: 1px solid var(--line); }
  .brand { font-weight: 700; text-decoration: none; color: var(--text); }
  .end { display: flex; align-items: center; gap: 0.35rem; }
  .conn { font-size: 0.8rem; color: var(--muted); margin-right: 0.4rem; white-space: nowrap; }
  /* On a narrow phone the dot alone says it; the words stay for screen readers. */
  @media (max-width: 400px) {
    .conn-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
  .icon { display: inline-flex; padding: 0.35rem; border-radius: 8px; color: var(--muted); }
  .icon:hover, .icon[aria-current='page'] { color: var(--accent); background: var(--bg); }
  .conn.online::before { content: '● '; color: #2e9b47; }
  .conn.offline::before { content: '● '; color: #c27c00; }
  .conn.unpaired::before { content: '● '; color: #a12020; }
</style>
