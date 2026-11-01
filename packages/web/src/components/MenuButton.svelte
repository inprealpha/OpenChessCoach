<script lang="ts">
  // A small menu for actions that end or clear something (Offer a draw, Resign, New game), kept
  // away from the board tools the Player uses on every move. Escape or a click elsewhere closes it.
  import type { Snippet } from 'svelte';

  interface Props {
    /** The button's visible text, such as "⋯ Game". */
    text: string;
    /** Its accessible name, such as "Game options". */
    label: string;
    /** The menu's items: buttons with role="menuitem". A click on any of them closes the menu. */
    children: Snippet;
  }
  let { text, label, children }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement>();
  let toggle = $state<HTMLButtonElement>();

  function onwindowclick(e: MouseEvent): void {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') {
      open = false;
      toggle?.focus();
    }
  }

  function onmenuclick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('[role="menuitem"]')) open = false;
  }

  /** Puts focus back on the menu's button, as after a question its item asked is answered. */
  export function focus(): void {
    toggle?.focus();
  }

  $effect(() => {
    if (open) root?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  });
</script>

<svelte:window onclick={onwindowclick} {onkeydown} />

<div class="menu-button" bind:this={root}>
  <button type="button" class="secondary" aria-haspopup="menu" aria-expanded={open} aria-label={label} bind:this={toggle} onclick={() => (open = !open)}
    >{text}</button
  >
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="menu" role="menu" aria-label={label} tabindex="-1" onclick={onmenuclick}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .menu-button { position: relative; display: inline-block; }
  .menu {
    position: absolute;
    bottom: calc(100% + 0.3rem);
    right: 0;
    z-index: 20;
    min-width: 11rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.3rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  }
  .menu :global([role='menuitem']) {
    background: none;
    color: var(--text);
    text-align: left;
    border-radius: 6px;
    min-height: var(--tap);
  }
  .menu :global([role='menuitem']:hover:not(:disabled)) { background: var(--bg); }
  .menu :global([role='menuitem'].danger) { color: var(--danger); }
</style>
