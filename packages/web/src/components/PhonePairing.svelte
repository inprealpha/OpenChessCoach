<script lang="ts">
  // How to open the app on a phone: three steps beside the QR code, the address and pairing code
  // for a phone whose camera opens no link, and, once a phone pairs, a line that says so. Shown by
  // first run's first step and the main menu's reminder. With `hideCode`, as in the reminder, which
  // opens without the Player asking, the QR code and pairing code wait for "Show the code": anyone
  // who sees them, on a screen share say, can pair a device.
  import { tick } from 'svelte';
  import type { PairingInfo } from '@chess-coach/shared/protocol';
  import { pairingCode } from '../lib/pairing-code.ts';

  let { info, hideCode = false }: { info: PairingInfo; hideCode?: boolean } = $props();

  let asked = $state(false);
  let noLink = $state<HTMLElement>();

  const paired = $derived(info.phone.paired);
  const shown = $derived(!hideCode || asked);

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
        <li>Connect your phone to the same Wi-Fi as this desktop.</li>
        <li>Open your phone’s camera and point it at the code.</li>
        <li>Tap the link that appears. The app opens on your phone, already paired.</li>
      </ol>
      <p class="muted small">Keep OpenChessCoach running on this desktop while you play: your phone uses it for the Coach.</p>
      {#if shown}
        <details>
          <summary bind:this={noLink}>No link appears?</summary>
          <p class="small">Open <span class="address">{info.lanUrl}</span> in your phone’s browser and type this pairing code:</p>
          <p class="code" data-testid="phone-pairing-code">{pairingCode(info.pairUrl)}</p>
        </details>
      {:else}
        <p class="muted small">Anyone who sees the code can pair a device with this desktop, so check nobody else can see your screen.</p>
        <button type="button" onclick={show}>Show the code</button>
      {/if}
    </div>
    {#if shown}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- the desktop draws this SVG from its own pairing URL -->
      <figure class="qr" aria-label="Pairing QR code">{@html info.qrSvg}</figure>
    {/if}
  {/if}
  <!-- There from the start, so a screen reader reads the news when the phone pairs. -->
  <div role="status" class="paired">
    {#if paired}
      <p><strong>Your phone is paired.</strong> Open the app there whenever OpenChessCoach is running on this desktop.</p>
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
  .paired { flex-basis: 100%; }
  .paired p { margin: 0 0 0.4rem; }
  .paired p:last-child { margin-bottom: 0; }
</style>
