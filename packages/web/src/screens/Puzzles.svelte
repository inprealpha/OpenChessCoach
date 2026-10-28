<script lang="ts">
  // Puzzles from the Lessons' openings, Themes and endgames, picked near the Player's level. A wrong move is shown as wrong
  // and the Player retries; every finished Puzzle is recorded in the Player Profile. Once finished, the solution is
  // written out and can be stepped through, and the Puzzles the Player missed can be tried again. The Player picks what
  // to practise: every Lesson mixed, or one Lesson's Puzzles, grouped by track, each with this device's progress.
  import { tick } from 'svelte';
  import { moveLabel, otherSide, outcomeOf, playUci, SIDE_NAMES, turnOf } from '@chess-coach/shared/chess';
  import { TRACK_NAMES } from '@chess-coach/shared/content/course';
  import { TRACKS } from '@chess-coach/shared/content/lessons';
  import { LEVEL_PUZZLE_RATING, pickPuzzles, type PuzzleData } from '@chess-coach/shared/content/puzzles';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import { api } from '../lib/api.svelte.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { lessonCatalogue, loadPuzzles } from '../lib/content.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { titleFrom } from '../lib/page-title.svelte.ts';
  import { arrivedByChoosing, markChosen } from '../lib/puzzle-choice.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { store } from '../lib/storage.ts';

  let { opening }: { opening?: string | undefined } = $props();

  let all = $state<PuzzleData[]>([]);
  let puzzle = $state<PuzzleData | null>(null);
  let index = $state(1);
  let mistakes = $state(0);
  let status = $state<'loading' | 'solving' | 'solved' | 'shown' | 'empty'>('loading');
  let feedback = $state('');
  let busy = $state(false);
  /** Puzzles this device finished without solving them first time, so they can be tried again. */
  let missed = $state<string[]>([]);
  /** Puzzles this device finished, solved or not. */
  let done = $state<string[]>([]);
  /** The move the Coach's arrows belong to: they show only while the board is on that position. */
  let explained = $state<number | null>(null);
  /** The choice of what to practise, opened to pick another set. */
  let choosing = $state(false);
  let summary = $state<HTMLElement | undefined>();
  const line = new Line();
  const coach = new CoachThread();

  /** The Lesson whose Puzzles these are. A link to a Lesson without Puzzles, or to none, gets every Lesson's. */
  const lesson = $derived(all.length && !all.some((p) => p.lessonId === opening) ? undefined : lessonCatalogue.find((l) => l.id === opening));
  const lessonName = $derived(lesson?.name);
  const solver = $derived(puzzle ? otherSide(turnOf(puzzle.fen)) : 'white');
  /** This screen's Puzzles: a Lesson's, or all of them. */
  const pool = $derived(all.filter((p) => !lesson || p.lessonId === lesson.id).map((p) => p.id));
  const here = $derived(progressOn(pool));
  // Every Lesson's Puzzles, whatever Lesson the address names.
  titleFrom(() => (opening && all.length && !lesson ? 'Puzzles' : null));
  const finished = $derived(status === 'solved' || status === 'shown');

  /** What the Player can practise: every Lesson mixed, then each Lesson that has Puzzles, with this device's progress on them. */
  const mixed = $derived({ id: '', name: 'Mixed: every Lesson', ...progressOn(all.map((p) => p.id)) });
  const sets = $derived(
    lessonCatalogue
      .map((l) => ({ id: l.id, name: l.name, track: l.track, ...progressOn(all.filter((p) => p.lessonId === l.id).map((p) => p.id)) }))
      .filter((s) => s.count > 0),
  );
  /** The sets by the Lessons' tracks, as the Lessons screen shows them (ADR 0011); a track with no Puzzles is left out. */
  const groups = $derived(TRACKS.map((track) => ({ track, label: TRACK_NAMES[track].name, sets: sets.filter((s) => s.track === track) })).filter((g) => g.sets.length));

  /**
   * This device's progress on some Puzzles. Missed counts only Puzzles that are done: tried again, a missed Puzzle is
   * neither until it is finished again. Ids the Puzzle data no longer has count for nothing.
   */
  function progressOn(ids: readonly string[]): { count: number; done: string[]; missed: string[] } {
    const doneOnes = done.filter((id) => ids.includes(id));
    return { count: ids.length, done: doneOnes, missed: missed.filter((id) => doneOnes.includes(id)) };
  }

  /** "25 Puzzles · 2 done (1 missed)": how big a set is and how far the Player got. */
  function sizeAndProgress(set: { count: number; done: string[]; missed: string[] }): string {
    const progress = set.done.length ? ` · ${set.done.length} done${set.missed.length ? ` (${set.missed.length} missed)` : ''}` : '';
    return `${set.count} Puzzles${progress}`;
  }

  /**
   * Each set is a link to its own address, so the choice survives a reload and the back button, and only following
   * one changes the set. The new set's screen puts focus back on the choice; the set already shown just closes it.
   */
  function choose(e: MouseEvent, id: string): void {
    if (id === (opening ?? '')) {
      e.preventDefault();
      choosing = false;
      summary?.focus();
      return;
    }
    markChosen(id);
  }

  $effect(() => {
    void start();
  });

  async function start(): Promise<void> {
    all = (await loadPuzzles()).puzzles;
    if (arrivedByChoosing(opening ?? '')) {
      await tick();
      summary?.focus();
    }
    await nextPuzzle();
  }

  async function nextPuzzle(): Promise<void> {
    done = (await store.get<string[]>('puzzlesDone')) ?? [];
    missed = (await store.get<string[]>('puzzlesMissed')) ?? [];
    const target = profile.profile?.rating ?? LEVEL_PUZZLE_RATING[profile.profile?.level ?? 'beginner'];
    const [p] = pickPuzzles(all, target, { ...(lesson ? { lessonId: lesson.id } : {}), exclude: new Set(done), count: 1 });
    coach.reset();
    explained = null;
    feedback = '';
    mistakes = 0;
    if (!p) {
      puzzle = null;
      status = 'empty';
      return;
    }
    puzzle = p;
    line.reset(p.fen);
    status = 'solving';
    busy = true;
    await pause(500);
    line.play(p.moves[0] as string);
    index = 1;
    busy = false;
  }

  function pause(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function onmove(uci: string): Promise<void> {
    if (!puzzle || status !== 'solving' || busy) return;
    const expected = puzzle.moves[index] as string;
    const played = playUci(line.fen, uci);
    if (!played) return;
    const isLast = index === puzzle.moves.length - 1;
    // Any mating move solves the last step, as on Lichess.
    const correct = played.uci === expected || (isLast && outcomeOf(played.fenAfter)?.reason === 'checkmate');
    line.play(uci);
    if (!correct) {
      mistakes++;
      feedback = `${played.san} is not the move. Try again.`;
      busy = true;
      await pause(600);
      line.takeBack();
      busy = false;
      return;
    }
    feedback = 'Correct!';
    if (isLast) {
      await finish(true);
      return;
    }
    busy = true;
    await pause(400);
    line.play(puzzle.moves[index + 1] as string);
    index += 2;
    busy = false;
    feedback = 'Correct! Keep going.';
    if (index >= puzzle.moves.length) await finish(true);
  }

  async function finish(found: boolean): Promise<void> {
    if (!puzzle) return;
    status = found ? 'solved' : 'shown';
    feedback = found ? (mistakes ? `Solved after ${mistakes} wrong ${mistakes === 1 ? 'try' : 'tries'}.` : 'Solved first time!') : 'Here is the solution.';
    const doneBefore = (await store.get<string[]>('puzzlesDone')) ?? [];
    const nowDone = doneBefore.includes(puzzle.id) ? doneBefore : [...doneBefore, puzzle.id];
    if (nowDone !== doneBefore) await store.set('puzzlesDone', nowDone);
    done = nowDone;
    const id = puzzle.id;
    const others = ((await store.get<string[]>('puzzlesMissed')) ?? []).filter((m) => m !== id);
    // A plain array: the store can't save Svelte's state proxy.
    const nowMissed = found && mistakes === 0 ? others : [...others, id];
    await store.set('puzzlesMissed', nowMissed);
    missed = nowMissed;
    if (api.state === 'online') {
      try {
        const stats = await api.request('puzzles.record', { puzzleId: puzzle.id, opening: puzzle.lessonId, solved: found && mistakes === 0, mistakes });
        if (profile.profile) profile.set({ ...profile.profile, puzzles: stats });
      } catch {
        // not recorded; the Puzzle still counts as done on this device
      }
    }
  }

  async function showSolution(): Promise<void> {
    if (!puzzle) return;
    busy = true;
    while (index < puzzle.moves.length) {
      line.play(puzzle.moves[index] as string);
      index++;
      await pause(400);
    }
    busy = false;
    await finish(false);
  }

  /** Lets the Puzzles in `ids` be picked again, then shows the next one. */
  async function offerAgain(ids: readonly string[]): Promise<void> {
    const doneBefore = (await store.get<string[]>('puzzlesDone')) ?? [];
    await store.set('puzzlesDone', doneBefore.filter((id) => !ids.includes(id)));
    status = 'loading';
    await nextPuzzle();
  }

  async function why(question: string): Promise<void> {
    if (!puzzle) return;
    const setup = playUci(puzzle.fen, puzzle.moves[0] as string);
    const answer = setup && playUci(setup.fenAfter, puzzle.moves[1] as string);
    if (!setup || !answer) return;
    // The answer is about the Puzzle's position: show it, so the Coach's arrows start on its pieces.
    line.goTo(1);
    explained = 1;
    await coach.ask(
      {
        job: 'why',
        fen: setup.fenAfter,
        recentMoves: [setup.san],
        playerSide: solver,
        moveUci: answer.uci,
        // A Puzzle shows no Winning Chances bar, so the Coach quotes none.
        hideWinningChances: true,
        ...(question ? { question } : {}),
        ...(lesson?.kind === 'opening' ? { opening: lesson.name } : {}),
      },
      question || `Why is ${answer.san} the answer?`,
    );
  }
</script>

<section class="screen">
  <h1>{lessonName ? `${lessonName} Puzzles` : 'Puzzles'}</h1>
  {#if all.length}
    {#if opening && !lesson}
      <p role="note">There are no Puzzles for {lessonCatalogue.find((l) => l.id === opening)?.name ?? 'that link'}, so these are from every Lesson.</p>
    {/if}
    <!-- Links, not a select: an arrow key on a closed select changes it, and the set would change under the Player. -->
    <div class="picker">
      <details bind:open={choosing}>
        <summary bind:this={summary} aria-describedby="puzzle-progress">Choose what to practise</summary>
        <nav aria-label="Puzzles to practise">
          {#snippet item(set: typeof mixed)}
            <li>
              <a href={set.id ? `#/puzzles/${set.id}` : '#/puzzles'} aria-current={set.id === (lesson?.id ?? '') ? 'page' : undefined} onclick={(e) => choose(e, set.id)}>
                <span>{set.name}</span> <span class="muted small">{sizeAndProgress(set)}</span>
              </a>
            </li>
          {/snippet}
          <ul class="sets">{@render item(mixed)}</ul>
          {#each groups as g (g.track)}
            <h2>{g.label}</h2>
            <ul class="sets" aria-label={g.label}>
              {#each g.sets as s (s.id)}{@render item(s)}{/each}
            </ul>
          {/each}
        </nav>
      </details>
      <p id="puzzle-progress" class="muted small">
        {lessonName ?? 'Every Lesson'}: {here.done.length} of {here.count} done{here.missed.length ? ` (${here.missed.length} missed)` : ''}.
      </p>
    </div>
  {/if}
  {#if status === 'loading'}
    <p class="muted">Loading Puzzles…</p>
  {:else if status === 'empty'}
    <section class="card" aria-label="No more Puzzles">
      <p>You have done every {lessonName ? `${lessonName} ` : ''}Puzzle on this device.</p>
      <div class="row">
        {#if here.missed.length}
          <button type="button" onclick={() => offerAgain(here.missed)}>Try the {here.missed.length} you missed again</button>
        {/if}
        <button type="button" class="secondary" onclick={() => offerAgain(pool)}>Start {lessonName ? 'these' : 'all the'} Puzzles again</button>
      </div>
      <p>
        {#if lesson}<a href="#/puzzles">Puzzles from every Lesson</a>{:else}<a href="#/lessons">Lessons</a>{/if}
      </p>
    </section>
  {:else if puzzle}
    <div class="board-layout">
      <div>
        <Board
          fen={line.fen}
          orientation={solver}
          movable={status === 'solving' && !busy ? solver : 'none'}
          lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
          arrows={explained === line.cursor ? coach.arrows : []}
          highlights={explained === line.cursor ? coach.highlights : []}
          {onmove}
          label="Puzzle board"
        />
        {#if finished}
          <!-- Stepping stays inside the Puzzle: its first position is the one the Player was set. -->
          <div class="toolbar">
            <button type="button" class="secondary" onclick={() => line.goTo(1)} aria-label="First position">⏮</button>
            <button type="button" class="secondary" onclick={() => line.goTo(Math.max(1, line.cursor - 1))} aria-label="Previous move">◀</button>
            <button type="button" class="secondary" onclick={() => line.forward()} aria-label="Next move">▶</button>
            <button type="button" class="secondary" onclick={() => line.goTo(line.moves.length)} aria-label="Last position">⏭</button>
          </div>
        {/if}
      </div>
      <div class="side">
        <section class="card" aria-label="Puzzle" data-puzzle-id={puzzle.id}>
          <p>
            <strong>
              {#if status === 'solved'}You found the best move for {SIDE_NAMES[solver]}.{:else if status === 'shown'}The solution for {SIDE_NAMES[solver]} is on the board.{:else}Find the best move for {SIDE_NAMES[solver]}.{/if}
            </strong>
          </p>
          <p class="muted small">Puzzle {puzzle.id} · rated {puzzle.rating} · from a real Lichess game</p>
          <p role="status" aria-live="polite" class:error={feedback.includes('not the move')}>{feedback}</p>
          {#if finished}
            <p class="solution">
              Solution:
              {#each line.moves.slice(1) as m, i (i)}
                {@const label = moveLabel(m.fenBefore, m.san)}
                <button type="button" class:current={line.cursor === i + 2} aria-current={line.cursor === i + 2 ? 'step' : undefined} aria-label={`Move ${label}`} onclick={() => line.goTo(i + 2)}>
                  {i === 0 || turnOf(m.fenBefore) === 'white' ? label : m.san}
                </button>
              {/each}
            </p>
          {/if}
          <div class="row">
            {#if status === 'solving'}
              <button type="button" class="secondary" onclick={showSolution} disabled={busy}>Show the solution</button>
            {:else}
              <button type="button" onclick={nextPuzzle}>Next Puzzle</button>
            {/if}
          </div>
        </section>
        {#if status !== 'solving'}
          <CoachPanel thread={coach} onwhy={why} placeholder="Why is this the answer?" />
        {/if}
        <p class="muted small">Puzzles: Lichess puzzle database, CC0.</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .small { font-size: 0.8rem; }
  .picker { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 1rem; margin: 0 0 1rem; }
  .picker p { margin: 0; }
  /* Open, the sets take the whole width and the progress line goes under them; the summary stays where it was. */
  .picker details[open] { flex: 1 1 100%; }
  .picker summary { cursor: pointer; font-weight: 600; color: var(--accent); }
  .picker h2 { font-size: 0.95rem; margin: 0.75rem 0 0.35rem; }
  /* As on the Lessons screen: a grid of sets that wraps their names, one column on a phone. */
  .sets { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.4rem; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  /* The name, then the size and progress beside it, or under it where the name is long. */
  .sets a { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; align-content: flex-start; gap: 0 0.6rem; height: 100%; padding: 0.45rem 0.7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); text-decoration: none; }
  .sets a:hover { border-color: var(--accent); }
  .sets a[aria-current='page'] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); font-weight: 600; }
  .solution { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .solution button {
    border: 1px solid var(--line);
    background: var(--panel);
    color: inherit;
    border-radius: 6px;
    padding: 0.15rem 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .solution button.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
</style>
