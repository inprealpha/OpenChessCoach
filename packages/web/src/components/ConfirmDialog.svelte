<script lang="ts">
  import { reveal } from '../lib/reveal.ts';
  // A question asked in place before a game is ended or abandoned. Focus starts on the safe choice,
  // so a stray Enter changes nothing, and Escape is the same as the safe choice.
  interface Props {
    /** Prefix for the title's and detail's ids. */
    id: string;
    title: string;
    detail: string;
    keepLabel: string;
    confirmLabel: string;
    onkeep: () => void;
    onconfirm: () => void;
  }
  let { id, title, detail, keepLabel, confirmLabel, onkeep, onconfirm }: Props = $props();

  let keepButton = $state<HTMLButtonElement>();
  let card = $state<HTMLDivElement>();
  $effect(() => {
    keepButton?.focus({ preventScroll: true });
    // The whole question in view, its heading first: focusing the button alone would scroll a
    // phone's short panel only as far as the button, cutting the question off above it.
    const panel = card?.closest<HTMLElement>('.panel-body');
    if (card && panel && panel.scrollHeight > panel.clientHeight) reveal(panel, card, 'start');
    else card?.scrollIntoView({ block: 'nearest' });
  });
</script>

<!-- Escape keeps playing wherever focus is, even after a click on the board moved it away. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') onkeep();
  }}
/>

<div class="card confirm" bind:this={card} role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} tabindex="-1">
  <p id={`${id}-title`}><strong>{title}</strong></p>
  <p id={`${id}-detail`} class="muted">{detail}</p>
  <div class="row">
    <button type="button" onclick={onkeep} bind:this={keepButton}>{keepLabel}</button>
    <button type="button" class="secondary" onclick={onconfirm}>{confirmLabel}</button>
  </div>
</div>

<style>
  .confirm { margin-top: 0.6rem; }
  .confirm p { margin: 0 0 0.4rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
