<script lang="ts">
  // Puzzles from the Lessons' openings, Themes and endgames, picked near the Player's level. A wrong move is shown as wrong
  // and the Player retries; every finished Puzzle is recorded in the Player Profile. Once finished, the solution is
  // written out and can be stepped through, and the Puzzles the Player missed can be tried again. The Player picks what
  // to practise: every Lesson mixed, or one Lesson's Puzzles, grouped by track, each with this device's progress.
  // A finished Puzzle's board is free: a move on it starts a variation, which Back to the Puzzle drops.
  // Stuck, the Player gets a Hint first, as in a Lesson: the Coach's nudge from the Engine's line, naming no move, and
  // only then Show the solution.
  import { tick } from 'svelte';
  import { moveLabel, otherSide, outcomeOf, playUci, SIDE_NAMES, turnOf } from '@chess-coach/shared/chess';
  import { TRACK_NAMES } from '@chess-coach/shared/content/course';
  import { TRACKS } from '@chess-coach/shared/content/lessons';
  import { LEVEL_PUZZLE_RATING, pickPuzzles, type PuzzleData } from '@chess-coach/shared/content/puzzles';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import GradeBadge from '../components/GradeBadge.svelte';
  import FlipButton from '../components/FlipButton.svelte';
  import VariationBar from '../components/VariationBar.svelte';
  import StepButtons from '../components/StepButtons.svelte';
  import SheetHandle from '../components/SheetHandle.svelte';
  import SheetStrip from '../components/SheetStrip.svelte';
  import { sheet } from '../lib/sheet.svelte.ts';
  import { api } from '../lib/api.svelte.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { lessonCatalogue, loadPuzzles } from '../lib/content.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { titleFrom } from '../lib/page-title.svelte.ts';
  import { arrivedByChoosing, markChosen } from '../lib/puzzle-choice.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { store } from '../lib/storage.ts';
  import { askAbout } from '../lib/ask.ts';
  import { narrow } from '../lib/narrow.svelte.ts';
  import { stepLine, Variation, type Step } from '../lib/variation.svelte.ts';
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
  /** The position the Coach's arrows belong to: they show only while the board is on it. */
  let explained = $state<string | null>(null);
  /** The choice of what to practise, opened to pick another set. */
  let choosing = $state(false);
  let summary = $state<HTMLElement | undefined>();
  /** The step of the Puzzle the Hint was given at: the button then reads Show the solution, until the next move to find. */
  let hintedAt = $state<number | null>(null);
  let hintButton = $state<HTMLButtonElement>();
  const line = new Line();
  const coach = new CoachThread();
  /** The Player's own moves from a position of the finished Puzzle; its solution never changes. */
  const variation = new Variation();

  /** The Lesson whose Puzzles these are. A link to a Lesson without Puzzles, or to none, gets every Lesson's. */
  const lesson = $derived(all.length && !all.some((p) => p.lessonId === opening) ? undefined : lessonCatalogue.find((l) => l.id === opening));
  const lessonName = $derived(lesson?.name);
  const solver = $derived(puzzle ? otherSide(turnOf(puzzle.fen)) : 'white');
  /** The Player turned the board: it then shows the solver's side at the top. */
  let flipped = $state(false);
  /** This screen's Puzzles: a Lesson's, or all of them. */
  const pool = $derived(all.filter((p) => !lesson || p.lessonId === lesson.id).map((p) => p.id));
  const here = $derived(progressOn(pool));
  // Every Lesson's Puzzles, whatever Lesson the address names.
  titleFrom(() => (opening && all.length && !lesson ? 'Puzzles' : null));
  const finished = $derived(status === 'solved' || status === 'shown');
  /** Next Puzzle goes in the header line on a phone, where the resting sheet can't hide it, unless the Player is trying a line. */
  const nextInBar = $derived(sheet.on && !variation.active);
  const boardFen = $derived(variation.active ? variation.fen : line.fen);
  const shownLast = $derived(variation.active ? variation.line.lastMove : line.lastMove);
  /** The Hint was given for the move to find now: the next press shows the solution. */
  const hinted = $derived(hintedAt === index);
  /**
   * The Ask box names the move a Why Question asks about: the Puzzle's answer as played on the board (the solution's
   * move, or another mate the Player found), or the variation's move shown. Shorter on a phone, so it fits.
   */
  const askPlaceholder = $derived(askAbout(variation.active ? variation.line.lastMove : line.moves[1], narrow.on));

  /** What the Player can practise: every Lesson mixed, then each Lesson that has Puzzles, with this device's progress on them. */
  const mixed = $derived({ id: '', name: 'Mixed: every Lesson', ...progressOn(all.map((p) => p.id)) });
  const sets = $derived(
    lessonCatalogue
      .map((l) => ({ id: l.id, name: l.name, track: l.track, ...progressOn(all.filter((p) => p.lessonId === l.id).map((p) => p.id)) }))
      .filter((s) => s.count > 0),
  );
  /** The sets by the Lessons' tracks, as the Lessons screen shows them (ADR 0012); a track with no Puzzles is left out. */
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
    flipped = false;
    done = (await store.get<string[]>('puzzlesDone')) ?? [];
    missed = (await store.get<string[]>('puzzlesMissed')) ?? [];
    const target = profile.profile?.rating ?? LEVEL_PUZZLE_RATING[profile.profile?.level ?? 'beginner'];
    const [p] = pickPuzzles(all, target, { ...(lesson ? { lessonId: lesson.id } : {}), exclude: new Set(done), count: 1 });
    coach.reset();
    variation.leave();
    explained = null;
    hintedAt = null;
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

  /**
   * A nudge towards the move to find: the Coach's Hint job, whose facts the desktop's Engine works out. Its reply
   * names and draws no move: the guard strips every move, arrow and square, and a text that names a move becomes a
   * general Hint (`namedMove` in shared/coach/guard.ts). Pressed again for the same move, it shows the solution.
   */
  async function hint(): Promise<void> {
    if (!puzzle || status !== 'solving' || busy || coach.busy) return;
    if (hinted) {
      await showSolution();
      return;
    }
    hintedAt = index;
    if (!api.coachReady) {
      coach.say('Hints need the Coach, which is unavailable. Press Show the solution to see the moves.');
      return;
    }
    await coach.ask(
      {
        job: 'hint',
        fen: line.fen,
        recentMoves: line.sansUntilCursor(),
        playerSide: solver,
        hideWinningChances: true,
        ...(lesson?.kind === 'opening' ? { opening: lesson.name } : {}),
      },
      'Hint, please.',
    );
    // The button was disabled while the Coach answered, which drops the focus: it is Show the solution now.
    await tick();
    if (document.activeElement === document.body) hintButton?.focus();
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

  /**
   * A move on a finished Puzzle's board: the solution's own next move steps to it; any other starts a
   * variation from the position shown, or carries on the one shown.
   */
  function explore(uci: string): void {
    const to = variation.gameStep(uci, line.moves, line.cursor);
    if (to !== null) {
      variation.leave();
      line.goTo(to);
    } else variation.play(uci, { cursor: line.cursor, fen: line.fen });
  }

  /** Steps through the variation while the board shows one, otherwise through the Puzzle, whose first position is the one the Player was set. */
  function step(where: Step): void {
    if (variation.active) stepLine(variation.line, where);
    else stepLine(line, where, 1);
  }

  /** A move of the solution picked in its list: the board leaves any variation for it. */
  function showSolutionMove(cursor: number): void {
    variation.leave();
    line.goTo(cursor);
  }

  async function why(question: string): Promise<void> {
    if (!puzzle) return;
    if (variation.active) {
      // About the Player's own variation: only the moves go, and the desktop's Engine works out the facts (ADR 0007).
      const { label, ...asked } = variation.question(line.moves);
      explained = variation.fen;
      await coach.ask(
        {
          job: 'why',
          ...asked,
          playerSide: solver,
          hideWinningChances: true,
          ...(question ? { question } : {}),
          ...(lesson?.kind === 'opening' ? { opening: lesson.name } : {}),
        },
        question || label,
      );
      return;
    }
    // The answer as the board shows it: the solution's move, or another mate the Player found on the last move.
    const [setup, answer] = line.moves;
    if (!setup || !answer) return;
    // The answer is about the Puzzle's position: show it, so the Coach's arrows start on its pieces.
    line.goTo(1);
    explained = line.fen;
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

<section class="screen board-screen puzzles" class:sheet-full={sheet.shown}>
  <header class="frame-head">
    <h1>{lessonName ? `${lessonName} Puzzles` : 'Puzzles'}</h1>
    {#if puzzle && status !== 'empty'}<p class="head-line">Rated {puzzle.rating} · from a real Lichess game</p>{/if}
    {#if puzzle && status !== 'empty' && status !== 'loading'}
      <div class="frame-tools">
        {#if status === 'solving'}
          <!-- In the header line, as in a Lesson: a Hint first, then Show the solution. -->
          <button type="button" class="secondary" bind:this={hintButton} onclick={hint} disabled={busy || coach.busy}>{hinted ? 'Show the solution' : 'Hint'}</button>
        {/if}
        {#if finished && variation.active}<VariationBar place="header" back="Back to the Puzzle" onback={() => variation.leave()} />{/if}
        {#if finished && nextInBar}<button type="button" class="next" onclick={nextPuzzle}>Next Puzzle</button>{/if}
        <FlipButton onflip={() => (flipped = !flipped)} />
      </div>
    {/if}
  </header>
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
      <!-- On a phone the set's name is left to screen readers, so the line shares the choice's row; where the count is
           too wide for what the choice leaves, the missed count goes under it, within the same row. -->
      <p id="puzzle-progress" class="muted small">
        <span class="set-name">{lessonName ?? 'Every Lesson'}:</span> <span class="phrase">{here.done.length} of {here.count} done{here.missed.length ? '' : '.'}</span>{here.missed.length ? ' ' : ''}{#if here.missed.length}<span class="phrase">({here.missed.length} missed).</span>{/if}
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
      <div class="board-col">
        <div class="board-and-bar">
        <SheetStrip />
        <Board
          fen={boardFen}
          orientation={flipped ? otherSide(solver) : solver}
          movable={busy || (status === 'solving' && coach.busy) ? 'none' : finished ? 'both' : status === 'solving' ? solver : 'none'}
          lastMove={shownLast ? { from: shownLast.uci.slice(0, 2), to: shownLast.uci.slice(2, 4) } : undefined}
          arrows={explained === boardFen ? coach.arrows : []}
          highlights={explained === boardFen ? coach.highlights : []}
          gradeMark={variation.active ? variation.mark : undefined}
          onmove={finished ? explore : onmove}
          refusal={busy ? 'One moment: the moves are being played.' : 'One moment: the Coach is giving a Hint.'}
          label="Puzzle board"
        />
        </div>
      </div>
      <div class="side panel">
        <SheetHandle />
        {#if finished && variation.active}<VariationBar place="panel" back="Back to the Puzzle" onback={() => variation.leave()} />{/if}
        <div class="panel-body" {@attach sheet.gestures}>
        <section class="card" aria-label="Puzzle" data-puzzle-id={puzzle.id}>
          <p>
            <strong>
              {#if status === 'solved'}You found the best move for {SIDE_NAMES[solver]}.{:else if status === 'shown'}The solution for {SIDE_NAMES[solver]} is on the board.{:else}Find the best move for {SIDE_NAMES[solver]}.{/if}
            </strong>
          </p>
          <p role="status" aria-live="polite" class:error={feedback.includes('not the move')}>{feedback}</p>
          <!-- Before the solution, so a phone's resting sheet shows Next Puzzle without scrolling. -->
          {#if finished && !nextInBar}
            <div class="row"><button type="button" onclick={nextPuzzle}>Next Puzzle</button></div>
          {/if}
          {#if finished}
            <p class="solution">
              Solution:
              {#each line.moves.slice(1) as m, i (i)}
                {@const label = moveLabel(m.fenBefore, m.san)}
                {@const here = !variation.active && line.cursor === i + 2}
                <button type="button" class:current={here} aria-current={here ? 'step' : undefined} aria-label={`Move ${label}`} onclick={() => showSolutionMove(i + 2)}>
                  {i === 0 || turnOf(m.fenBefore) === 'white' ? label : m.san}
                </button>
              {/each}
            </p>
            {#if variation.active}
              <p class="solution" aria-label="Your variation">
                Your variation:
                {#each variation.line.moves as m, i (i)}
                  {@const label = moveLabel(m.fenBefore, m.san)}
                  {@const grade = variation.grades[i]}
                  <button
                    type="button"
                    class:current={variation.line.cursor === i + 1}
                    aria-current={variation.line.cursor === i + 1 ? 'step' : undefined}
                    aria-label={`Variation move ${label}${grade ? `, ${grade}` : ''}`}
                    onclick={() => variation.line.goTo(i + 1)}
                  >
                    {i === 0 || turnOf(m.fenBefore) === 'white' ? label : m.san}{#if grade}&nbsp;<GradeBadge {grade} />{/if}
                  </button>
                {/each}
              </p>
            {/if}
          {/if}
        </section>
        <p class="muted small">Puzzles: Lichess puzzle database, CC0.</p>
        </div>
        {#if status === 'solving' && (coach.busy || coach.entries.length)}
          <!-- The Hint, with no Ask box: the answer is still to find. -->
          <CoachPanel thread={coach} />
        {:else if status !== 'solving'}
          <CoachPanel thread={coach} onwhy={why} placeholder={askPlaceholder}>
            {#snippet steps(part: 'back' | 'on')}
              <!-- Stepping stays inside the Puzzle: its first position is the one the Player was set. -->
              <StepButtons only={part} onfirst={() => step('first')} onprevious={() => step('previous')} onnext={() => step('next')} onlast={() => step('last')} />
            {/snippet}
          </CoachPanel>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  /* On a phone the set picker sits above the board: the board gives it room, and the panel keeps the task and the Hint. */
  .puzzles { --phone-reserve: 22.5rem; }
  /* The picker's line sits between the header line and the frame. */
  @media (min-width: 821px) {
    .puzzles { --frame-h: calc(100dvh - var(--app-head) - 6rem); }
  }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .small { font-size: 0.8rem; }
  .picker { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 1rem; margin: 0 0 0.5rem; min-height: 1.5rem; }
  .picker p { margin: 0; }
  /* One row on a phone: the progress line takes what the choice leaves and never a row of its own, so the board
     starts higher. The set's name is the heading's; the count stays whole. Open, the sets push it under them. */
  @media (max-width: 820px) {
    /* The progress line leaves the set's name to the heading, so the heading shows it whole: two lines fit in the
       header line's 44 px, where one would cut a long name short. */
    .frame-head > h1 { white-space: normal; line-height: 1.15; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
    .picker { column-gap: 0.75rem; align-items: center; }
    /* The count takes what the choice leaves. It breaks only between its phrases, so a wide font or a long count takes
       a second line, which still fits the choice's 44 px row. */
    #puzzle-progress { flex: 1 1 0; min-width: 0; overflow: hidden; text-align: right; line-height: 1.25; }
    #puzzle-progress .phrase { white-space: nowrap; }
    .set-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
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
