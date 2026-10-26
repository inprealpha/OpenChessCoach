<script lang="ts">
  // Turns the threat arrow on and off: what the opponent would play if they could move now.
  import { THREAT_COLOR } from '../lib/arrows.ts';
  import { threatSetting } from '../lib/threat.svelte.ts';

  $effect(() => {
    void threatSetting.load();
  });
</script>

<button
  type="button"
  class="secondary threat-button"
  aria-pressed={threatSetting.on}
  style:--threat={THREAT_COLOR}
  title="Show what your opponent wants to play next"
  onclick={() => threatSetting.toggle()}>Threat</button
>

<style>
  .threat-button[aria-pressed='true'] {
    border-color: var(--threat);
    color: var(--threat);
    font-weight: 600;
  }
</style>
