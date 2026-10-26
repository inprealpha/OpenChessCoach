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

<button type="button" class="secondary" onclick={onfirst} aria-label="First position" aria-keyshortcuts="Home ArrowUp" title="First position (Home or ↑)">⏮</button>
<button type="button" class="secondary" onclick={onprevious} aria-label="Previous move" aria-keyshortcuts="ArrowLeft" title="Previous move (←)">◀</button>
<button type="button" class="secondary" onclick={onnext} aria-label="Next move" aria-keyshortcuts="ArrowRight" title="Next move (→)">▶</button>
<button type="button" class="secondary" onclick={onlast} aria-label="Last position" aria-keyshortcuts="End ArrowDown" title="Last position (End or ↓)">⏭</button>
