<script lang="ts">
  // The moves played so far, each with its Move Grade, clickable to revisit a position: two columns,
  // White's move and Black's, with the move number before White's, as on Lichess.
  // A variation the Player is trying shows on a row of its own, indented under the move it branches from.
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { moveNumberOf, turnOf, type PlayedMove } from '@chess-coach/shared/chess';
  import GradeBadge from './GradeBadge.svelte';

  interface Props {
    moves: PlayedMove[];
    grades?: (MoveGrade | undefined)[];
    cursor: number;
    ongoto?: (cursor: number) => void;
    /** The Player's variation: the game's cursor it branches from, its moves and Move Grades, and the move shown in it. */
    variation?: { from: number; moves: PlayedMove[]; grades: (MoveGrade | undefined)[]; cursor: number; ongoto: (cursor: number) => void } | undefined;
  }
  let { moves, grades = [], cursor, ongoto, variation }: Props = $props();
  let list = $state<HTMLOListElement>();

  // Keep the current move in view: the list scrolls in its own box, never the page, and jumps
  // rather than glides, so reduced motion needs nothing more. It looks again when the current
  // move's Move Grade arrives, since the badge widens the move and can wrap it onto a new row.
  function keepInView(el: HTMLOListElement): void {
    const item = variation ? el.querySelector('.variation .current') ?? el.querySelector('.variation') : el.querySelector(`[data-ply="${cursor}"]`);
    if (!item) {
      el.scrollTop = 0;
      return;
    }
    nearest(el, item);
    // The panel around the list may scroll too, as a phone's short panel does: the move stays in its view as well.
    const panel = el.closest<HTMLElement>('.panel-body');
    if (panel && panel.scrollHeight > panel.clientHeight) nearest(panel, item);
  }
  /** Scrolls `box` the least that brings `item` into its view. */
  function nearest(box: HTMLElement, item: Element): void {
    const b = box.getBoundingClientRect();
    const at = item.getBoundingClientRect();
    if (at.top < b.top) box.scrollTop -= b.top - at.top;
    else if (at.bottom > b.bottom) box.scrollTop += at.bottom - b.bottom;
  }
  $effect(() => {
    if (!list || moves.length === 0) return;
    void grades[cursor - 1];
    void variation?.cursor;
    void variation?.grades[variation.cursor - 1];
    keepInView(list);
  });
  // And when the list's box shrinks, as when the Coach's answer grows beside it.
  $effect(() => {
    const el = list;
    if (!el) return;
    const watch = new ResizeObserver(() => keepInView(el));
    watch.observe(el);
    return () => watch.disconnect();
  });

  /**
   * Where the variation's row goes: after the game's move it replaces, as on Lichess ("11. Bxf7+
   * (11. axb4 …)"), or after the last move when it carries on from the end. None while there is none.
   */
  const anchor = $derived(variation ? Math.min(variation.from + 1, moves.length) : -1);

  /** "11." for White, "11…" for Black, from the position the move was played in, so a game set up from a position keeps its numbers. */
  function label(m: PlayedMove): string {
    return `${moveNumberOf(m.fenBefore)}${turnOf(m.fenBefore) === 'white' ? '.' : '…'}`;
  }
</script>

{#snippet branch(v: NonNullable<Props['variation']>)}
  <li class="variation">
    <ol aria-label={`Variation from ${v.from === 0 ? 'the start' : `move ${label(moves[v.from - 1] as PlayedMove)} ${moves[v.from - 1]?.san}`}`}>
      {#each v.moves as m, i (i)}
        <li class:current={v.cursor === i + 1}>
          <button type="button" onclick={() => v.ongoto(i + 1)} aria-label={`Variation move ${label(m)} ${m.san}${v.grades[i] ? `, ${v.grades[i]}` : ''}`}>
            <span class="no">{label(m)}</span>
            <span class="san">{m.san}</span>
            {#if v.grades[i]}<GradeBadge grade={v.grades[i] as MoveGrade} />{/if}
          </button>
        </li>
      {/each}
    </ol>
  </li>
{/snippet}

{#if moves.length || variation}
<ol class="moves" class:exploring={variation} aria-label="Moves" bind:this={list}>
  {#if anchor === 0 && variation}{@render branch(variation)}{/if}
  {#each moves as m, i (i)}
    {@const white = turnOf(m.fenBefore) === 'white'}
    <!-- Black's move opens its own row, in Black's column, at the start of a game set up with Black to move and after a variation. -->
    <li class:current={cursor === i + 1} data-ply={i + 1} class:white class:black={!white} class:opens-black={!white && (i === 0 || anchor === i)}>
      <button type="button" onclick={() => ongoto?.(i + 1)} aria-label={`Move ${label(m)} ${m.san}${grades[i] ? `, ${grades[i]}` : ''}`}>
        <span class="no" aria-hidden="true">{label(m)}</span>
        <span class="san">{m.san}</span>
        {#if grades[i]}<GradeBadge grade={grades[i] as MoveGrade} />{/if}
      </button>
    </li>
    {#if variation && anchor === i + 1}{@render branch(variation)}{/if}
  {/each}
</ol>
{/if}

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
  /* The game's move stays marked, less strongly, while the board shows the variation. */
  .exploring > .current > button { border-style: dashed; background: none; }
  .variation { grid-column: 1 / -1; }
  .variation ol {
    list-style: none;
    margin: 0 0 0 1rem;
    padding: 0.2rem 0 0.2rem 0.6rem;
    border-left: 3px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .variation button { width: auto; }
  .variation .no { min-width: 0; }
  .no { color: var(--muted); min-width: 2.2rem; font-variant-numeric: tabular-nums; }
  /* The number shows once per row, before White's move; Black's keeps it for a screen reader only. */
  .black:not(.opens-black) .no { visibility: hidden; width: 0; min-width: 0; }
  .san { font-weight: 600; }
</style>
