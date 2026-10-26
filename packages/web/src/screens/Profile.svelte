<script lang="ts">
  // The Player Profile: level, rating, strengths, weaknesses, Goals, Lesson progress and Coach notes.
  import { tick } from 'svelte';
  import { PLAYER_LEVELS, type PlayerLevel, type RatingSite } from '@chess-coach/shared/protocol';
  import { MOVE_GRADES } from '@chess-coach/shared/grader';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { lessonCatalogue } from '../lib/content.ts';
  import { GRADE_LOOK } from '../lib/grades.ts';
  import { profile } from '../lib/profile.svelte.ts';

  let editing = $state(false);
  let level = $state<PlayerLevel>('beginner');
  let goals = $state<string[]>([]);
  let site = $state<RatingSite | ''>('');
  let username = $state('');
  let error = $state('');
  /** Why the form wasn't saved, shown beside Save; a refused username goes under its box instead. */
  let saveError = $state('');
  /** Why the site couldn't give a rating: shown beside the Username box, which it is about. */
  let ratingError = $state('');
  let siteSelect = $state<HTMLSelectElement>();
  let usernameBox = $state<HTMLInputElement>();
  /**
   * What Save says while the desktop works on a save, such as "Checking Lichess…"; empty when idle.
   * Save and Cancel both wait: once asked, the desktop can't be called back, so a save the Player
   * cancelled would still land.
   */
  let saving = $state('');

  const p = $derived(profile.profile);
  /** The Lessons the Player has started or finished; the rest are summed up in one line. */
  const begun = $derived(lessonCatalogue.flatMap((l) => {
    const prog = p?.lessons.find((x) => x.lessonId === l.id);
    return prog ? [{ lesson: l, prog }] : [];
  }));

  // Reviews, Lessons and Puzzles change the Player Profile, so fetch it fresh on every visit.
  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') void profile.load();
  });

  /** Opens the form; from "Link an account" it starts at the Site, the part the Player came for. */
  async function startEdit(atAccount = false): Promise<void> {
    if (!p) return;
    level = p.level;
    goals = p.goals.length ? [...p.goals] : [''];
    site = p.ratingSource?.site ?? '';
    username = p.ratingSource?.username ?? '';
    ratingError = '';
    saveError = '';
    editing = true;
    if (atAccount) {
      await tick();
      siteSelect?.focus();
    }
  }

  /** The account part of the update: unchanged accounts aren't looked up again, None removes one. */
  function accountChange(): { rating?: { site: RatingSite; username: string } | null } {
    const linked = p?.ratingSource ?? null;
    if (!site) return linked ? { rating: null } : {};
    const name = username.trim();
    if (!name || (linked?.site === site && linked.username === name)) return {};
    return { rating: { site, username: name } };
  }

  async function save(): Promise<void> {
    saveError = '';
    ratingError = '';
    if (site && !username.trim()) {
      ratingError = 'Type your username.';
      usernameBox?.focus();
      return;
    }
    const account = accountChange();
    // Asking the site can take a while; until the answer, Save waits so it's never sent twice.
    saving = account.rating ? `Checking ${SITE_NAME[account.rating.site]}…` : 'Saving…';
    try {
      // One update: the desktop reads the rating before it saves anything, so an unknown
      // username leaves the whole Player Profile as it was.
      profile.set(await api.request('profile.update', { level, goals: goals.map((g) => g.trim()).filter(Boolean), ...account }));
      editing = false;
    } catch (err) {
      if (!(err instanceof ApiError)) saveError = 'Could not save. Try again.';
      // The desktop drops a lookup whose connection closed, so the account isn't linked later.
      else if (err.code === 'offline') saveError = 'Not saved: your desktop can’t be reached right now. Save again once it’s back.';
      // A username the site refused, or one in a format no site allows, is shown under its box.
      else if (account.rating) {
        ratingError = err.message;
        await tick();
        usernameBox?.focus();
      } else saveError = err.message;
    } finally {
      saving = '';
    }
  }

  async function deleteNote(id: number): Promise<void> {
    try {
      profile.set(await api.request('profile.deleteNote', { noteId: id }));
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not delete the note.';
    }
  }

  const LEVEL_NAME: Record<PlayerLevel, string> = { beginner: 'Beginner', casual: 'Casual', club: 'Club' };
  const SITE_NAME = { lichess: 'Lichess', chesscom: 'chess.com' };
