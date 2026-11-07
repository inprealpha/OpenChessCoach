<script lang="ts">
  // How an Engine Game ended, on its end-of-game card: the result, then one line with the moves
  // played and the Move Grades that need a look ("12 moves · 1 Mistake, 1 Inaccuracy"), short
  // enough that the card's actions stay in a phone's first screen. It only counts the Move Grades
  // the game already has (ADR 0002): a move that never got one isn't counted, and nothing is judged
  // anew. It sits in the status region; the card's actions (Review this game, New game) follow it
  // outside, in EngineGame.svelte.
  import type { MoveGrade } from '@chess-coach/shared/grader';

  let {
    headline,
    moves,
    grades,
  }: {
    headline: string;
    /** Full moves played, as a game's move numbers count them. */
    moves: number;
    grades: (MoveGrade | undefined)[];
  } = $props();

  /** The Move Grades worth a look, the worst first. */
  const KINDS: { grade: MoveGrade; one: string; many: string }[] = [
    { grade: 'Blunder', one: 'Blunder', many: 'Blunders' },
    { grade: 'Mistake', one: 'Mistake', many: 'Mistakes' },
    { grade: 'Inaccuracy', one: 'Inaccuracy', many: 'Inaccuracies' },
  ];
  const tally = $derived(
    KINDS.map((k) => ({ ...k, n: grades.filter((g) => g === k.grade).length }))
      .filter((k) => k.n)
      .map((k) => `${k.n} ${k.n === 1 ? k.one : k.many}`),
  );
</script>

<p class="headline">{headline}</p>
<p class="muted">{moves} {moves === 1 ? 'move' : 'moves'} · {tally.length ? tally.join(', ') : 'no Mistakes'}</p>

<style>
  p { margin: 0; }
  .headline { font-size: 1.3rem; font-weight: 700; line-height: 1.25; }
  /* On a phone the card shares the first screen with the board: the result a little smaller. */
  @media (max-width: 820px) {
    .headline { font-size: 1.15rem; line-height: 1.2; }
  }
</style>
