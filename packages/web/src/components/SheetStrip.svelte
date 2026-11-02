<script lang="ts">
  // The board as a strip while a phone's panel sheet is pulled up (lib/sheet.svelte.ts): the whole
  // of it, with its Winning Chances bar, is one button that brings it back full size, to read or
  // to move on. Placed first in the frame's `.board-and-bar`.
  import { sheet } from '../lib/sheet.svelte.ts';
</script>

{#if sheet.shown}
  <button type="button" class="strip-tap" aria-label="Show the board full size" onclick={() => (sheet.full = false)}></button>
{/if}

<style>
  .strip-tap { position: absolute; inset: 0; z-index: 5; background: transparent; border: 0; padding: 0; border-radius: 4px; cursor: zoom-in; }
</style>
