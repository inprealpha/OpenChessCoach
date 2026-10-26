<script lang="ts">
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
  $effect(() => {
    keepButton?.focus();
  });
</script>

<!-- Escape keeps playing wherever focus is, even after a click on the board moved it away. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') onkeep();
  }}
/>

<div class="card confirm" role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`} tabindex="-1">
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
