<script lang="ts">
  // How an Engine Game ended, on its end-of-game card: the result and how the Player's moves were
  // graded. It only counts the Move Grades the game already has (ADR 0002): a move that never got
  // one isn't counted, and nothing is judged anew. It sits in the status region; the card's actions
  // (Review this game, New game) follow it outside, in EngineGame.svelte.
  import { SIDE_NAMES, type Side } from '@chess-coach/shared/chess';
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { GRADE_LOOK } from '../lib/grades.ts';

  let {
    headline,
    moves,
    side,
    level,
    grades,
  }: {
    headline: string;
    /** Full moves played, as a game's move numbers count them. */
    moves: number;
    side: Side;
    level: string;
    grades: (MoveGrade | undefined)[];
  } = $props();

  const KINDS: { grade: MoveGrade; one: string; many: string }[] = [
    { grade: 'Best', one: 'Best', many: 'Best' },
    { grade: 'Good', one: 'Good', many: 'Good' },
    { grade: 'Inaccuracy', one: 'Inaccuracy', many: 'Inaccuracies' },
    { grade: 'Mistake', one: 'Mistake', many: 'Mistakes' },
    { grade: 'Blunder', one: 'Blunder', many: 'Blunders' },
  ];
  const tally = $derived(KINDS.map((k) => ({ ...k, n: grades.filter((g) => g === k.grade).length })));
</script>

<p class="headline">{headline}</p>
<p class="muted">{moves} {moves === 1 ? 'move' : 'moves'} · You played {SIDE_NAMES[side]} · Engine: {level}</p>
<ul class="tally" aria-label="Your Move Grades in this game">
  {#each tally as t (t.grade)}
    <li
      class:none={t.n === 0}
      style:background={t.n ? GRADE_LOOK[t.grade].light : undefined}
      style:color={t.n ? GRADE_LOOK[t.grade].dark : undefined}
    >
      <!-- The familiar notation, drawn but not read out: the words say the same. -->
      <span class="symbol" aria-hidden="true">{GRADE_LOOK[t.grade].symbol}</span>
      <strong>{t.n}</strong> {t.n === 1 ? t.one : t.many}
    </li>
  {/each}
</ul>

<style>
  p { margin: 0; }
  .headline { font-size: 1.3rem; font-weight: 700; line-height: 1.25; }
  .tally {
    list-style: none;
    margin: 0.2rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .tally li {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3em;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .tally .symbol { font-weight: 700; }
  .tally strong { font-size: 1.05rem; }
  /* A zero count steps back in the muted text colour, its pill only outlined; faded it would fail
     WCAG AA contrast, and it still says something. */
  .tally .none { color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }
</style>
