<script lang="ts">
  // The grab handle at the top of a phone's panel sheet (lib/sheet.svelte.ts): a tap or a swipe on
  // it pulls the sheet up or lets it down; a swipe in the panel does too. A screen opens with it
  // down. Not shown where the frame has no sheet. PROTOTYPE (#80): its taps and drags belong to the
  // version in use (lib/sheet-variants/).
  import { untrack } from 'svelte';
  import { sheet } from '../lib/sheet.svelte.ts';

  $effect(() => {
    untrack(() => (sheet.full = false));
  });
</script>

{#if sheet.on}
  <button
    type="button"
    class="sheet-handle"
    aria-expanded={sheet.full}
    aria-label={sheet.full ? 'Let the panel down' : 'Pull the panel up'}
    title={sheet.full ? 'Let the panel down: the board full size' : 'Pull the panel up: more room to read'}
    {@attach sheet.handle}><span aria-hidden="true"></span></button
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
    height: 0.9rem;
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
