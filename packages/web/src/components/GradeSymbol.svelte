<script lang="ts">
  // A Move Grade symbol in the top-right corner of the square a move landed on, as on Lichess and
  // chess.com: `?!`, `?`, `??`, or a star for Best. Good moves get nothing, so sound moves don't
  // clutter the board. Its own layer over the board, named like "Mistake on f7".
  import type { Side } from '@chess-coach/shared/chess';
  import { GRADE_LOOK, type GradeMark } from '../lib/grades.ts';

  let { mark, orientation }: { mark: GradeMark; orientation: Side } = $props();

  const FILES = 'abcdefgh';
  const look = $derived(GRADE_LOOK[mark.grade]);
  /** The square's top-left corner, in squares from the board's top-left. */
  const corner = $derived.by(() => {
    const f = FILES.indexOf(mark.square[0] as string);
    const r = Number(mark.square[1]) - 1;
    return orientation === 'white' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  });
</script>

{#if mark.grade !== 'Good'}
  <svg class="grade-symbols" viewBox="0 0 8 8">
    <g role="img" aria-label={`${mark.grade} on ${mark.square}`} data-grade={mark.grade} transform={`translate(${corner.x + 0.75} ${corner.y + 0.25})`}>
      <circle r="0.23" fill={look.dark} stroke="#fff" stroke-width="0.03" />
      <text
        y="0.01"
        text-anchor="middle"
        dominant-baseline="central"
        fill={look.light}
        font-size={look.symbol.length > 1 ? 0.23 : 0.29}
        font-weight="800"
        letter-spacing="-0.01"
      >{look.symbol}</text>
    </g>
  </svg>
{/if}

<style>
  .grade-symbols {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 35%));
  }
  text {
    font-family: system-ui, sans-serif;
  }
</style>
