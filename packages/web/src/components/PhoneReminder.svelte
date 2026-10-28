<script lang="ts">
  // The main menu's reminder to pair a phone, for a Player who finished first run on a desktop
  // without one: shown once per visit to the menu while the desktop says to ask. Escape counts as
  // "I'll do it later", so closing it never brings it straight back. It opens unasked, perhaps on a
  // screen share, so the codes stay hidden until the Player asks for them.
  import { api } from '../lib/api.svelte.ts';
  import { phone } from '../lib/phone.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { onPhoneOrTablet } from '../lib/this-device.ts';
  import PhonePairing from './PhonePairing.svelte';

  let dialog = $state<HTMLDialogElement>();
  let heading = $state<HTMLHeadingElement>();
  let done = $state<HTMLButtonElement>();
  /** Asked already on this visit to the menu: a "later" that didn't reach the desktop doesn't ask again at once. */
  let asked = false;

  const due = $derived(
    !onPhoneOrTablet && api.state === 'online' && profile.profile?.onboarded === true && phone.info?.phone.remind === true,
  );

  $effect(() => {
    if (!due || !dialog || asked) return;
    asked = true;
    dialog.showModal();
    // From the top, so a screen reader starts with the heading rather than a control halfway down.
    heading?.focus();
  });

  // When the phone pairs, Done replaces the button that may have had the focus: keep the focus in the dialog.
  $effect(() => {
    if (done && dialog?.open && !dialog.contains(document.activeElement)) done.focus();
  });

  function later(never: boolean): void {
    dialog?.close();
    if (!phone.info?.phone.paired) void phone.later(never);
  }
</script>

<dialog bind:this={dialog} class="card" aria-labelledby="phone-reminder-title" oncancel={() => later(false)}>
  <h2 id="phone-reminder-title" tabindex="-1" bind:this={heading}>Play on your phone</h2>
  <p>OpenChessCoach works best on your phone. This desktop does the Coach’s work, and your phone connects to it over your Wi-Fi.</p>
  {#if phone.info}<PhonePairing info={phone.info} hideCode />{/if}
  <div class="row">
    {#if phone.info?.phone.paired}
      <button type="button" bind:this={done} onclick={() => dialog?.close()}>Done</button>
    {:else}
      <!-- Both quiet: the QR code is what the Player should act on. -->
      <button type="button" class="secondary" onclick={() => later(false)}>I’ll do it later</button>
      <button type="button" class="secondary" onclick={() => later(true)}>Don’t ask again</button>
    {/if}
  </div>
</dialog>

<style>
  dialog {
    width: min(42rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    color: var(--text);
    padding: 1.1rem 1.25rem;
  }
  dialog::backdrop { background: rgb(0 0 0 / 0.55); }
  h2 { font-size: 1.3rem; margin: 0 0 0.4rem; }
  h2:focus { outline: none; }
  dialog > p { margin: 0 0 0.9rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
</style>
