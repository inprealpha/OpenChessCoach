<script lang="ts">
  // First run, in two steps on a desktop: first the phone, where most people play chess (its QR
  // code, which the Player can put off), then the Player's level, an optional Lichess or chess.com
  // username for their rating, and a few Goals. It points to the Lessons and the first one for the
  // chosen level, which the Player can skip. A phone or tablet, or a desktop with a phone paired,
  // starts at the second step.
  import { tick } from 'svelte';
  import { suggestNext } from '@chess-coach/shared/content/course';
  import { BANDS } from '@chess-coach/shared/content/lessons';
  import { PLAYER_LEVELS, type PlayerLevel, type RatingSite } from '@chess-coach/shared/protocol';
  import PhonePairing from '../components/PhonePairing.svelte';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { lessonCatalogue } from '../lib/content.ts';
  import { phone } from '../lib/phone.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { router } from '../lib/router.svelte.ts';
  import { onPhoneOrTablet } from '../lib/this-device.ts';

  const LEVEL_TEXT: Record<PlayerLevel, string> = {
    beginner: 'Beginner: I know how the pieces move.',
    casual: 'Casual: I play now and then and know some basics.',
    club: 'Club: I play regularly and know some opening theory.',
  };
  const SUGGESTED = ['Learn the Italian Game', 'Learn the Caro-Kann Defence', 'Stop blundering pieces'];

  let level = $state<PlayerLevel>(profile.profile?.level ?? 'beginner');
  /**
   * Where the Lessons start for the level chosen above: a casual or club Player skips the beginner
   * ones, unless a rating linked before says otherwise (ADR 0012).
   */
  const firstLesson = $derived(suggestNext(lessonCatalogue, profile.profile?.lessons ?? [], { level, rating: profile.profile?.rating ?? null })?.lesson);
  let site = $state<RatingSite | ''>('');
  let username = $state('');
  let goals = $state<string[]>(profile.profile?.goals.length ? [...profile.profile.goals] : ['']);
  let error = $state('');
  /** Why the site couldn't give a rating: shown beside the Username box, which it is about. */
  let ratingError = $state('');
  let account = $state<HTMLFieldSetElement>();
  let usernameBox = $state<HTMLInputElement>();
  let busy = $state(false);
  /** Set up already when this screen opened (`#/first-run` typed in): saving here is then the Player's own choice. */
  const setUpBefore = profile.profile?.onboarded === true;

  /** Null until the desktop says whether to ask for the phone. */
  let step = $state<'phone' | 'about' | null>(onPhoneOrTablet ? 'about' : null);
  /** The phone step was shown, so the steps are numbered. */
  let askedPhone = $state(false);
  let aboutHeading = $state<HTMLHeadingElement>();
  let continueButton = $state<HTMLButtonElement>();

  // Asked afresh, not from an answer kept since before a dropped connection. Offline, the form
  // waits for the desktop anyway, and the main menu asks about the phone later.
  $effect(() => {
    if (step !== null) return;
    if (api.state === 'offline') step = 'about';
    else if (api.state === 'online') {
      void phone.load().then(() => {
        if (step !== null) return;
        askedPhone = phone.info?.phone.remind === true;
        step = askedPhone ? 'phone' : 'about';
      });
    }
  });

  // When the phone pairs, Continue here replaces the button that may have had the focus.
  $effect(() => {
    if (continueButton && (document.activeElement === document.body || document.activeElement === null)) continueButton.focus();
  });

  /** On to the Player's questions, with the focus on their heading rather than lost with the phone step. */
  async function toAbout(): Promise<void> {
    step = 'about';
    await tick();
    aboutHeading?.focus();
  }

  /** Puts the phone off for a few days; the main menu asks again then. */
  async function phoneLater(): Promise<void> {
    busy = true;
    await phone.later();
    busy = false;
    await toAbout();
  }

  /** Whether the Player finished setting up on another device, such as the phone, while this screen was open. */
  async function setUpElsewhere(): Promise<boolean> {
    if (setUpBefore) return false;
    await profile.load();
    return profile.profile?.onboarded === true;
  }

  /** The phone paired: if the Player set up there too, the main menu, rather than this form a second time. */
  async function continueHere(): Promise<void> {
    busy = true;
    const elsewhere = await setUpElsewhere();
    busy = false;
    if (elsewhere) router.go('menu');
    else await toAbout();
  }

  async function finish(next: 'lessons' | 'menu'): Promise<void> {
    error = '';
    ratingError = '';
    busy = true;
    try {
      // Both devices showed this form: the answers saved first stay, rather than these replacing them.
      if (await setUpElsewhere()) {
        router.go(next);
        return;
      }
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
  <p>The Engine judges every move; the Coach explains why in plain language.</p>
  {#if step === 'phone' && phone.info}
    <section class="card phone-step" aria-labelledby="phone-step-title">
      <p class="muted small step">Step 1 of 2</p>
      <h2 id="phone-step-title">Play on your phone</h2>
      <p>Most people play chess on their phone, and you can too. This desktop does the Coach’s work, and your phone connects to it over your Wi-Fi.</p>
      <PhonePairing info={phone.info} />
      <div class="next">
        {#if phone.info.phone.paired}
          <p>Carry on setting up on your phone, or here.</p>
          <button type="button" bind:this={continueButton} onclick={continueHere} disabled={busy}>Continue here</button>
        {:else}
          <button type="button" class="secondary" onclick={phoneLater} disabled={busy}>I’ll do it later</button>
        {/if}
      </div>
    </section>
  {:else if step === 'about'}
    {#if askedPhone}
      <div>
        <p class="muted small step">Step 2 of 2</p>
        <h2 class="about" tabindex="-1" bind:this={aboutHeading}>About you</h2>
      </div>
    {/if}
    <p>Tell the Coach a little about yourself.</p>

    <fieldset class="card">
      <legend>Your level</legend>
      {#each PLAYER_LEVELS as l (l)}
        <label class="option">
          <input type="radio" name="level" value={l} bind:group={level} />
          <!-- The band each level stands for, so a Player who plays online can place themselves. -->
          <span>{LEVEL_TEXT[l]} <span class="muted">Online: rated {BANDS[l].label}.</span></span>
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
      <p>
        <strong>Where to begin:</strong> the Lessons take you from your first moves to the end of intermediate level, one choice of move at a time.
        {#if firstLesson}At your level, the first Lesson is {firstLesson.name}.{/if}
      </p>
      <button type="button" onclick={() => finish('lessons')} disabled={busy || api.state !== 'online'}>Start with the Lessons</button>
      <button type="button" class="secondary" onclick={() => finish('menu')} disabled={busy || api.state !== 'online'}>Skip to the main menu</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else}
    <p class="muted">Loading…</p>
  {/if}
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
  .step { margin: 0; }
  .phone-step { padding: 1rem 1.25rem; }
  .phone-step h2, h2.about { font-size: 1.3rem; margin: 0.1rem 0 0.4rem; }
  h2.about { margin-bottom: 0; }
  h2.about:focus { outline: none; }
  .phone-step > p:not(.step) { margin: 0 0 0.9rem; }
  .next { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; margin-top: 1rem; }
  .next p { margin: 0; }
</style>
