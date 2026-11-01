<script lang="ts">
  // The moves played so far, each with its Move Grade, clickable to revisit a position: two columns,
  // White's move and Black's, with the move number before White's, as on Lichess.
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { moveNumberOf, turnOf, type PlayedMove } from '@chess-coach/shared/chess';
  import GradeBadge from './GradeBadge.svelte';

  interface Props {
    moves: PlayedMove[];
    grades?: (MoveGrade | undefined)[];
    cursor: number;
    ongoto?: (cursor: number) => void;
  }
  let { moves, grades = [], cursor, ongoto }: Props = $props();
  let list = $state<HTMLOListElement>();

  // Keep the current move in view: the list scrolls in its own box, never the page, and jumps
  // rather than glides, so reduced motion needs nothing more. It looks again when the current
  // move's Move Grade arrives, since the badge widens the move and can wrap it onto a new row.
  $effect(() => {
    if (!list || moves.length === 0) return;
    void grades[cursor - 1];
    const item = list.children[cursor - 1];
    if (!item) {
      list.scrollTop = 0;
      return;
    }
    const box = list.getBoundingClientRect();
    const at = item.getBoundingClientRect();
    if (at.top < box.top) list.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom) list.scrollTop += at.bottom - box.bottom;
  });

  /** "11." for White, "11…" for Black, from the position the move was played in, so a game set up from a position keeps its numbers. */
  function label(m: PlayedMove): string {
    return `${moveNumberOf(m.fenBefore)}${turnOf(m.fenBefore) === 'white' ? '.' : '…'}`;
  }
</script>

<ol class="moves" aria-label="Moves" bind:this={list}>
  {#each moves as m, i (i)}
    {@const white = turnOf(m.fenBefore) === 'white'}
    <li class:current={cursor === i + 1} class:white class:black={!white} class:opens-black={i === 0 && !white}>
      <button type="button" onclick={() => ongoto?.(i + 1)} aria-label={`Move ${label(m)} ${m.san}${grades[i] ? `, ${grades[i]}` : ''}`}>
        <span class="no" aria-hidden="true">{label(m)}</span>
        <span class="san">{m.san}</span>
        {#if grades[i]}<GradeBadge grade={grades[i] as MoveGrade} />{/if}
      </button>
    </li>
  {/each}
</ol>

<style>
  .moves {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.15rem 0.25rem;
    max-height: min(40vh, 18rem);
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.25rem;
  }
  .moves:empty { display: none; }
  /* A game set up with Black to move opens in Black's column. */
  .opens-black { grid-column: 2; }
  button {
    width: 100%;
    display: flex;
    gap: 0.3rem;
    align-items: center;
    border: 1px solid transparent;
    background: none;
    color: inherit;
    border-radius: 6px;
    padding: 0.2rem 0.4rem;
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
  }
  button:hover { background: var(--bg); }
  .current button { border-color: var(--accent); background: var(--bg); }
  .no { color: var(--muted); min-width: 2.2rem; font-variant-numeric: tabular-nums; }
  /* The number shows once per row, before White's move; Black's keeps it for a screen reader only. */
  .black:not(.opens-black) .no { visibility: hidden; width: 0; min-width: 0; }
  .san { font-weight: 600; }
</style>