</script>

<section class="screen profile">
  <h1>Player Profile</h1>
  {#if !p}
    <p class="muted">Your Player Profile lives on your desktop, which hasn’t been reached yet.</p>
  {:else}
    {#if api.state === 'offline'}
      <!-- Says why the buttons below are greyed out. -->
      <p class="card muted" role="note">Your Player Profile lives on your desktop, which can’t be reached right now. You can change it once it’s back.</p>
    {/if}
    <section class="card" aria-label="Level, account and Goals">
      {#if editing}
        <label>
          Level
          <select bind:value={level} aria-label="Level">
            {#each PLAYER_LEVELS as l (l)}<option value={l}>{LEVEL_NAME[l]}</option>{/each}
          </select>
        </label>
        <fieldset class="account">
          <legend>Your online account</legend>
          <p class="muted small">The app reads your rating so “players at your level” uses a real number, and fills in your username when you import your games.</p>
          <div class="row">
            <label>
              Site
              <select bind:this={siteSelect} bind:value={site} onchange={() => (ratingError = '')}>
                <option value="">None</option>
                <option value="lichess">Lichess</option>
                <option value="chesscom">chess.com</option>
              </select>
            </label>
            <label class="grow">
              Username
              <input
                bind:this={usernameBox}
                bind:value={username}
                disabled={!site}
                autocomplete="username"
                spellcheck="false"
                aria-invalid={ratingError ? 'true' : undefined}
                aria-describedby={ratingError ? 'profile-rating-error' : undefined}
                oninput={() => (ratingError = '')}
              />
            </label>
          </div>
          {#if ratingError}
            <p class="error small" id="profile-rating-error" role="alert">{ratingError} Or set Site to None to save without an account.</p>
          {/if}
        </fieldset>
        <h2>Goals</h2>
        {#each goals as _, i (i)}
          <input bind:value={goals[i]} aria-label={`Goal ${i + 1}`} maxlength="100" />
        {/each}
        {#if goals.length < 5}<button type="button" class="secondary" onclick={() => (goals = [...goals, ''])}>Add a Goal</button>{/if}
        <div class="row">
          <button type="button" onclick={save} disabled={!!saving}>{saving || 'Save'}</button>
          <button type="button" class="secondary" onclick={() => (editing = false)} disabled={!!saving}>Cancel</button>
        </div>
        {#if saveError}<p class="error small save-error" role="alert">{saveError}</p>{/if}
      {:else}
        <p><strong>Level:</strong> <span data-testid="profile-level">{LEVEL_NAME[p.level]}</span></p>
        <p>
          <strong>Rating:</strong>
          {#if p.rating && p.ratingSource}{p.rating} ({SITE_NAME[p.ratingSource.site]}, {p.ratingSource.username}){:else}<span class="muted">not linked</span>
            <button type="button" class="link" onclick={() => startEdit(true)} disabled={api.state !== 'online'}>Link an account</button>{/if}
        </p>
        <h2>Goals</h2>
        {#if p.goals.length}
          <ul aria-label="Goals">{#each p.goals as g (g)}<li>{g}</li>{/each}</ul>
        {:else}<p class="muted">No Goals yet.</p>{/if}
        <button type="button" class="secondary" onclick={() => startEdit()} disabled={api.state !== 'online'}>Edit level, account and Goals</button>
      {/if}
    </section>

    <section class="card" aria-label="Strengths and weaknesses">
      <h2>Strengths</h2>
      {#if p.strengths.length}<ul>{#each p.strengths as s (s)}<li>{s}</li>{/each}</ul>{:else}<p class="muted">Play and review a few games to see your strengths.</p>{/if}
      <h2>Weaknesses</h2>
      {#if p.weaknesses.length}<ul>{#each p.weaknesses as s (s)}<li>{s}</li>{/each}</ul>{:else}<p class="muted">Play and review a few games to see what to work on.</p>{/if}
    </section>

    <section class="card" aria-label="Lesson progress">
      <h2>Lesson progress</h2>
      {#if begun.length}
        <ul>
          {#each begun as { lesson: l, prog } (l.id)}
            <li>{l.name}: {prog.completed ? 'complete' : `${prog.step} of ${l.decisions} decisions`}</li>
          {/each}
        </ul>
        {#if begun.length < lessonCatalogue.length}
          {@const left = lessonCatalogue.length - begun.length}
          <p class="muted">{left} more {left === 1 ? 'Lesson' : 'Lessons'} to try. <a href="#/lessons">Browse the Lessons</a></p>
        {/if}
      {:else}
        <p class="muted">No Lessons started yet. <a href="#/lessons">Browse the Lessons</a></p>
      {/if}
      {#if p.puzzles.attempted}
        <p>Puzzles: {p.puzzles.solved} solved first time out of {p.puzzles.attempted}.</p>
      {:else}
        <p class="muted">No Puzzles tried yet.</p>
      {/if}
    </section>

    {#if Object.keys(p.gradeCounts).length}
      <section class="card" aria-label="Move Grades by opening">
        <h2>Move Grades by opening</h2>
        <!-- Five Move Grades don't fit a phone by name: there the headers show the symbols the board draws,
             keep the names for screen readers, and a legend under the table spells them out. -->
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Opening</th>
                {#each MOVE_GRADES as g (g)}
                  <th scope="col" class="grade">
                    <span class="name">{g}</span>
                    <span class="symbol" aria-hidden="true" style:background={GRADE_LOOK[g].light} style:color={GRADE_LOOK[g].dark}>{GRADE_LOOK[g].symbol}</span>
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each Object.entries(p.gradeCounts) as [opening, counts] (opening)}
                <tr><td>{opening}</td>{#each MOVE_GRADES as g (g)}<td>{counts[g] ?? 0}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        </div>
        <!-- Non-breaking spaces keep each symbol with its name, so lines break only between entries. -->
        <p class="legend muted small" aria-hidden="true">{MOVE_GRADES.map((g) => `${GRADE_LOOK[g].symbol}\u00a0${g}`).join('\u00a0· ')}</p>
      </section>
    {/if}

    <section class="card" aria-label="Coach notes">
      <h2>Coach notes</h2>
      <p class="muted small">Short notes the Coach added when it noticed something new. Delete any that are wrong.</p>
      {#if p.notes.length}
        <ul class="notes">
          {#each p.notes as n (n.id)}
            <li>
              <span>{n.text}</span>
              <button type="button" class="secondary" onclick={() => deleteNote(n.id)} aria-label={`Delete note: ${n.text}`} disabled={api.state !== 'online'}>Delete</button>
            </li>
          {/each}
        </ul>
      {:else}<p class="muted">No notes yet.</p>{/if}
    </section>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .profile { display: flex; flex-direction: column; gap: 0.8rem; max-width: 46rem; }
  h2 { font-size: 1rem; margin: 0.6rem 0 0.3rem; }
  .row { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  label { display: flex; gap: 0.5rem; align-items: center; }
  .account { border: 0; padding: 0; margin: 0.8rem 0 0; }
  .account legend { font-weight: 600; padding: 0; }
  .account .grow { flex: 1 1 12rem; }
  .account .error, .save-error { margin: 0.4rem 0 0; }
  .link { background: none; border: 0; padding: 0 0.2rem; color: var(--accent); text-decoration: underline; cursor: pointer; }
  input { display: block; width: 100%; margin: 0.25rem 0; }
  .notes li { display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; margin: 0.25rem 0; }
  .small { font-size: 0.85rem; }
  /* Only very large counts could still be too wide: then the table scrolls inside its card, never the page. */
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td:first-child { min-width: 9rem; }
  th, td { border-bottom: 1px solid var(--line); padding: 0.2rem 0.3rem; text-align: left; }
  .symbol, .legend { display: none; }
  @media (max-width: 32rem) {
    td:first-child { min-width: 0; }
    th.grade, td:not(:first-child) { text-align: center; width: 2.6rem; }
    th.grade { position: relative; }
    /* Hidden from sight, not from screen readers, like .visually-hidden. */
    .grade .name {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    .symbol { display: inline-block; min-width: 1.6rem; padding: 0 0.25rem; border-radius: 4px; font-weight: 700; }
    .legend { display: block; margin: 0.5rem 0 0; }
  }
</style>
