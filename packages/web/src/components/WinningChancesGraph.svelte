<script lang="ts">
  // A Review's Winning Chances graph: the whole game from White's point of view, as on
  // Lichess, drawn from the Review's graded moves (no Coach call, no Engine run). White's share
  // fills from the bottom, Black's from the top. Mistakes and Blunders by either side are marked in
  // their Move Grade's color. A click anywhere jumps the board to that move, and the current move
  // is marked as the Player steps through.
  import type { GradedMove } from '@chess-coach/shared/analysis';
  import { winningChancesGraph } from '@chess-coach/shared/winning-chances-graph';
  import { GRADE_LOOK } from '../lib/grades.ts';

  interface Props {
    moves: GradedMove[];
    /** The board's position: 0 for the start, n after the n-th move. */
    cursor: number;
    ongoto: (cursor: number) => void;
  }
  let { moves, cursor, ongoto }: Props = $props();

  const W = 400;
  const H = 110;
  const PAD = 6;

  const points = $derived(winningChancesGraph(moves));
  const last = $derived(Math.max(1, points.length - 1));
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / last;
  const y = (percent: number) => PAD + ((100 - percent) * (H - 2 * PAD)) / 100;
  const line = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(p.percent).toFixed(2)}`).join(' '));
  const area = $derived(points.length ? `${line} L${x(points.length - 1).toFixed(2)} ${H - PAD} L${PAD} ${H - PAD} Z` : '');
  const shown = $derived(Math.min(Math.max(0, cursor), points.length - 1));
  const current = $derived(points[shown]);

  /** The point under the pointer, so a hover or tap reads its Winning Chances. */
  let hovered = $state<number | null>(null);
  const readout = $derived(points[hovered ?? shown]);

  function indexAt(svg: SVGSVGElement, clientX: number): number {
    const rect = svg.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * W;
    return Math.min(points.length - 1, Math.max(0, Math.round(((vx - PAD) * last) / (W - 2 * PAD))));
  }

  function onkeydown(e: KeyboardEvent): void {
    const next =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? shown - 1
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? shown + 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? points.length - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    ongoto(Math.min(points.length - 1, Math.max(0, next)));
  }

  function onmarkkey(e: KeyboardEvent, i: number): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    ongoto(i);
  }
</script>

{#if points.length > 1 && current && readout}
  <figure class="graph" aria-label="Winning Chances graph">
    <div class="plot">
      <svg
        class="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="slider"
        tabindex="0"
        aria-label="Move on the Winning Chances graph"
        aria-valuemin={0}
        aria-valuemax={points.length - 1}
        aria-valuenow={shown}
        aria-valuetext={current.label}
        onclick={(e) => ongoto(indexAt(e.currentTarget, e.clientX))}
        onpointermove={(e) => (hovered = indexAt(e.currentTarget, e.clientX))}
        onpointerleave={() => (hovered = null)}
        {onkeydown}
      >
        <rect class="black" x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD} rx="3" />
        <path class="white" d={area} />
        <line class="mid" x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} />
        <path class="curve" d={line} />
        {#if hovered !== null && hovered !== shown}
          <line class="hover" x1={x(hovered)} x2={x(hovered)} y1={PAD} y2={H - PAD} />
        {/if}
      </svg>
      <!-- Marks and the current move sit on their own layer, so they stay buttons and images of their own. -->
      <svg class="marks" viewBox={`0 0 ${W} ${H}`} role="none">
        <g role="img" aria-label={`Current position: ${current.label}`}>
          <line class="cursor" x1={x(shown)} x2={x(shown)} y1={PAD} y2={H - PAD} />
          <circle class="cursor-dot" cx={x(shown)} cy={y(current.percent)} r="3.5" />
        </g>
        {#each points as p, i (p.ply)}
          {#if p.mark}
            <g
              class="mark"
              role="button"
              tabindex="0"
              aria-label={p.mark.name}
              data-grade={p.mark.grade}
              onclick={() => ongoto(i)}
              onkeydown={(e) => onmarkkey(e, i)}
              onpointerenter={() => (hovered = i)}
              onpointerleave={() => (hovered = null)}
            >
              <title>{p.mark.name}: {p.label}</title>
              <circle class="hit" cx={x(i)} cy={y(p.percent)} r="11" />
              <circle cx={x(i)} cy={y(p.percent)} r="5" fill={GRADE_LOOK[p.mark.grade].dark} stroke="#fff" stroke-width="2" />
            </g>
          {/if}
        {/each}
      </svg>
    </div>
    <figcaption class="readout">{readout.label}</figcaption>
  </figure>
{/if}

<style>
  .graph { margin: 0.6rem 0 0; }
  .plot { position: relative; }
  svg { display: block; width: 100%; height: auto; }
  .chart { cursor: pointer; touch-action: pan-y; border-radius: 4px; }
  .chart:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .marks { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .black { fill: #3b403c; }
  .white { fill: #eef0ec; }
  .mid { stroke: #9aa19b; stroke-width: 1; stroke-dasharray: 3 3; }
  .curve { fill: none; stroke: #7d867f; stroke-width: 2; stroke-linejoin: round; }
  .hover { stroke: #9aa19b; stroke-width: 1; }
  .cursor { stroke: var(--accent); stroke-width: 2; }
  .cursor-dot { fill: var(--accent); stroke: #fff; stroke-width: 1.5; }
  .mark { pointer-events: all; cursor: pointer; outline: none; }
  .mark:focus-visible circle:not(.hit) { stroke: var(--accent); stroke-width: 3; }
  .hit { fill: transparent; }
  .readout { font-size: 0.85rem; color: var(--muted); text-align: center; margin-top: 0.25rem; font-variant-numeric: tabular-nums; }
</style>
