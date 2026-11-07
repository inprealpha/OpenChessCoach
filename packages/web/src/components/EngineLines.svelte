<script lang="ts">
  // The Engine's best lines on the Board's Lines tab: the top line, and the rest behind "More
  // lines". Each leads with White's Winning Chances after it, as the bar and the Review's graph
  // show them, with the evaluation smaller beside them, then its moves with their numbers ("14.
  // Nxd5 Qxd5 15. c4"). Every move is a button: hovering or focusing it shows the position after
  // it on the board, and a click or tap tries the line up to it as a variation (#52).
  import type { Analysis } from '@chess-coach/shared/engine';
  import { engineLineView, type LineMove, type LinePreview } from '@chess-coach/shared/engine-lines';
  import { untrack } from 'svelte';
  import { foldOpen, rememberFold } from '../lib/folds.ts';

  interface Props {
    analysis: Analysis | null;
    fen: string;
    /** Shows a line on the board while a move is hovered or focused; null puts the position back. */
    onpreview?: (preview: LinePreview | null) => void;
    /** Plays the line's moves up to the one picked, from `fen`. */
    onplay?: (ucis: string[]) => void;
  }

  let { analysis, fen, onpreview, onplay }: Props = $props();

  let more = $state(foldOpen('engine-lines-more', false));

  /** A move the Player points at or has focused, as "line,move", with the line's moves up to it. */
  interface Pointed {
    key: string;
    moves: LineMove[];
  }
  /** The move under the pointer, and the move with the keyboard's focus: either can preview, the pointer's first. */
  let hovered = $state<Pointed | null>(null);
  let focused = $state<Pointed | null>(null);
  const previewing = $derived((hovered ?? focused)?.key ?? null);

  const views = $derived(analysis && analysis.fen === fen ? analysis.lines.map((line) => engineLineView(fen, line)) : null);

  function toggle(): void {
    more = !more;
    rememberFold('engine-lines-more', more);
  }

  /** Shows the move pointed at, else the focused one, else the position itself. */
  function show(): void {
    const p = hovered ?? focused;
    onpreview?.(p ? { moves: p.moves, text: p.moves.map((m) => m.label).join(' ') } : null);
  }

  function clear(): void {
    hovered = focused = null;
    onpreview?.(null);
  }

  // The Engine's deeper search can change a line under the pointer, removing or changing its button
  // without a pointerleave: a preview whose moves the lines no longer show ends.
  $effect(() => {
    const lines = views;
    const still = (p: Pointed | null) => {
      if (!p) return true;
      const [i, k] = p.key.split(',').map(Number);
      const now = lines?.[i ?? -1]?.moves.slice(0, (k ?? -1) + 1).map((m) => m.uci).join(' ');
      return now === p.moves.map((m) => m.uci).join(' ');
    };
    const [h, f] = untrack(() => [hovered, focused]);
    if (still(h) && still(f)) return;
    untrack(() => {
      if (!still(h)) hovered = null;
      if (!still(f)) focused = null;
      show();
    });
  });

  // The lines leaving the screen (another tab picked with the keyboard while the pointer rests on a
  // move) put the board back: a button removed under the pointer never says the pointer left it.
  $effect(() => () => {
    if (untrack(() => hovered || focused)) clear();
  });
</script>

<!-- The pointer leaving the lines ends its preview, even where the button it was on has gone. -->
<section
  class="lines"
  aria-label="Engine lines"
  onpointerleave={() => {
    if (!hovered) return;
    hovered = null;
    show();
  }}
