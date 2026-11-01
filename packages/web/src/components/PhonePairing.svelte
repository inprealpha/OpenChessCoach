<script lang="ts">
  // How to open the app on a phone: three steps beside the QR code, the address and pairing code
  // for a phone whose camera opens no link, and, once a phone pairs, a line that says so. Shown by
  // first run's first step and the main menu's reminder. With `hideCode`, as in the reminder, which
  // opens without the Player asking, the QR code and pairing code wait for "Show the code": anyone
  // who sees them, on a screen share say, can pair a device.
  //
  // A phone kept out by the desktop's firewall, a guest Wi-Fi or a VPN gets no answer at all, and
  // the desktop can't test for it (#31). So when the QR code has been up for a while with no phone,
  // "Phone can't open it?" offers "Connect another way": the away-from-home tunnel, which the
  // desktop opens outwards, and its QR code in place of the Wi-Fi one. Pairing still applies.
  import { tick } from 'svelte';
  import type { PairingInfo } from '@chess-coach/shared/protocol';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { pairingCode } from '../lib/pairing-code.ts';
  import { phone } from '../lib/phone.svelte.ts';

  /** How long the QR code is up, with no phone paired, before "Phone can't open it?" shows. */
  const NO_PHONE_MS = 2 * 60 * 1000;

  let { info, hideCode = false }: { info: PairingInfo; hideCode?: boolean } = $props();

  let asked = $state(false);
  let noLink = $state<HTMLElement>();
  /** The QR code has been up for `NO_PHONE_MS` with no phone. */
  let waited = $state(false);
  /** The Player pressed "Connect another way". */
  let anotherWay = $state(false);
  let failed = $state('');
  let news = $state<HTMLElement>();

  const paired = $derived(info.phone.paired);
  const shown = $derived(!hideCode || asked);
  // From the same answer as the QR codes, so the address shown and the code always match.
  const tunnel = $derived(info.tunnel);
  /** Showing the tunnel's QR code rather than the Wi-Fi one. */
  const viaTunnel = $derived(anotherWay && tunnel.status === 'running' && info.tunnelQrSvg !== null && info.tunnelPairUrl !== null);
  /** Connecting another way didn't work: the desktop couldn't be asked, or the tunnel failed. */
  const broken = $derived(anotherWay && (failed !== '' || tunnel.status === 'error'));

  $effect(() => {
    if (!shown || paired || waited) return;
    const timer = setTimeout(() => (waited = true), NO_PHONE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    // Each change of the tunnel (starting, running, a new address, failed) means new QR codes: fetch them.
    void api.tunnel?.status;
    void api.tunnel?.url;
    if (anotherWay) void phone.load();
  });

  async function connectAnotherWay(): Promise<void> {
    failed = '';
    anotherWay = true;
    try {
      // Saved like the Away from home checkbox in Settings, so the tunnel comes back after a restart.
      await api.request('settings.update', { tunnelEnabled: true });
      await phone.load();
    } catch (err) {
      failed = err instanceof ApiError ? err.message : 'Connecting another way didn’t work.';
    }
    // The button goes: keep the focus on the news that replaced it.
    await tick();
    news?.focus();
  }

  async function show(): Promise<void> {
    asked = true;
    // The button goes: keep the focus nearby, on what replaced it.
    await tick();
    noLink?.focus();
  }
</script>

<div class="phone-pairing">
  {#if !paired}
    <div class="how">
      <ol>
        {#if !viaTunnel}<li>Connect your phone to the same Wi-Fi as this desktop.</li>{/if}
        <li>Open your phone’s camera and point it at the code.</li>
        <li>Tap the link that appears. The app opens on your phone, already paired.</li>
      </ol>
      {#if !viaTunnel && info.systemPrompt}<p class="muted small">{info.systemPrompt}</p>{/if}
      <p class="muted small">Keep OpenChessCoach running on this desktop while you play: your phone uses it for the Coach.</p>
      {#if shown}
        <details>
          <summary bind:this={noLink}>No link appears?</summary>
          <p class="small">
            Open <span class="address">{viaTunnel ? tunnel.url : info.lanUrl}</span> in your phone’s browser and type this pairing code:
          </p>
          <p class="code" data-testid="phone-pairing-code">{pairingCode(info.pairUrl)}</p>
        </details>
        <!-- There from the start, so a screen reader reads each step of connecting another way. Not a
             second status: the one below says when the phone pairs. -->
        <div aria-live="polite" class="another-way" tabindex="-1" bind:this={news} data-testid="another-way">
          {#if viaTunnel}
            <p class="small">
              <strong>Scan this new code.</strong> It reaches this desktop through Cloudflare, so it works on any network, mobile data
              too. Its address changes each time OpenChessCoach starts: after a restart, scan the new code in Settings, under Away
              from home.
            </p>
          {:else if anotherWay && !broken}
            <p class="small">Connecting another way… The first time, this can take a minute.</p>
          {:else if waited}
            <p class="small">
              <strong>Phone can’t open it?</strong> Something on this desktop or your Wi-Fi may be keeping your phone out. Connect
              another way instead: through Cloudflare, which works on any network. Its address changes each time OpenChessCoach
              starts, so you scan again after a restart.
            </p>
            {#if broken}
              <p class="small error">{failed || 'Connecting another way didn’t work.'} Check this desktop is online, then try again.</p>
            {/if}
          {/if}
        </div>
        {#if waited && !anotherWay}
          <button type="button" onclick={connectAnotherWay}>Connect another way</button>
        {:else if broken}
          <button type="button" onclick={connectAnotherWay}>Try again</button>
        {/if}
      {:else}
        <p class="muted small">Anyone who sees the code can pair a device with this desktop, so check nobody else can see your screen.</p>
        <button type="button" onclick={show}>Show the code</button>
      {/if}
    </div>
    {#if shown}
      {#if viaTunnel}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- the desktop draws this SVG from its own tunnel URL -->
        <figure class="qr" aria-label="Pairing QR code" data-way="tunnel">{@html info.tunnelQrSvg}</figure>
      {:else}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- the desktop draws this SVG from its own pairing URL -->
        <figure class="qr" aria-label="Pairing QR code" data-way="wifi">{@html info.qrSvg}</figure>
      {/if}
    {/if}
  {/if}
  <!-- There from the start, so a screen reader reads the news when the phone pairs. -->
  <div role="status" class="paired">
    {#if paired}
      <p><strong>Your phone is paired.</strong> Open the app there whenever OpenChessCoach is running on this desktop.</p>
      {#if anotherWay}
        <p class="muted small">It connected through Cloudflare, whose address changes each time OpenChessCoach starts: after a restart, scan the new code in Settings, under Away from home.</p>
      {/if}
      <p class="muted small">On your phone, add it to the Home Screen from the browser’s Share or ⋮ menu, to open it from there next time.</p>
    {/if}
  </div>
</div>

<style>
  .phone-pairing { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; align-items: flex-start; }
  .how { flex: 1 1 16rem; }
  ol { margin: 0 0 0.6rem; padding-left: 1.3rem; }
  li { margin: 0.3rem 0; }
  .qr { flex: 0 0 auto; width: 200px; margin: 0; background: #fff; padding: 4px; border-radius: 6px; }
  .qr :global(svg) { width: 100%; height: auto; display: block; }
  .small { font-size: 0.85rem; }
  .muted.small { margin: 0 0 0.5rem; }
  summary { cursor: pointer; font-size: 0.9rem; }
  .address { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
  .code { font-family: ui-monospace, monospace; font-size: 1.2rem; font-weight: 600; letter-spacing: 0.08em; margin: 0.2rem 0 0; }
  .another-way:focus { outline: none; }
  .another-way p { margin: 0.6rem 0 0.5rem; }
  .paired { flex-basis: 100%; }
  .paired p { margin: 0 0 0.4rem; }
  .paired p:last-child { margin-bottom: 0; }
</style>
