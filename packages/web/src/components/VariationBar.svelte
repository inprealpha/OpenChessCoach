<script lang="ts">
  // At the top of the panel while the Player tries their own line on a board that shows a position
  // to learn from (docs/design/interface-guidelines.md, Exploring a position): the one way back,
  // where the panel's scrolling never hides it and nothing crowds the header line.
  interface Props {
    /** The button's words, such as "Back to the game". */
    back: string;
    onback: () => void;
  }
  let { back, onback }: Props = $props();
</script>

<div class="variation-bar" role="group" aria-label="Your own line">
  <span>Your own line</span>
  <button type="button" class="back" onclick={onback}>{back}</button>
</div>
