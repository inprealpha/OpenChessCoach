<script lang="ts" generics="T extends string">
  // The tabs at the top of a board screen's panel (the Review's Moments, Moves and Overview; the
  // Board's Lines, Moves and Coach), stuck to the panel's top while its content scrolls. Each tab
  // controls the tab panel `panel-<id>`, which the screen draws with `hidden` when it isn't picked.
  interface Tab {
    id: T;
    /** What the tab says. */
    name: string;
    /** Its accessible name, where it says more than `name` ("Overview, not read yet"). */
    label?: string;
    /** A dot after its name: something in it not read yet. */
    dot?: boolean;
  }

  let { tabs, current, label, onpick }: { tabs: readonly Tab[]; current: T; label: string; onpick: (id: T) => void } = $props();
</script>

<div class="tabs" role="tablist" aria-label={label}>
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      id={`tab-${t.id}`}
      aria-controls={`panel-${t.id}`}
      aria-selected={current === t.id}
      class:on={current === t.id}
      onclick={() => onpick(t.id)}
      aria-label={t.label}>{t.name}{#if t.dot}<span class="new-dot" aria-hidden="true"></span>{/if}</button
    >
  {/each}
</div>

<style>
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 1; margin-inline: calc(-1 * var(--panel-pad)); padding-inline: calc(var(--panel-pad) - 0.25rem); }
  .tabs button { background: none; color: var(--muted); border-radius: 0; padding: 0.45rem 0.75rem; min-height: 2.5rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button.on { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  /* Something not read yet: a dot on its tab, not a row that costs a phone's sheet a line. */
  .new-dot { display: inline-block; width: 0.45rem; height: 0.45rem; margin-left: 0.3rem; border-radius: 50%; background: var(--accent); vertical-align: 0.15rem; }
  @media (max-width: 820px) {
    .tabs button { min-height: var(--tap); }
  }
</style>
