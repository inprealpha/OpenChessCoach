<script lang="ts">
  // The way back while the Player tries their own line on a board that shows a position to learn
  // from (docs/design/interface-guidelines.md, Exploring a position). A screen places it twice:
  // in its header line, which shows it on a phone held upright, where the resting sheet has no
  // row to spare; and at the top of its panel, which shows it everywhere else.
  import { sheet } from '../lib/sheet.svelte.ts';

  interface Props {
    /** The button's words, such as "Back to the game". */
    back: string;
    onback: () => void;
    place: 'header' | 'panel';
  }
  let { back, onback, place }: Props = $props();
</script>

{#if place === 'header' && sheet.on}
  <button type="button" class="back" onclick={onback}>{back}</button>
{:else if place === 'panel' && !sheet.on}
  <div class="variation-bar" role="group" aria-label="Your own line">
    <span>Your own line</span>
    <button type="button" class="back" onclick={onback}>{back}</button>
  </div>
{/if}
