<script lang="ts">
  // Flip board, on every board, and the F key for it anywhere on the page. The key is left alone
  // while the Player types, while a dialog is open, or with a modifier held, as the step keys are.
  let { onflip }: { onflip: () => void } = $props();

  function onkeydown(e: KeyboardEvent): void {
    if ((e.key !== 'f' && e.key !== 'F') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
    e.preventDefault();
    onflip();
  }
</script>

<svelte:window {onkeydown} />

<!-- On a phone the arrows alone, so the board bar keeps to one row; the name stays "Flip board". -->
<button type="button" class="secondary flip" onclick={onflip} aria-label="Flip board" aria-keyshortcuts="F" title="Flip board (F)"
  ><span aria-hidden="true" class="icon">⇅</span><span aria-hidden="true" class="words">Flip board</span></button
>

<style>
  .icon { font-weight: 700; }
  .words { margin-left: 0.3rem; }
  @media (max-width: 820px) {
    .words { display: none; }
  }
</style>
