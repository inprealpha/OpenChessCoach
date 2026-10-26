<script lang="ts">
  // The Engine's few best candidate moves, shown when the Player asks. Each leads with the side to
  // move's Winning Chances after it, with the evaluation kept smaller beside them.
  import { sanLine, SIDE_NAMES, turnOf } from '@chess-coach/shared/chess';
  import type { Analysis } from '@chess-coach/shared/engine';
  import { winningChancesFor } from '@chess-coach/shared/winning-chances';

  let { analysis, fen }: { analysis: Analysis | null; fen: string } = $props();

  const side = $derived(turnOf(fen));
</script>

<section class="lines" aria-label="Engine lines">
  {#if !analysis || analysis.fen !== fen}
    <p class="muted">The Engine is thinking…</p>
  {:else if analysis.lines.length === 0}
    <p class="muted">The game is over in this position.</p>
  {:else}
    <p class="depth muted">Depth {analysis.depth}</p>
    <p class="heading muted">{SIDE_NAMES[side]}’s winning chances after each move</p>
    <ol>
      {#each analysis.lines as line, i (i)}
        {@const sans = sanLine(fen, line.pv.slice(0, 6))}
        {@const chances = winningChancesFor(line.score, side)}
        <li aria-label={`Engine line ${i + 1}: ${sans[0] ?? ''}, ${chances.text}, ${chances.evaluation}`}>
          <span class="score">
            <span class="chances" class:mate={chances.mate} data-testid="winning-chances">{chances.short}</span>
            <span class="eval muted" data-testid="evaluation">{chances.evaluation}</span>
          </span>
          <span class="san">{sans[0]}</span>
          <span class="pv muted">{sans.slice(1).join(' ')}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .lines { font-size: 0.9rem; }
  ol { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.2rem 0; border-bottom: 1px solid var(--line); }
  .score { display: inline-flex; align-items: baseline; gap: 0.3rem; min-width: 5.6rem; flex-shrink: 0; }
  .chances { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 1rem; }
  .chances.mate { font-size: 0.9rem; }
  .eval { font-variant-numeric: tabular-nums; font-size: 0.75rem; }
  .san { font-weight: 600; min-width: 3rem; }
  .pv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .depth, .heading { margin: 0 0 0.25rem; font-size: 0.8rem; }
</style>
