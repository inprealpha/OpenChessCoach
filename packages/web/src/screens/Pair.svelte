<script lang="ts">
  // Shown to a device without a valid token: it is refused until it pairs (ADR 0001).
  import { api } from '../lib/api.svelte.ts';

  let code = $state('');
  let busy = $state(false);

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    const ok = await api.pair(code.trim());
    busy = false;
    if (ok) location.reload();
  }
</script>

<section class="screen pair">
  <h1>This device isn’t paired</h1>
  <p>
    To use the Coach, scan the QR code shown in the terminal on your desktop, or open Settings on a paired device. You can also
    type the pairing code here.
  </p>
  <form onsubmit={submit}>
    <label for="pair-code">Pairing code</label>
    <input id="pair-code" bind:value={code} autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" />
    <button type="submit" disabled={busy || !code.trim()}>Pair this device</button>
  </form>
  {#if api.pairError}<p class="error" role="alert">{api.pairError}</p>{/if}
</section>

<style>
  .pair { max-width: 34rem; }
  form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  label { width: 100%; font-weight: 600; }
</style>
