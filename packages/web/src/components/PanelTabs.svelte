<script lang="ts" generics="T extends string">
  // The tabs at the top of a board screen's panel (the Review's Moments, Moves and Overview; the
  // Board's Lines, Moves and Coach), stuck to the panel's top while its content scrolls. Each tab
  // controls the tab panel `panel-<id>`, which the screen draws with `hidden` when it isn't picked.
  // As the WAI-ARIA tabs pattern has it, Tab reaches the picked tab only, and ← → Home End move
  // between the tabs and pick them once the keyboard has brought the focus there; the tablist then
  // takes those keys, so the step buttons' keys don't also step the board.
  import { tick } from 'svelte';

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

  let list = $state<HTMLDivElement>();
  /** The focus came into the tabs with a click or a tap, not the keyboard. */
  let byPointer = false;

  function onfocusout(e: FocusEvent): void {
    if (!list?.contains(e.relatedTarget as Node | null)) byPointer = false;
  }

  async function onkeydown(e: KeyboardEvent): Promise<void> {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Only for a Player moving through the tabs by keyboard: a tab clicked with the mouse keeps the
    // focus too, and there ← → still step the board, as on every board screen.
    if (byPointer) return;
    const at = tabs.findIndex((t) => t.id === current);
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    if (!next) return;
    onpick(next.id);
    await tick();
    list?.querySelector<HTMLButtonElement>(`#tab-${next.id}`)?.focus();
  }
</script>

<div class="tabs" role="tablist" aria-label={label} tabindex="-1" bind:this={list} {onkeydown} {onfocusout} onpointerdown={() => (byPointer = true)}>
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      id={`tab-${t.id}`}
      aria-controls={`panel-${t.id}`}
      aria-selected={current === t.id}
      tabindex={current === t.id ? 0 : -1}
      class:on={current === t.id}
      onclick={() => onpick(t.id)}
      aria-label={t.label}>{t.name}{#if t.dot}<span class="new-dot" aria-hidden="true"></span>{/if}</button
    >
  {/each}
</div>

<style>
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 1; margin-inline: calc(-1 * var(--panel-pad)); padding-inline: calc(var(--panel-pad) - 0.25rem); }
  .tabs:focus { outline: none; }
  .tabs button { background: none; color: var(--muted); border-radius: 0; padding: 0.45rem 0.75rem; min-height: 2.5rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button.on { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  /* Something not read yet: a dot on its tab, not a row that costs a phone's sheet a line. */
  .new-dot { display: inline-block; width: 0.45rem; height: 0.45rem; margin-left: 0.3rem; border-radius: 50%; background: var(--accent); vertical-align: 0.15rem; }
  @media (max-width: 820px) {
    .tabs button { min-height: var(--tap); }
  }
</style>
