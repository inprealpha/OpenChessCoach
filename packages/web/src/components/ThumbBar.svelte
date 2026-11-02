<script lang="ts">
  // The thumb bar on its own, at the panel's foot, where a screen has step buttons but no Ask box
  // (a finished Engine Game with nothing from the Coach). With an Ask box the Coach's panel carries
  // the steps itself (CoachPanel's `steps`).
  import type { Snippet } from 'svelte';
  let { steps }: { steps: Snippet<['back' | 'on']> } = $props();
</script>

<div class="thumb-bar"><div class="thumb-row">{@render steps('back')}{@render steps('on')}</div></div>
