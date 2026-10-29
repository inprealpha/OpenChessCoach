<script module lang="ts">
  /** Where the list was when the Player opened a Review, so coming back shows the same games in the same place. */
  let returnTo = { shown: 0, scrollY: 0 };
</script>

<script lang="ts">
  // Imported Games and Engine Games in one list, with PGN paste and import by username.
  import { tick, untrack } from 'svelte';
  import { otherSide, SIDE_NAMES, type Side } from '@chess-coach/shared/chess';
  import { GAMES_LIST_MAX, GAMES_PAGE_SIZE, type GameSummary, type RatingSite } from '@chess-coach/shared/protocol';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { pendingGames } from '../lib/offline.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { keepGames, keptGames } from '../lib/kept-games.ts';
  import { router } from '../lib/router.svelte.ts';

  /** Opened from the main menu's Import your games or Import more (#/games/import): start at the username. */
  let { startImport = false }: { startImport?: boolean } = $props();
  let usernameInput = $state<HTMLInputElement | undefined>();
  $effect(() => {
    if (startImport && usernameInput) {
      usernameInput.focus();
      usernameInput.scrollIntoView({ block: 'center' });
    }
  });

  /** The games shown, newest first: a page at a time, so a whole history never comes at once. */
  let games = $state<GameSummary[]>([]);
  /** How many games the desktop has (or had, for the list this device kept). */
  let total = $state(0);
  let loadingMore = $state(false);
  /** Where the list came from: the desktop, this device's copy while the desktop is away, or not loaded yet. */
  let listFrom = $state<'desktop' | 'device' | null>(null);
  let pending = $state(0);
  let pgn = $state('');
  let needsSide = $state(false);
  /** The Player's side in the pasted game, once they pick it: never picked for them. */
  let side = $state<Side | null>(null);
  let sideQuestion = $state<HTMLFieldSetElement | undefined>();
  let site = $state<RatingSite>('lichess');
  let username = $state('');
  /** Set once the Player picks a Site or types a Username here: the linked account then stops filling them. */
  let accountTyped = false;
  // The linked account fills the import, also when the Player Profile arrives after the list opened.
  $effect(() => {
    const linked = profile.profile?.ratingSource;
    if (!linked || accountTyped) return;
    site = linked.site;
    username = linked.username;
  });
  let message = $state('');
  let error = $state('');
  let busy = $state(false);
  /** Games fetched so far by the import by username that is running, or null when none is. */
  let fetching = $state<number | null>(null);
  /** The game whose More menu is open. */
  let menuFor = $state<number | null>(null);
  /** Whether the open menu opens upwards, as on a phone's last row with no room below it. */
  let menuUp = $state(false);
  /** A change to a game that asks first: deleting it, or a side change that drops its Review. */
  let confirming = $state<{ game: GameSummary; action: 'delete' | 'side' } | null>(null);
  /** Why a change to a game was refused, shown by its row: the top of a long list is far off. */
  let refused = $state<{ gameId: number; text: string } | null>(null);
  let refusedLine = $state<HTMLParagraphElement | undefined>();
  let keepButton = $state<HTMLButtonElement | undefined>();

  /** Shows a list from the desktop and keeps a copy on this device for when it can't be reached. */
  async function show(list: GameSummary[], count: number): Promise<void> {
    games = list;
    total = count;
    listFrom = 'desktop';
    // The plain list, not the reactive one: IndexedDB can't store a reactive proxy.
    await keepGames(list, count);
  }

  /** Back from a Review: scrolls to where the list was. Opened to import, it stays at the username. */
  async function restoreScroll(): Promise<void> {
    const y = returnTo.scrollY;
    returnTo = { shown: 0, scrollY: 0 };
    if (!y || startImport) return;
    await tick();
    window.scrollTo(0, y);
  }

  /** Rereads the games shown (at least a page), plus `added` new ones that join the top of the list. */
  async function refresh(added = 0): Promise<void> {
    pending = (await pendingGames()).length;
    if (api.state === 'online') {
      try {
        const limit = Math.min(GAMES_LIST_MAX, Math.max(GAMES_PAGE_SIZE, untrack(() => games.length) + added, returnTo.shown));
        const r = await api.request('games.list', { limit });
        await show(r.games, r.total);
        await restoreScroll();
        return;
      } catch {
        // fall back to the cached list
      }
    }
    if (api.state === 'starting') return;
    const list = await keptGames();
    games = list?.games ?? [];
    total = list?.total ?? 0;
    listFrom = 'device';
    await restoreScroll();
  }

  /** Appends the next page of older games. */
  async function showMore(): Promise<void> {
    error = '';
    loadingMore = true;
    try {
      const shown = $state.snapshot(games);
      const r = await api.request('games.list', { offset: shown.length, limit: GAMES_PAGE_SIZE });
      // A game imported meanwhile moves the rest down a place, so the next page can repeat one.
      const ids = new Set(shown.map((g) => g.id));
      await show([...shown, ...r.games.filter((g) => !ids.has(g.id))], r.total);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Couldn’t load more games.';
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void api.reconnects;
    void api.state;
    void refresh();
  });
  // Back or Forward to the list puts back the Player's place once the list has loaded.
  const contentShown = router.loadsLater();
  $effect(() => {
    if (listFrom) contentShown();
  });

  /** The Player changed what to import, so the message about the last import, and its side question, no longer apply. */
  function edited(): void {
    message = '';
    error = '';
    needsSide = false;
    side = null;
  }

  function typedAccount(): void {
    accountTyped = true;
    edited();
  }

  async function importPgn(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = '';
    message = '';
    busy = true;
    try {
      const r = await api.request('games.importPgn', { pgn, ...(needsSide && side ? { playerSide: side } : {}) });
      message = r.duplicate ? 'You already imported that game.' : `Imported: ${r.game.white} vs ${r.game.black}.`;
      pgn = '';
      needsSide = false;
      side = null;
      await refresh(r.duplicate ? 0 : 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'needs-side') {
        // A question, not an error: neither name in the PGN is one the app knows as the Player's.
        needsSide = true;
        await tick();
        sideQuestion?.querySelector('input')?.focus();
      } else error = err instanceof ApiError ? err.message : 'Import failed.';
    } finally {
      busy = false;
    }
  }

  async function importUser(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = '';
    message = '';
    busy = true;
    fetching = 0;
    try {
      const r = await api.request('games.importUser', { site, username: username.trim() }, undefined, (done) => (fetching = done));
      const parts = [`Imported ${r.imported} finished ${r.imported === 1 ? 'game' : 'games'}`];
      if (r.duplicates) parts.push(`${r.duplicates} already in your list`);
      if (r.skippedUnfinished) parts.push(`${r.skippedUnfinished} still in progress and skipped`);
      if (r.unreadable) parts.push(`${r.unreadable} that couldn’t be read`);
      message = `${parts.join(', ')}.`;
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Import failed.';
      await refresh();
    } finally {
      busy = false;
      fetching = null;
    }
  }

  const RESULT: Record<string, string> = { '1-0': 'White won', '0-1': 'Black won', '1/2-1/2': 'Draw' };

  /** The Player's result and side, such as "Lost with White"; the sample's result as it stands. */
  function outcome(g: GameSummary): string {
    // The Player didn't play the sample game, so it is neither won nor lost by them.
    if (g.source === 'sample') return RESULT[g.result] ?? g.result;
    const as = `with ${SIDE_NAMES[g.playerSide]}`;
    if (g.result === '1/2-1/2') return `Drew ${as}`;
    if (g.result !== '1-0' && g.result !== '0-1') return g.result;
    return `${(g.result === '1-0') === (g.playerSide === 'white') ? 'Won' : 'Lost'} ${as}`;
  }

  const dateOf = (g: GameSummary): string => (g.date ? g.date.slice(0, 10) : 'Unknown');
  const sourceOf = (g: GameSummary): string =>
    g.source === 'engine' ? '' : ` (${g.source === 'pgn' ? 'PGN' : g.source === 'sample' ? 'sample' : g.source === 'lichess' ? 'Lichess' : 'chess.com'})`;
  /** How a game is named to a screen reader: the opponent and the day. */
  const nameOf = (g: GameSummary): string => `${g.opponent}, ${g.date ? g.date.slice(0, 10) : 'date unknown'}`;
  /** The other player, were the Player on side `s`. */
  const opponentAs = (g: GameSummary, s: Side): string => (s === 'white' ? g.black : g.white);

  function rememberPlace(): void {
    returnTo = { shown: games.length, scrollY: window.scrollY };
  }

  function moreButton(gameId: number): HTMLButtonElement | null {
    return document.querySelector(`[data-more-for="${gameId}"]`);
  }

  /** Pressing anywhere outside the open menu closes it. */
  function closeMenuOutside(e: PointerEvent): void {
    if (menuFor !== null && !(e.target as Element).closest?.(`[data-menu-of="${menuFor}"]`)) menuFor = null;
  }

  function closeMenu(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || menuFor === null) return;
    const id = menuFor;
    menuFor = null;
    moreButton(id)?.focus();
  }

  /** Opens a menu upwards when the window has no room for it below its button, or else scrolls it into view. */
  function fitMenu(menu: HTMLElement): void {
    const cell = (menu.parentElement as HTMLElement).getBoundingClientRect();
    menuUp = cell.bottom + menu.offsetHeight > window.innerHeight && cell.top >= menu.offsetHeight;
    if (!menuUp) menu.scrollIntoView({ block: 'nearest' });
  }

  async function ask(game: GameSummary, action: 'delete' | 'side'): Promise<void> {
    menuFor = null;
    refused = null;
    // Nothing is lost when an unreviewed game changes side, so that needs no question; the
    // desktop asks all the same if another device made a Review since this list was loaded.
    if (action === 'side' && !game.hasReview) return setSide(game);
    await askFirst(game, action);
  }

  /** Shows the question for a change to a game that asks first. */
  async function askFirst(game: GameSummary, action: 'delete' | 'side'): Promise<void> {
    confirming = { game, action };
    await tick();
    keepButton?.focus();
  }

  async function cancel(): Promise<void> {
    const id = confirming?.game.id;
    confirming = null;
    await tick();
    if (id !== undefined) moreButton(id)?.focus();
  }

  /** Changes the game's side; `dropReview` once the Player agreed that its Review goes. */
  async function setSide(game: GameSummary, dropReview = false): Promise<void> {
    confirming = null;
    refused = null;
    error = '';
    message = '';
    const playerSide = otherSide(game.playerSide);
    try {
      const saved = await api.request('games.setSide', { gameId: game.id, playerSide, ...(dropReview ? { dropReview } : {}) });
      message = `Saved: you played ${SIDE_NAMES[playerSide]} against ${saved.opponent}.`;
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'needs-confirm') {
        // Another device made a Review of it since this list was loaded: show it, and ask.
        await refresh();
        const reviewed = games.find((g) => g.id === game.id);
        if (reviewed) await askFirst(reviewed, 'side');
        return;
      }
      await refuse(game, err, 'Couldn’t change the side.');
    }
  }

  async function deleteGame(game: GameSummary): Promise<void> {
    confirming = null;
    refused = null;
    error = '';
    message = '';
    try {
      await api.request('games.delete', { gameId: game.id });
      message = `Deleted the game against ${game.opponent}.`;
      await refresh();
    } catch (err) {
      await refuse(game, err, 'Couldn’t delete the game.');
    }
  }

  /** Says by the game's row why a change was refused, or drops a game deleted from another device. */
  async function refuse(game: GameSummary, err: unknown, fallback: string): Promise<void> {
    const text = err instanceof ApiError ? err.message : fallback;
    if (!(err instanceof ApiError && err.code === 'not-found')) {
      refused = { gameId: game.id, text };
      await tick();
      refusedLine?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Gone either way: it leaves this list too.
    error = text;
    await refresh();
  }
</script>

<svelte:window onpointerdown={closeMenuOutside} onkeydown={closeMenu} />

<section class="screen games">
  <h1>Imported Games and Reviews</h1>

  <div class="imports">
    <form class="card" onsubmit={importPgn} aria-label="Import a PGN">
      <h2>Paste a PGN</h2>
      <label class="visually-hidden" for="pgn">PGN</label>
      <textarea id="pgn" bind:value={pgn} oninput={edited} rows="5" placeholder={'[Event "…"]\n1. e4 e5 2. Nf3 …'} disabled={api.state !== 'online'}></textarea>
      {#if needsSide}
        <fieldset bind:this={sideQuestion}>
          <legend>Which side did you play?</legend>
          <label><input type="radio" bind:group={side} value="white" /> White</label>
          <label><input type="radio" bind:group={side} value="black" /> Black</label>
        </fieldset>
      {/if}
      <button type="submit" disabled={busy || !pgn.trim() || api.state !== 'online' || (needsSide && !side)}>Import PGN</button>
    </form>

    <form class="card" onsubmit={importUser} aria-label="Import by username">
      <h2>Fetch your games</h2>
      <p class="muted small">Only finished games are imported. The first time brings your whole history, which can take a few minutes; after that, only new games.</p>
      <div class="row">
        <select bind:value={site} onchange={typedAccount} aria-label="Site">
          <option value="lichess">Lichess</option>
          <option value="chesscom">chess.com</option>
        </select>
        <input bind:this={usernameInput} bind:value={username} oninput={typedAccount} aria-label="Username" placeholder="Username" autocomplete="username" spellcheck="false" />
      </div>
      <button type="submit" disabled={busy || !username.trim() || api.state !== 'online'}>Fetch finished games</button>
    </form>
  </div>

  {#if fetching !== null}<p class="muted" aria-live="polite">Fetching games… {fetching} so far.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if pending}<p class="muted">{pending} Engine {pending === 1 ? 'Game' : 'Games'} played offline will be saved when your desktop is reachable.</p>{/if}

  <h2>Your games</h2>
  {#if listFrom === 'device'}
    <p class="card muted" role="note">
      Your games live on your desktop, which can’t be reached right now.{games.length ? ' This is the list from the last time it could.' : ''}
    </p>
  {/if}
  {#if games.length === 0}
    {#if listFrom === 'desktop'}<p class="muted">No games yet. Import one above or play an Engine Game.</p>{/if}
  {:else}
    <p class="muted small">
      {#if games.length < total}Showing {games.length.toLocaleString()} of {total.toLocaleString()} games.{:else if total === 1}Showing your one game.{:else}Showing all {total.toLocaleString()} games.{/if}
    </p>
    <table aria-label="Game list">
      <thead><tr><th class="wide-only">Date</th><th>Opponent</th><th>Result</th><th class="wide-only">Opening</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>
        {#each games as g (g.id)}
          <tr data-game-id={g.id}>
            <td class="wide-only date">{dateOf(g)}</td>
            <td class="opponent">
              {g.opponent}{sourceOf(g)}
              <span class="narrow-only muted">{dateOf(g)} · {g.opening}</span>
            </td>
            <td>{outcome(g)}</td>
            <td class="wide-only">{g.opening}</td>
            <td class="actions" data-menu-of={g.id}>
              <a href={`#/review/${g.id}`} onclick={rememberPlace} aria-label={`${g.hasReview ? 'Open Review' : 'Review'}: ${nameOf(g)}`}>{g.hasReview ? 'Open Review' : 'Review'}</a>
              {#if listFrom === 'desktop' && api.state === 'online'}
                <button
                  type="button"
                  class="secondary more"
                  data-more-for={g.id}
                  aria-label={`More: ${nameOf(g)}`}
                  aria-expanded={menuFor === g.id}
                  onclick={() => (menuFor = menuFor === g.id ? null : g.id)}>⋯</button
                >
                {#if menuFor === g.id}
                  <div class="menu card" class:up={menuUp} use:fitMenu>
                    {#if g.source !== 'engine'}
                      <button type="button" class="secondary" onclick={() => ask(g, 'side')}>I played {SIDE_NAMES[otherSide(g.playerSide)]}</button>
                    {/if}
                    <button type="button" class="secondary" onclick={() => ask(g, 'delete')}>Delete game</button>
                  </div>
                {/if}
              {/if}
            </td>
          </tr>
          {#if refused?.gameId === g.id}
            <tr class="confirm-row">
              <td colspan="5"><p class="error refused" role="alert" bind:this={refusedLine}>{refused.text}</p></td>
            </tr>
          {/if}
          {#if confirming && confirming.game.id === g.id}
            {@const to = otherSide(g.playerSide)}
            <tr class="confirm-row">
              <td colspan="5">
                <div
                  class="card confirm"
                  role="alertdialog"
                  aria-labelledby="confirm-title"
                  aria-describedby="confirm-detail"
                  tabindex="-1"
                  onkeydown={(e) => {
                    if (e.key === 'Escape') void cancel();
                  }}
                >
                  {#if confirming.action === 'delete'}
                    <p id="confirm-title"><strong>Delete the game against {g.opponent}?</strong></p>
                    <p id="confirm-detail" class="muted">
                      {g.hasReview ? 'Its Review goes too, and its Move Grades leave your Player Profile.' : 'It leaves your game list.'}
                    </p>
                    <div class="row">
                      <button type="button" onclick={cancel} bind:this={keepButton}>Keep the game</button>
                      <button type="button" class="secondary" onclick={() => deleteGame(g)}>Yes, delete it</button>
                    </div>
                  {:else}
                    <p id="confirm-title"><strong>Did you play {SIDE_NAMES[to]} against {opponentAs(g, to)}?</strong></p>
                    <p id="confirm-detail" class="muted">
                      Its Review is about {SIDE_NAMES[g.playerSide]}’s moves, so it goes, and its Move Grades leave your Player Profile. You can then
                      start a Review of {SIDE_NAMES[to]}’s moves.
                    </p>
                    <div class="row">
                      <button type="button" onclick={cancel} bind:this={keepButton}>Cancel</button>
                      <button type="button" class="secondary" onclick={() => setSide(g, true)}>Yes, I played {SIDE_NAMES[to]}</button>
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if games.length < total && listFrom === 'desktop'}
      <button type="button" class="more-games" onclick={showMore} disabled={loadingMore || api.state !== 'online'}>Show more</button>
    {/if}
  {/if}
</section>

<style>
  .games { display: flex; flex-direction: column; gap: 0.6rem; }
  .imports { display: grid; gap: 0.8rem; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); }
  form { display: flex; flex-direction: column; gap: 0.5rem; }
  h2 { font-size: 1.05rem; margin: 0.3rem 0; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .row input { flex: 1; min-width: 0; }
  .small { font-size: 0.85rem; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.35rem 0.3rem; border-bottom: 1px solid var(--line); }
  .date { white-space: nowrap; }
  .opponent { overflow-wrap: anywhere; }
  .actions { position: relative; white-space: nowrap; text-align: right; }
  .more { margin-left: 0.4rem; padding: 0.1rem 0.55rem; line-height: 1.2; }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% - 0.2rem);
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem;
    box-shadow: 0 4px 16px rgb(0 0 0 / 15%);
  }
  .menu.up { top: auto; bottom: calc(100% - 0.2rem); }
  .confirm-row td { border-bottom: 0; }
  .confirm { margin: 0.2rem 0 0.4rem; }
  .confirm p { margin: 0 0 0.4rem; }
  .refused { margin: 0.2rem 0 0.4rem; }
  .more-games { align-self: center; }
  fieldset { display: flex; gap: 1rem; border: 1px solid var(--line); border-radius: 8px; }
  .narrow-only { display: none; }
  /* A phone: the date and opening go under the opponent, so the list never scrolls sideways. */
  @media (max-width: 600px) {
    .wide-only { display: none; }
    .narrow-only { display: block; font-size: 0.8rem; }
  }
</style>
