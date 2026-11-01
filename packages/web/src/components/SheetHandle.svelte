<script lang="ts">
  // The grab handle at the top of a phone's panel sheet (lib/sheet.svelte.ts): a tap or a swipe on
  // it pulls the sheet up or lets it down; a swipe in the panel does too. Not shown where the frame
  // has no sheet.
  import type { Sheet } from '../lib/sheet.svelte.ts';
  import { afterSwipe } from '../lib/swipe.ts';

  let { sheet }: { sheet: Sheet } = $props();
  let startY: number | null = null;
  /** A swipe moved the sheet: the click that ends it is not a tap. */
  let swiped = false;

  function down(e: PointerEvent): void {
    startY = e.clientY;
    swiped = false;
  }
  function move(e: PointerEvent): void {
    if (startY === null) return;
    const next = afterSwipe(sheet.full, e.clientY - startY, 0);
    if (next === sheet.full) return;
    sheet.full = next;
    swiped = true;
    startY = null;
  }
  function click(): void {
    if (!swiped) sheet.toggle();
    swiped = false;
  }
</script>

{#if sheet.on}
  <button
    type="button"
    class="sheet-handle"
    aria-expanded={sheet.full}
    aria-label="Expand the panel"
    title={sheet.full ? 'Show the board full size' : 'Give the panel more room'}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (startY = null)}
    onpointercancel={() => (startY = null)}
    onclick={click}><span aria-hidden="true"></span></button
  >
{/if}

<style>
  /* The sheet's whole top edge, so the thumb finds it, drawn as the usual short grabber bar. */
  .sheet-handle {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 1.1rem;
    /* A full-width strip, not a small target: the phone's 44 px floor for buttons (app.css) doesn't apply. */
    min-height: 0 !important;
    padding: 0;
    margin: 0;
    background: none;
    border: 0;
    border-radius: 14px 14px 0 0;
    touch-action: none;
    cursor: grab;
  }
  .sheet-handle span { display: block; width: 2.75rem; height: 0.3rem; border-radius: 99px; background: var(--line); }
  .sheet-handle:hover span, .sheet-handle:focus-visible span { background: var(--muted); }
  @media (prefers-color-scheme: dark) { .sheet-handle span { background: #4a524c; } }
</style>
