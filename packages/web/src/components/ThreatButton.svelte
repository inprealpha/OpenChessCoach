<script lang="ts">
  // Turns the threat arrow on and off: what the opponent would play if they could move now. A
  // toggle, filled while it is on, on every screen it carries over to. With the screen's ThreatView,
  // it says so when the Engine found no threat, so an empty board doesn't look broken.
  import { threatSetting, type ThreatView } from '../lib/threat.svelte.ts';

  let { view }: { view?: ThreatView } = $props();
  /** On, and the Engine found no threat in the position shown. */
  const none = $derived(threatSetting.on && Boolean(view?.checked) && !view?.threat);

  $effect(() => {
    void threatSetting.load();
  });
</script>

<button
  type="button"
  class="secondary threat-button"
  aria-pressed={threatSetting.on}
  aria-label="Show threat"
  title="Show what your opponent wants to play next"
  onclick={() => threatSetting.toggle()}
  >{#if none}No threat{:else}<span class="words-long">Show threat</span><span class="words-short">Threat</span>{/if}</button
>
<!-- Said on the button itself, so it takes no room beside it; announced here. -->
<span class="visually-hidden" role="status">{none ? 'No threat' : ''}</span>

<style>
  /* "Threat", as in the sketches, where a phone's bar is short of room (app.css). */
  .words-short { display: none; }
  .threat-button[aria-pressed='true'] {
    background: var(--arrow-threat);
    border-color: var(--arrow-threat);
    color: #fff;
    font-weight: 600;
  }
</style>
