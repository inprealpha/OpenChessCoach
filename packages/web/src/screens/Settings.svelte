<script lang="ts">
  // Pairing (QR code, pairing code and reset), the away-from-home tunnel, Live Coaching, the Coach quality
  // and, under Advanced, the model per Coach job, and Think deeper.
  import {
    COACH_JOBS,
    COACH_QUALITIES,
    type CoachJob,
    type CoachQuality,
    type PairingInfo,
    type Settings,
    type SettingsPatch,
  } from '@chess-coach/shared/protocol';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { pairingCode } from '../lib/pairing-code.ts';

  /** A card on this screen, where the outcome of a change made in it is shown. */
  type Card = 'pairing' | 'tunnel' | 'live' | 'quality' | 'deeper';

  let settings = $state<Settings | null>(null);
  let pairing = $state<PairingInfo | null>(null);
  let message = $state('');
  /** What came of the last change, shown in the card where the Player made it rather than at the foot of the page. */
  let outcome = $state<{ card: Card; text: string; failed: boolean } | null>(null);
  let confirmReset = $state(false);

  const code = $derived(pairing ? pairingCode(pairing.pairUrl) : '');
  const canCopy = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

  const JOB_NAMES: Record<CoachJob, string> = {
    'review-moment': 'Reviews',
    why: 'Why Questions',
    'lesson-turn': 'Lessons',
    hint: 'Hints',
    live: 'Live Coaching',
  };

  // The desktop owns which models each preset sets; this screen only names them and what they cost.
  const QUALITY_TEXT: Record<CoachQuality, { name: string; cost: string }> = {
    thrifty: {
      name: 'Thrifty',
      cost: 'Haiku for every job. Uses the least of your Claude limits; explanations are shorter and simpler.',
    },
    balanced: {
      name: 'Balanced (recommended)',
      cost: 'Sonnet for Reviews, Why Questions and Lessons; Haiku for Hints and Live Coaching. A moderate share of your Claude limits.',
    },
    best: {
      name: 'Best',
      cost: 'Opus for Reviews, Why Questions and Lessons; Haiku for Hints and Live Coaching, which must stay quick. Uses your Claude limits fastest.',
    },
  };

  /**
   * Whether a Coach job that can ask the Engine runs on Haiku: there Think deeper makes answers fuller
   * but added false claims in the off/on comparison (ADR 0010), so the card says so.
   */
  const haikuThinksDeeper = $derived(
    settings !== null && (['why', 'review-moment'] as const).some((job) => settings?.models[job].toLowerCase().includes('haiku')),
  );

  const MODEL_NAMES: Record<string, string> = {
    haiku: 'Fastest, latest Haiku',
    sonnet: 'Balanced, latest Sonnet',
    opus: 'Strongest, latest Opus',
  };

  async function load(): Promise<void> {
    try {
      settings = await api.request('settings.get', {});
      pairing = await api.request('pairing.info', {});
    } catch (err) {
      message = err instanceof ApiError ? err.message : 'Settings could not be loaded.';
    }
  }

  $effect(() => {
    void api.reconnects;
    if (api.state === 'online') void load();
  });

  $effect(() => {
    // A new tunnel address means a new QR code.
    void api.tunnel?.url;
    void api.tunnel?.status;
    if (api.state === 'online' && api.tunnel) void api.request('pairing.info', {}).then((p) => (pairing = p));
  });

  // Send only what changed: the desktop merges each Coach job's model into the saved settings, so two
  // changes in flight at once both land. A whole models map built from this screen's copy would undo the other.
  async function update(card: Card, patch: SettingsPatch): Promise<void> {
    try {
      settings = await api.request('settings.update', patch);
      outcome = { card, text: 'Saved.', failed: false };
    } catch (err) {
      outcome = { card, text: err instanceof ApiError ? err.message : 'Could not save.', failed: true };
    }
  }

  async function resetPairing(): Promise<void> {
    try {
      const { token } = await api.request('pairing.reset', {});
      await api.adoptToken(token);
      confirmReset = false;
      pairing = await api.request('pairing.info', {});
      outcome = { card: 'pairing', text: 'Pairing reset. Every other device must scan the new QR code or type the new pairing code.', failed: false };
    } catch (err) {
      outcome = { card: 'pairing', text: err instanceof ApiError ? err.message : 'Could not reset pairing.', failed: true };
    }
  }

  async function copyLink(): Promise<void> {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairUrl);
      outcome = { card: 'pairing', text: 'Pairing link copied.', failed: false };
    } catch {
      outcome = { card: 'pairing', text: 'Could not copy the link. Select it and copy it instead.', failed: true };
    }
  }
