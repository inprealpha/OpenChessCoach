<script lang="ts">
  // Turns the threat arrow on and off: what the opponent would play if they could move now. A
  // toggle, filled while it is on, on every screen it carries over to. With the screen's ThreatView,
  // it says so when the Engine found no threat, so an empty board doesn't look broken.
  import { threatSetting, type ThreatView } from '../lib/threat.svelte.ts';

  let { view }: { view?: ThreatView } = $props();

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
<span class="no-threat" role="status">{threatSetting.on && view?.checked && !view.threat ? 'No threat' : ''}</span>

<style>
  .no-threat { font-size: 0.8rem; color: var(--muted); }
  .no-threat:empty { display: none; }
  .threat-button[aria-pressed='true'] {
    background: var(--arrow-threat);
    border-color: var(--arrow-threat);
    color: #fff;
    font-weight: 600;
  }
</style>
