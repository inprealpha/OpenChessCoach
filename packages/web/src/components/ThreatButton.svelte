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
  >{#if none}No threat{:else}<svg class="t-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4l9 15.5H3z M12 10v4.5 M12 17.2v.3" /></svg><span class="words-long">Show threat</span><span class="words-short">Threat</span>{/if}</button
>
<!-- Said on the button itself, so it takes no room beside it; announced here. -->
<span class="visually-hidden" role="status">{none ? 'No threat' : ''}</span>

<style>
  /* "Threat", as in the sketches, where a phone's bar is short of room (app.css). */
  .words-short { display: none; }
  /* The icon stands in for the words in a phone's header line (app.css). */
  .t-icon { display: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .threat-button[aria-pressed='true'] {
    background: var(--arrow-threat);
    border-color: var(--arrow-threat);
    color: #fff;
    font-weight: 600;
  }
</style>
