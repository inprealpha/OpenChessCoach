<script lang="ts">
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { GRADE_LOOK } from '../lib/grades.ts';
  let { grade }: { grade: MoveGrade } = $props();
  // The same colors as the Move Grade symbols on the board.
  const look = $derived(GRADE_LOOK[grade]);
</script>

<span class="grade" title={`Move Grade: ${grade}`} style:background={look.light} style:color={look.dark}>
  <span aria-hidden="true">{look.symbol}</span>
  {grade}
</span>

<style>
  .grade {
    display: inline-flex;
    gap: 0.25em;
    align-items: center;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    white-space: nowrap;
  }
</style>