</script>

{#snippet said(card: Card)}
  {#if outcome?.card === card}
    <p class="small outcome" class:error={outcome.failed} role={outcome.failed ? 'alert' : 'status'}>{outcome.text}</p>
  {/if}
{/snippet}

<section class="screen settings">
  <h1>Settings</h1>
  {#if api.state !== 'online'}
    <p class="card">Settings live on your desktop, which can’t be reached right now.</p>
  {:else if settings && pairing}
    <section class="card" aria-label="Pairing">
      <h2>Pair another device</h2>
      <p>Scan this with a phone on the same Wi-Fi as your desktop.</p>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- the desktop draws this SVG from its own pairing URL -->
      <figure class="qr" aria-label="Pairing QR code">{@html pairing.qrSvg}</figure>
      <p>No camera? Open <span class="address">{pairing.lanUrl}</span> on the other device and type the pairing code:</p>
      <p class="code" data-testid="pairing-code">{code}</p>
      <p class="muted small">
        Or open the pairing link there:
        <span class="address link" data-testid="pairing-link">{pairing.pairUrl}</span>
        {#if canCopy}<button type="button" class="secondary copy" onclick={copyLink}>Copy link</button>{/if}
      </p>
      {#if confirmReset}
        <p>Every other device will have to scan a new QR code. Continue?</p>
        <button type="button" onclick={resetPairing}>Yes, reset pairing</button>
        <button type="button" class="secondary" onclick={() => (confirmReset = false)}>Cancel</button>
      {:else}
        <button type="button" class="secondary" onclick={() => (confirmReset = true)}>Reset pairing</button>
      {/if}
      {@render said('pairing')}
    </section>

    <section class="card" aria-label="Away from home">
      <h2>Away from home</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.tunnelEnabled}
          onchange={(e) => update('tunnel', { tunnelEnabled: (e.currentTarget as HTMLInputElement).checked })}
        />
        Make the app reachable away from home
      </label>
      <p class="muted small">
        Starts a free Cloudflare quick tunnel. Its address changes every time it starts, and it is for personal use with no uptime
        guarantee. Pairing is still required. For a stable private address, see the Tailscale guide in the README.
      </p>
      {#if pairing.tunnel.status === 'starting'}<p role="status">Starting the tunnel…</p>{/if}
      {#if pairing.tunnel.status === 'error'}<p class="error" role="alert">{pairing.tunnel.error}</p>{/if}
      {#if pairing.tunnelQrSvg && pairing.tunnel.url}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- the desktop draws this SVG from its own tunnel URL -->
        <figure class="qr" aria-label="Away-from-home QR code">{@html pairing.tunnelQrSvg}</figure>
        <p class="small">Away-from-home address: <span data-testid="tunnel-url">{pairing.tunnel.url}</span></p>
      {/if}
      {@render said('tunnel')}
    </section>

    <section class="card" aria-label="Live Coaching">
      <h2>Live Coaching</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.liveCoachingDefault}
          onchange={(e) => update('live', { liveCoachingDefault: (e.currentTarget as HTMLInputElement).checked })}
        />
        Live Coaching on by default in Engine Games
      </label>
      {@render said('live')}
    </section>

    <fieldset class="card" aria-label="Coach quality">
      <legend>Coach quality</legend>
      <p class="muted small">A faster model saves your Claude limits; a stronger one explains better.</p>
      {#each COACH_QUALITIES as q (q)}
        <label class="option">
          <input type="radio" name="quality" value={q} checked={settings.quality === q} onchange={() => update('quality', { quality: q })} />
          <span>
            <strong>{QUALITY_TEXT[q].name}</strong>
            <span class="muted small cost">{QUALITY_TEXT[q].cost}</span>
          </span>
        </label>
      {/each}
      {#if settings.quality === 'custom'}
        <label class="option">
          <input type="radio" name="quality" value="custom" checked disabled />
          <span>
            <strong>Custom</strong>
            <span class="muted small cost">Your own model for each job, chosen under Advanced. Pick a preset above to replace them.</span>
          </span>
        </label>
      {/if}
      {@render said('quality')}

      <details class="advanced">
        <summary>Advanced</summary>
        <p class="muted small">The model for each Coach job.</p>
        {#each COACH_JOBS as job (job)}
          <label class="model">
            <span>{JOB_NAMES[job]}</span>
            <select
              aria-label={`Model for ${JOB_NAMES[job]}`}
              value={settings.models[job]}
              onchange={(e) => update('quality', { models: { [job]: (e.currentTarget as HTMLSelectElement).value } })}
            >
              {#each Object.keys(MODEL_NAMES) as m (m)}
                <option value={m}>{MODEL_NAMES[m]}</option>
              {/each}
              {#if !Object.hasOwn(MODEL_NAMES, settings.models[job])}
                <option value={settings.models[job]}>{settings.models[job]}</option>
              {/if}
            </select>
          </label>
        {/each}
      </details>
    </fieldset>

    <section class="card" aria-label="Think deeper">
      <h2>Think deeper</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={settings.thinkDeeper}
          onchange={(e) => update('deeper', { thinkDeeper: (e.currentTarget as HTMLInputElement).checked })}
        />
        Let the Coach check its explanations with the Engine
      </label>
      <p class="muted small">
        For deeper study. In Why Questions and Reviews, the Coach can ask the Engine about other moves and where they lead before it
        answers, up to three questions each time. Answers take longer and use more of your Claude limits than usual. Hints, Live
        Coaching and Lessons stay as they are.
      </p>
      {#if haikuThinksDeeper}
        <p class="small warning" data-testid="think-deeper-haiku">
          Your Coach uses Haiku for Why Questions or Reviews.
          On Haiku, Think deeper makes answers fuller but can add mistakes.
          A stronger Coach quality, Balanced or Best, gets the most from it.
        </p>
      {/if}
      {@render said('deeper')}
    </section>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
  {#if message}<p class="error" role="alert">{message}</p>{/if}
  <!-- Shown even when the desktop can't be reached: the AGPL asks that everyone using the app over
       a network, on the Wi-Fi or through the tunnel, is offered its source (ADR 0011). -->
  <section class="card" aria-label="About">
    <h2>About OpenChessCoach</h2>
    <p class="small">
      OpenChessCoach is free software: you can read, change and share its source code under the GNU GPL, version 3 or later.
      Maia-3, the model that suggests the moves a player would reach for, is shared under the GNU AGPL, version 3.
    </p>
    <p class="small">
      <a href="https://github.com/inprealpha/OpenChessCoach" target="_blank" rel="noreferrer">Source code</a> ·
      <a href="https://github.com/inprealpha/OpenChessCoach/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">Third-party notices</a>
    </p>
  </section>
</section>

<style>
  .settings { display: flex; flex-direction: column; gap: 0.8rem; max-width: 40rem; }
  h2 { font-size: 1.05rem; margin: 0 0 0.4rem; }
  .qr { width: 220px; margin: 0.5rem 0; background: #fff; padding: 4px; border-radius: 6px; }
  .qr :global(svg) { width: 100%; height: auto; display: block; }
  .small { font-size: 0.85rem; }
  .address { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
  .code { font-family: ui-monospace, monospace; font-size: 1.4rem; font-weight: 600; letter-spacing: 0.08em; margin: 0.2rem 0 0.6rem; }
  .link { display: block; margin: 0.2rem 0; }
  .copy { font-size: 0.85rem; padding: 0.2rem 0.6rem; }
  .outcome { margin: 0.6rem 0 0; font-weight: 600; }
  .check { display: flex; gap: 0.5rem; align-items: center; }
  .model { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0.3rem 0; }
  fieldset { margin: 0; }
  /* A floated legend sits inside the card like the other cards' headings, not on its border. */
  legend { float: left; width: 100%; padding: 0; margin: 0 0 0.4rem; font-weight: 600; font-size: 1.05rem; }
  legend + * { clear: both; }
  .option { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.5rem 0; }
  .option input { margin-top: 0.25rem; }
  .cost { display: block; }
  .advanced { margin-top: 0.8rem; }
  .advanced summary { cursor: pointer; font-weight: 600; }
  .warning { margin: 0.5rem 0 0; padding: 0.4rem 0.6rem; border-left: 3px solid #b26a00; background: color-mix(in srgb, #b26a00 10%, transparent); }
</style>
