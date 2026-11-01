<script lang="ts">
  // The step buttons under a board, and Lichess's keys for them anywhere on the page: ← and → step
  // one move, Home or ↑ jump to the start, End or ↓ to the end. A key does just what its button
  // does, so each screen decides what a step means. A key is left alone while the Player types,
  // while a dialog is open, with a modifier held (Alt+← is the browser's Back), or when a control
  // has used it already (the Winning Chances graph has arrow keys of its own).
  interface Props {
    onfirst: () => void;
    onprevious: () => void;
    onnext: () => void;
    onlast: () => void;
  }
  let { onfirst, onprevious, onnext, onlast }: Props = $props();

  const KEYS: Partial<Record<string, () => void>> = {
    ArrowLeft: () => onprevious(),
    ArrowRight: () => onnext(),
    Home: () => onfirst(),
    ArrowUp: () => onfirst(),
    End: () => onlast(),
    ArrowDown: () => onlast(),
  };

  function onkeydown(e: KeyboardEvent): void {
    const step = KEYS[e.key];
    if (!step || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
    e.preventDefault();
    step();
  }
</script>

<svelte:window {onkeydown} />

<!-- Drawn, not typed: ⏮ and ⏭ are emoji on iOS and some Android phones, coloured and out of step with the rest. -->
{#snippet icon(d: string)}<svg class="step-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path {d} /></svg>{/snippet}
<button type="button" class="secondary step" onclick={onfirst} aria-label="First position" aria-keyshortcuts="Home ArrowUp" title="First position (Home or ↑)">{@render icon('M6 5h2.4v14H6zM19 5v14L9.5 12z')}</button>
<button type="button" class="secondary step" onclick={onprevious} aria-label="Previous move" aria-keyshortcuts="ArrowLeft" title="Previous move (←)">{@render icon('M17 5v14L6.5 12z')}</button>
<button type="button" class="secondary step" onclick={onnext} aria-label="Next move" aria-keyshortcuts="ArrowRight" title="Next move (→)">{@render icon('M7 5v14l10.5-7z')}</button>
<button type="button" class="secondary step" onclick={onlast} aria-label="Last position" aria-keyshortcuts="End ArrowDown" title="Last position (End or ↓)">{@render icon('M15.6 5H18v14h-2.4zM5 5v14l9.5-7z')}</button>

<style>
  .step { display: inline-flex; align-items: center; justify-content: center; }
  .step-icon { display: block; }
</style>
