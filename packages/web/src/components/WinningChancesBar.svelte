<script lang="ts">
  // The Winning Chances bar beside the board: White and Black fill it in proportion to the
  // position's Winning Chances, with each side's percentage at its end. The side at the bottom of
  // the board fills it from the bottom, or from the left where the bar sits under the board on a
  // phone. Its value comes from the shared formatter, so it agrees with the Engine lines and the
  // Move Grades (ADR 0002).
  import { otherSide, type Side } from '@chess-coach/shared/chess';
  import type { Score } from '@chess-coach/shared/engine';
  import { winningChancesFor } from '@chess-coach/shared/winning-chances';

  interface Props {
    /** The position's evaluation, or null while there is none yet. */
    score: Score | null;
    /** The side whose point of view `score` is from. */
    pov: Side;
    /** The side at the bottom of the board. */
    orientation: Side;
    /** Said in place of the percentage while there is no score. */
    waiting?: string;
  }

  let { score, pov, orientation, waiting = 'the Engine is thinking' }: Props = $props();

  const bottom = $derived(score ? winningChancesFor(score, pov, orientation) : null);
  /** The fill keeps its last value while the Engine thinks, so the bar doesn't jump to even. */
  let shown = $state(50);
  $effect(() => {
    if (bottom) shown = bottom.percent;
  });
  /** Each side's percentage at its own end, top first; a mate shows only at the winner's end ("M3"). */
  const labels = $derived.by(() => {
    if (!bottom || !score) return [];
    const ends: Side[] = [otherSide(orientation), orientation];
    if (bottom.mate) {
      const { winner, moves } = bottom.mate;
      return [{ side: winner, label: moves === 0 ? '#' : `M${moves}` }];
    }
    return ends.map((side) => ({ side, label: winningChancesFor(score, pov, side).short }));
  });
  const name = $derived(`Winning Chances bar: ${bottom ? bottom.text : waiting}`);
</script>

<div
  class="wc-bar"
  class:waiting={!bottom}
  role="meter"
  aria-label={name}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={bottom ? Math.round(bottom.percent) : undefined}
  aria-valuetext={bottom ? bottom.text : waiting}
  data-orientation={orientation}
>
  <div class="track {otherSide(orientation)}">
    <div class="fill {orientation}" data-testid="bar-fill" data-side={orientation} style:--share={`${shown}%`}></div>
    {#each labels as l (l.side)}
      <span class="percent {l.side}" class:start={l.side === orientation} data-testid="bar-percent" data-side={l.side} aria-hidden="true">{l.label}</span>
    {/each}
  </div>
</div>

<style>
  .wc-bar {
    /* Beside the board: as tall as the board, which is as wide as its column (see app.css). */
    width: 100%;
    height: min(var(--board-max, 560px), 92vw, calc(100cqw - var(--wc-bar-width) - var(--wc-bar-gap)));
  }
  .track {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 4px;
    overflow: hidden;
    /* A thin ring keeps the bar's edge visible where a side's colour is close to the page's. */
    box-shadow: 0 0 0 1px rgb(0 0 0 / 15%), 0 2px 10px rgb(0 0 0 / 30%);
  }
  @media (prefers-color-scheme: dark) {
    .track { box-shadow: 0 0 0 1px rgb(255 255 255 / 30%), 0 2px 10px rgb(0 0 0 / 30%); }
  }
  .white { background: #f4f4f1; color: #262421; --halo: #f4f4f1; }
  .black { background: #3a3835; color: #f4f4f1; --halo: #3a3835; }
  .fill {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: var(--share);
    transition: height 0.4s ease, width 0.4s ease;
  }
  .waiting .fill { opacity: 0.7; }
  .percent {
    position: absolute;
    left: 0;
    right: 0;
    top: 0.25rem;
    background: none;
    text-align: center;
    font-size: 0.62rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    /* Readable where its own side's share is too small to hold it. */
    text-shadow: 0 0 2px var(--halo), 0 0 2px var(--halo);
  }
  .percent.start { top: auto; bottom: 0.25rem; }

  /* Under the board on a phone-sized screen: a horizontal bar, the bottom side filling from the left. */
  @container (max-width: 520px) {
    .wc-bar {
      width: min(var(--board-max, 560px), 92vw, 100cqw);
      height: 1.1rem;
      justify-self: center;
      order: 1;
    }
    .fill { height: 100%; width: var(--share); }
    .percent { top: 50%; transform: translateY(-50%); left: auto; right: 0.35rem; width: auto; }
    .percent.start { top: 50%; bottom: auto; right: auto; left: 0.35rem; }
  }
</style>