>
  {#if !views}
    <p class="muted">The Engine is thinking…</p>
  {:else if views.length === 0}
    <p class="muted">The game is over in this position.</p>
  {:else}
    <ol>
      {#each views.slice(0, more ? undefined : 1) as view, i (i)}
        {@const chances = view.chances}
        <li aria-label={`Engine line ${i + 1}: ${view.moves[0]?.label ?? ''}, ${chances.text}, ${chances.evaluation}`} class:best={i === 0}>
          <span class="score">
            <span class="chances" class:mate={chances.mate} data-testid="winning-chances">{chances.short}</span>
            <span class="eval muted" data-testid="evaluation">{chances.evaluation}</span>
          </span>
          <span class="moves">
            {#each view.moves as m, k (k)}
              {@const upTo = view.moves.slice(0, k + 1)}
              {@const key = `${i},${k}`}
              <button
                type="button"
                class="move"
                class:first={k === 0}
                class:on={previewing === key}
                aria-label={`Try ${upTo.map((x) => x.label).join(' ')} on the board`}
                onpointerenter={(e) => {
                  if (e.pointerType !== 'mouse') return;
                  hovered = { key, moves: upTo };
                  show();
                }}
                onpointerleave={() => {
                  if (hovered?.key !== key) return;
                  hovered = null;
                  show();
                }}
                onfocus={() => {
                  focused = { key, moves: upTo };
                  show();
                }}
                onblur={() => {
                  if (focused?.key !== key) return;
                  focused = null;
                  show();
                }}
                onclick={() => {
                  clear();
                  onplay?.(upTo.map((x) => x.uci));
                }}
                >{#if m.number}<span class="number">{`${m.number} `}</span>{/if}{m.san}</button
              >
            {/each}
          </span>
        </li>
      {/each}
    </ol>
    <div class="foot">
      {#if views.length > 1}
        <button type="button" class="secondary more" aria-expanded={more} onclick={toggle}>{more ? 'Fewer lines' : `More lines (${views.length - 1})`}</button>
      {/if}
      <!-- Under the lines, so a phone's short sheet shows the top line first. -->
      <p class="note muted"><span>White’s winning chances</span> · <span class="depth">Depth {analysis?.depth}</span></p>
      <p class="hint muted"><span class="by-hover">Point at a move to see it on the board; click to try the line.</span><span class="by-touch">Tap a move to try the line on the board.</span></p>
    </div>
  {/if}
</section>

<style>
  .lines { font-size: 0.9rem; }
  ol { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.3rem 0; border-bottom: 1px solid var(--line); }
  .score { display: inline-flex; align-items: baseline; gap: 0.3rem; min-width: 5.6rem; flex-shrink: 0; }
  .chances { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 1rem; }
  .chances.mate { font-size: 0.9rem; }
  .eval { font-variant-numeric: tabular-nums; font-size: 0.75rem; }
  .moves { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1rem 0.15rem; min-width: 0; }
  /* A move is a button that reads as part of the line, marked when the board shows it. */
  .move {
    background: none; border: 0; color: var(--text); font: inherit; padding: 0.1rem 0.3rem; border-radius: 4px;
    cursor: pointer; white-space: nowrap; min-height: 0;
  }
  .move:hover, .move.on { background: color-mix(in srgb, var(--accent) 14%, var(--panel)); }
  .move:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .move.first { font-weight: 600; }
  /* The best line's first move is the green arrow on the board. */
  .best .move.first { color: var(--arrow-best); }
  .number { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.75rem; margin-top: 0.35rem; }
  .more { padding: 0.25rem 0.6rem; font-size: 0.85rem; }
  .note, .hint { margin: 0; font-size: 0.8rem; }
  .hint { flex-basis: 100%; }
  .by-touch { display: none; }
  @media (hover: none) {
    .by-hover { display: none; }
    .by-touch { display: inline; }
  }
  /* A phone: each move a full thumb's height, one row per line. */
  @media (max-width: 820px) {
    .score { min-width: 4.6rem; }
    /* One row per line: a long line scrolls sideways, every move whole and in reach. */
    .moves { flex: 1 1 auto; gap: 0; flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
    .moves::-webkit-scrollbar { display: none; }
    .move { min-height: var(--tap); padding-inline: 0.3rem; }
    li { align-items: center; padding: 0; gap: 0.3rem; }
  }
</style>
