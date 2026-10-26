<script lang="ts">
  // First run: the Player's level, an optional Lichess or chess.com username for their rating,
  // and a few Goals. It suggests the Opening Lessons, which the Player can skip.
  import { tick } from 'svelte';
  import { PLAYER_LEVELS, type PlayerLevel, type RatingSite } from '@chess-coach/shared/protocol';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { lessonCatalogue } from '../lib/content.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { router } from '../lib/router.svelte.ts';

  const LEVEL_TEXT: Record<PlayerLevel, string> = {
    beginner: 'Beginner: I know how the pieces move.',
    casual: 'Casual: I play now and then and know some basics.',
    club: 'Club: I play regularly and know some opening theory.',
  };
  const SUGGESTED = ['Learn the Italian Game', 'Learn the Caro-Kann Defence', 'Stop blundering pieces'];
  const OPENINGS = lessonCatalogue.filter((l) => l.kind === 'opening').length;

  let level = $state<PlayerLevel>(profile.profile?.level ?? 'beginner');
  let site = $state<RatingSite | ''>('');
  let username = $state('');
  let goals = $state<string[]>(profile.profile?.goals.length ? [...profile.profile.goals] : ['']);
  let error = $state('');
  /** Why the site couldn't give a rating: shown beside the Username box, which it is about. */
  let ratingError = $state('');
  let account = $state<HTMLFieldSetElement>();
  let usernameBox = $state<HTMLInputElement>();
  let busy = $state(false);

  async function finish(next: 'lessons' | 'menu'): Promise<void> {
    error = '';
    ratingError = '';
    busy = true;
    try {
      const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);
      let updated = await api.request('profile.update', { level, goals: cleanGoals });
      if (site && username.trim()) {
        try {
          updated = await api.request('profile.update', { rating: { site, username: username.trim() } });
        } catch (err) {
          if (!(err instanceof ApiError) || err.code === 'offline') throw err;
          // Far down the form, the buttons would seem to do nothing: bring the box and the reason into view.
          ratingError = err.message;
          await tick();
          usernameBox?.focus({ preventScroll: true });
          account?.scrollIntoView({ block: 'center' });
          return;
        }
      }
      updated = await api.request('profile.update', { onboarded: true });
      profile.set(updated);
      router.go(next);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<section class="screen first-run">
  <h1>Welcome to your chess Coach</h1>
  <p>The Engine judges every move; the Coach explains why in plain language. Tell the Coach a little about yourself.</p>

  <fieldset class="card">
    <legend>Your level</legend>
    {#each PLAYER_LEVELS as l (l)}
      <label class="option">
        <input type="radio" name="level" value={l} bind:group={level} />
        {LEVEL_TEXT[l]}
      </label>
    {/each}
  </fieldset>

  <fieldset class="card" bind:this={account}>
    <legend>Your online account (optional)</legend>
    <p class="muted small">The app reads your rating so “players at your level” uses a real number.</p>
    <div class="row">
      <label>
        Site
        <select bind:value={site} onchange={() => (ratingError = '')}>
          <option value="">None</option>
          <option value="lichess">Lichess</option>
          <option value="chesscom">chess.com</option>
        </select>
      </label>
      <label>
        Username
        <input
          bind:this={usernameBox}
          bind:value={username}
          disabled={!site}
          autocomplete="username"
          spellcheck="false"
          aria-invalid={ratingError ? 'true' : undefined}
          aria-describedby={ratingError ? 'rating-error' : undefined}
          oninput={() => (ratingError = '')}
        />
      </label>
    </div>
    {#if ratingError}
      <p class="error small" id="rating-error" role="alert">{ratingError} Or set Site to None to carry on without an account.</p>
    {/if}
  </fieldset>

  <fieldset class="card">
    <legend>Your Goals</legend>
    {#each goals as _, i (i)}
      <div class="row">
        <label class="grow">
          <span class="visually-hidden">Goal {i + 1}</span>
          <input bind:value={goals[i]} placeholder="For example: learn the Italian Game" aria-label={`Goal ${i + 1}`} maxlength="100" />
        </label>
        {#if goals.length > 1}
          <button type="button" class="secondary" onclick={() => (goals = goals.filter((__, j) => j !== i))} aria-label={`Remove Goal ${i + 1}`}>✕</button>
        {/if}
      </div>
    {/each}
    <div class="row">
      {#if goals.length < 5}<button type="button" class="secondary" onclick={() => (goals = [...goals, ''])}>Add a Goal</button>{/if}
      {#each SUGGESTED as s (s)}
        {#if !goals.includes(s) && goals.length < 5}
          <button type="button" class="secondary chip" onclick={() => (goals = [...goals.filter(Boolean), s])}>+ {s}</button>
        {/if}
      {/each}
    </div>
  </fieldset>

  <div class="card suggest">
    <p><strong>Where to begin:</strong> the Opening Lessons teach {OPENINGS} beginner openings by asking you to choose moves.</p>
    <button type="button" onclick={() => finish('lessons')} disabled={busy || api.state !== 'online'}>Start with the Opening Lessons</button>
    <button type="button" class="secondary" onclick={() => finish('menu')} disabled={busy || api.state !== 'online'}>Skip to the main menu</button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .first-run { max-width: 42rem; display: flex; flex-direction: column; gap: 0.8rem; }
  /* The column's gap spaces the heading and the intro; in a flex column their own margins would add to it. */
  .first-run > h1 { margin-bottom: 0; }
  .first-run > p { margin: 0; }
  fieldset { margin: 0; }
  legend { font-weight: 600; padding: 0 0.3rem; }
  .option { display: flex; gap: 0.5rem; align-items: center; margin: 0.3rem 0; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin: 0.3rem 0; }
  /* These rules outweigh app.css's, so say again that a card's last child adds no margin. */
  .option:last-child, .row:last-child { margin-bottom: 0; }
  .row label { display: flex; flex-direction: column; gap: 0.2rem; }
  .grow { flex: 1; }
  .grow input { width: 100%; }
  .chip { font-size: 0.85rem; padding: 0.3rem 0.6rem; }
  .small { font-size: 0.85rem; margin: 0 0 0.4rem; }
  #rating-error { margin: 0.4rem 0 0; }
  .suggest { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .suggest p { width: 100%; margin: 0 0 0.3rem; }
</style>
