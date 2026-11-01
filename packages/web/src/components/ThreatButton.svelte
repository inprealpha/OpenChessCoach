<script lang="ts">
  // Turns the threat arrow on and off: what the opponent would play if they could move now. A
  // toggle, filled while it is on, on every screen it carries over to.
  import { threatSetting } from '../lib/threat.svelte.ts';

  $effect(() => {
    void threatSetting.load();
  });
</script>

<button
  type="button"
  class="secondary threat-button"
  aria-pressed={threatSetting.on}
  title="Show what your opponent wants to play next"
  onclick={() => threatSetting.toggle()}>Show threat</button
>

<style>
  .threat-button[aria-pressed='true'] {
    background: var(--arrow-threat);
    border-color: var(--arrow-threat);
    color: #fff;
    font-weight: 600;
  }
</style>
