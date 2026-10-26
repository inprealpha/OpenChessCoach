<script lang="ts">
  // A Lesson: an opening, or worked examples of a Theme or an endgame, in one or more parts. At each
  // of the Player's decisions the Coach asks "what are your options here?", the Engine grades the
  // chosen move, the app shows how often players at the Player's level choose each move (openings
  // only), and the Coach explains. One Coach call per decision.
  import { candidatesFrom, type GradedMove } from '@chess-coach/shared/analysis';
  import { playUci, SIDE_NAMES } from '@chess-coach/shared/chess';
  import type { Analysis } from '@chess-coach/shared/engine';
  import { bandFor, BANDS, decisions, type Decision, type LessonData, type LessonNode } from '@chess-coach/shared/content/lessons';
  import { MOVE_GRADES, type MoveGrade } from '@chess-coach/shared/grader';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import GradeBadge from '../components/GradeBadge.svelte';
  import { api } from '../lib/api.svelte.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { lessonCatalogue, loadLesson } from '../lib/content.ts';
  import { analyseForCoach, gradeForCoach } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { gradeCount, gradeMark } from '../lib/grades.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { store } from '../lib/storage.ts';

  let { lessonId }: { lessonId: string } = $props();

  let lesson = $state<LessonData | null>(null);
  let missing = $state(false);
  let phase = $state<'intro' | 'decide' | 'feedback' | 'done'>('intro');
  let step = $state(0);
  let resumeStep = $state(0);
  let typed = $state('');
  let result = $state<GradedMove | null>(null);
  let hintLevel = $state(0);
  let hintArrow = $state<{ from: string; to: string; brush: 'green' } | null>(null);
  let grading = $state(false);
  let advancing = $state(false);
  /** The Engine's move once shown, so Show the move says it once per decision. */
  let shownMove: { fen: string; arrow: { from: string; to: string; brush: 'green' } } | null = null;
  /** A Hint in flight: a second click while it is answered does nothing. */
  let hinting = false;
  /** The Move Grade of the Player's first try at each decision played this time, for the summary at the end. */
  let firstGrades = $state<Record<number, MoveGrade>>({});
  const line = new Line();
  const coach = new CoachThread();

  /** An example for the thinking box that fits the Theme or endgame being taught, within its two lines on a 375px phone. */
  const THINKING: Record<string, string> = {
    forks: 'I want to attack two pieces at once…',
    pins: 'I want to pin a piece to a more valuable one behind it…',
    skewers: 'I want to attack a piece and win the one behind it…',
    'discovered-attacks': 'I want to move one piece out of another’s way…',
    'back-rank-mate': 'I want to mate the king on its back rank…',
    'removing-the-defender': 'I want to take away the piece that guards it…',
    'king-and-pawn': 'I want my king in front of the pawn…',
    'rook-endgames': 'I want my rook active, behind the passed pawn…',
  };

  const band = $derived(bandFor(profile.profile?.level ?? 'beginner', profile.profile?.rating ?? null));
  const decisionList = $derived<Decision[]>(lesson ? decisions(lesson) : []);
  const current = $derived<Decision | undefined>(decisionList[step]);
  const node = $derived<LessonNode | undefined>(current?.node);
  const part = $derived(current?.part ?? lesson?.parts[0]);
  const isOpening = $derived(lesson?.kind === 'opening');
  /** Popularity at the Player's band, when the games database has enough games for this position. */
  const popular = $derived(node ? node.popular[band] : []);
  const poorChoice = $derived(result !== null && ['Inaccuracy', 'Mistake', 'Blunder'].includes(result.grade));
  const thinkingExample = $derived(
    lesson ? (THINKING[lesson.id] ?? (isOpening ? 'I want to control the centre…' : lesson.kind === 'theme' ? 'I want to win material by…' : 'I want to cut off the enemy king…')) : '',
  );
  /** "5 Best, 1 Good, 2 Mistakes": the Player's first tries, in Move Grade order. */
  const tally = $derived(
    MOVE_GRADES.map((g) => [g, Object.values(firstGrades).filter((x) => x === g).length] as const)
      .filter(([, n]) => n > 0)
      .map(([g, n]) => gradeCount(n, g))
      .join(', '),
  );
  /** What the tally covers: every decision, or only those played since the Player resumed. */
  const tallyLead = $derived.by(() => {
    const n = Object.keys(firstGrades).length;
    if (n === decisionList.length) return 'Your first tries';
    return n === 1 ? 'Your first try at the one decision you played this time' : `Your first tries at the ${n} decisions you played this time`;
  });
  /** The next Lesson in the same section of the catalogue (openings for the same side, Themes, endgames). */
  const nextLesson = $derived.by(() => {
    if (!lesson) return undefined;
    const { id, kind, side } = lesson;
    const section = lessonCatalogue.filter((l) => l.kind === kind && (kind !== 'opening' || l.side === side));
    return section[section.findIndex((l) => l.id === id) + 1];
  });

  $effect(() => {
    void load(lessonId);
  });

  async function load(id: string): Promise<void> {
    const data = await loadLesson(id);
    if (!data) {
      missing = true;
      return;
    }
    lesson = data;
    const local = (await store.get<number>(`lesson:${id}`)) ?? 0;
    let saved = local;
    if (api.state === 'online') {
      try {
        const { lessons } = await api.request('lessons.progress', {});
        const p = lessons.find((l) => l.lessonId === id);
        const desktop = p && !p.completed ? p.step : 0;
        // Whichever got further wins. Progress saved only on this device (offline, or a reload
        // before the desktop answered) is sent to the desktop now.
        saved = Math.max(local, desktop);
        if (local > desktop) await api.request('lessons.update', { lessonId: id, step: local, completed: false });
      } catch {
        // offline: use the local copy
      }
    }
    resumeStep = Math.min(saved, decisions(data).length - 1);
  }

  /** Start (or Resume) once: a double click must not show the first decision's prompt twice. */
  function start(s: number): void {
    if (phase !== 'intro') return;
    firstGrades = {};
    showDecision(s);
  }

  function showDecision(s: number): void {
    if (!lesson) return;
    step = s;
    const d = decisionList[s];
    if (!d) return;
    const n = d.node;
    line.reset(d.part.fen, d.part.mainLine.slice(0, n.ply));
    result = null;
    typed = '';
    hintLevel = 0;
    hintArrow = null;
    coach.clearAnnotations();
    phase = 'decide';
    if (lesson.kind === 'opening') coach.say(`Move ${Math.floor(n.ply / 2) + 1}${n.ply % 2 ? '…' : '.'} What are your options here? Play the move you would choose.`);
    else coach.say(`${SIDE_NAMES[d.part.side]} to move. What are your options here? Play the move you would choose.`);
  }

  async function saveProgress(s: number, completed: boolean): Promise<void> {
    await store.set(`lesson:${lessonId}`, completed ? 0 : s);
    if (api.state === 'online') {
      try {
        await api.request('lessons.update', { lessonId, step: s, completed });
      } catch {
        // progress is kept locally and sent next time
      }
    }
  }

  async function onmove(uci: string): Promise<void> {
    if (phase !== 'decide' || !node || !lesson || grading) return;
    const played = playUci(node.fen, uci);
    if (!played) return;
    line.play(uci);
    grading = true;
    hintArrow = null;
    let g: GradedMove;
    try {
      g = await gradeForCoach(node.ply + 1, node.fen, played.uci, played.fenAfter);
    } catch (err) {
      line.takeBack();
      coach.sayError(err);
      return;
    } finally {
      grading = false;
    }
    result = g;
    if (!(step in firstGrades)) firstGrades[step] = g.grade;
    phase = 'feedback';
    const popularity = popular.map((p) => ({ san: p.san, percent: p.percent }));
    const side = current?.part.side ?? lesson.side;
    if (!api.coachReady) {
      coach.say(`${played.san} is graded ${g.grade}. ${node.notes?.text ?? ''}`);
      return;
    }
    await coach.ask(
      {
        job: 'lesson-turn',
        fen: node.fen,
        recentMoves: line.moves.slice(0, node.ply).map((m) => m.san),
        playerSide: side,
        moveUci: g.uci,
        ...(typed.trim() ? { question: typed.trim() } : {}),
        lesson: {
          lessonId: lesson.id,
          opening: lesson.name,
          notes: node.notes?.text ?? '',
          popularity,
          finalTurn: step === decisionList.length - 1,
        },
        ...(lesson.kind === 'opening' ? { opening: lesson.name } : {}),
      },
      typed.trim() ? `${played.san}: ${typed.trim()}` : played.san,
    );
  }

  function retry(): void {
    if (!node) return;
    line.takeBack();
    result = null;
    phase = 'decide';
    coach.clearAnnotations();
    coach.say('Try another move.');
  }

  async function next(): Promise<void> {
    // One Continue per decision: a second click while the first is saving would otherwise read the
    // step the first one has just advanced, and skip a decision.
    if (!node || !lesson || phase !== 'feedback' || advancing) return;
    advancing = true;
    const from = step;
    try {
      if (result && result.uci !== node.main) coach.say(`The Lesson continues with the main line, ${node.mainSan}.`);
      if (from >= decisionList.length - 1) {
        const last = decisionList[from]?.part;
        if (last) line.reset(last.fen, last.mainLine);
        phase = 'done';
        await saveProgress(decisionList.length, true);
        return;
      }
      await saveProgress(from + 1, false);
      showDecision(from + 1);
    } finally {
      advancing = false;
    }
  }

  async function hint(): Promise<void> {
    if (!node || phase !== 'decide' || hinting) return;
    // Show the move once per decision: another click (after Try another move, say) brings the
    // arrow back, with no new line.
    if (shownMove?.fen === node.fen) {
      hintArrow = shownMove.arrow;
      return;
    }
    hinting = true;
    hintLevel++;
    try {
      if (hintLevel === 1) {
        if (api.coachReady) await coach.ask({ job: 'hint', fen: node.fen, recentMoves: line.sansUntilCursor(), ...(part ? { playerSide: part.side } : {}) }, 'Hint, please.');
        else coach.say('Hints need the Coach, which is unavailable. Press Hint again to see the Engine’s move.');
        return;
      }
      const fen = node.fen;
      let a: Analysis;
      try {
        a = await analyseForCoach(fen);
      } catch (err) {
        hintLevel--;
        coach.sayError(err);
        return;
      }
      const best = a.lines[0]?.pv[0];
      if (best) {
        hintArrow = { from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' };
        shownMove = { fen, arrow: hintArrow };
        coach.say(`The Engine’s move here is ${candidatesFrom(a)[0]?.san}.`);
      }
    } finally {
      hinting = false;
    }
  }

  /** A Lesson hides the Winning Chances bar so it doesn't give the answer away, and so does the Coach. */
  function whyContext(): { playerSide?: 'white' | 'black'; opening?: string; hideWinningChances: true } {
    return { ...(part ? { playerSide: part.side } : {}), ...(lesson?.kind === 'opening' ? { opening: lesson.name } : {}), hideWinningChances: true };
  }

  async function why(question: string): Promise<void> {
    const cursor = line.cursor;
    const move = line.moves[cursor - 1];
    if (phase === 'feedback' && result && move) {
      await coach.ask(
        {
          job: 'why',
          fen: move.fenBefore,
          recentMoves: line.moves.slice(0, cursor - 1).map((m) => m.san),
          ...whyContext(),
          moveUci: result.uci,
          ...(question ? { question } : {}),
        },
        question || `Why is ${result.san} graded ${result.grade}?`,
      );
    } else {
      await coach.ask(
        { job: 'why', fen: line.fen, recentMoves: line.sansUntilCursor(), ...whyContext(), ...(question ? { question } : {}) },
        question || 'What are the ideas in this position?',
      );
    }
  }

  const arrows = $derived(hintArrow ? [...coach.arrows, hintArrow] : coach.arrows);
</script>

<section class="screen">
  {#if missing}
    <h1>Lesson not found</h1>
    <p><a href="#/lessons">Back to the Lessons</a></p>
  {:else if !lesson}
    <p class="muted">Loading the Lesson…</p>
  {:else}
    <h1>{lesson.name}</h1>
    {#if phase === 'intro'}
      <div class="card intro">
        <p>{lesson.intro.text}</p>
        <p class="credit small">
          Adapted from <a href={lesson.intro.credit.url} target="_blank" rel="noreferrer">{lesson.intro.credit.source}</a>, {lesson.intro.credit.authors},
          <a href={lesson.intro.credit.licenceUrl} target="_blank" rel="noreferrer">{lesson.intro.credit.licence}</a>.
        </p>
        {#if isOpening}
          <p>You play {SIDE_NAMES[lesson.side]}. There are {decisionList.length} decisions.</p>
        {:else}
          <p>There are {lesson.parts.length} {lesson.parts.length === 1 ? 'position' : 'positions'} and {decisionList.length} decisions.</p>
        {/if}
        {#if resumeStep > 0}
          <button type="button" onclick={() => start(resumeStep)}>Resume the Lesson</button>
          <button type="button" class="secondary" onclick={() => start(0)}>Start from the beginning</button>
        {:else}
          <button type="button" onclick={() => start(0)}>Start the Lesson</button>
        {/if}
      </div>
    {:else if part}
      <div class="board-layout">
        <div>
          <Board
            fen={line.fen}
            orientation={part.side}
            movable={phase === 'decide' && !grading ? part.side : 'none'}
            lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
            {arrows}
            highlights={coach.highlights}
            gradeMark={phase === 'feedback' && result ? gradeMark(line.lastMove, result.grade) : undefined}
            {onmove}
            label={`${lesson.name} Lesson board`}
          />
          <p class="muted center" aria-live="polite">
            {#if phase === 'done'}Lesson complete{:else}Decision {step + 1} of {decisionList.length}{/if}
          </p>
        </div>
        <div class="side" class:feedback={phase === 'feedback'}>
          {#if !isOpening && phase !== 'done'}
            <section class="card" aria-label="Position">
              <h2>{lesson.parts.length > 1 ? `${(current?.partIndex ?? 0) + 1} of ${lesson.parts.length}: ` : ''}{part.title}</h2>
              {#if part.text}<p>{part.text}</p>{/if}
              <p class="credit small">
                {part.credit.licence === 'CC0 1.0' ? 'Position from' : 'Adapted from'}
                <a href={part.credit.url} target="_blank" rel="noreferrer">{part.credit.source}</a>, {part.credit.authors},
                <a href={part.credit.licenceUrl} target="_blank" rel="noreferrer">{part.credit.licence}</a>.
              </p>
            </section>
          {/if}
          {#if phase === 'decide'}
            <label class="typed">
              Explain your thinking (optional)
              <textarea bind:value={typed} rows="2" maxlength="300" placeholder={thinkingExample} aria-describedby="typed-note"></textarea>
            </label>
            <p id="typed-note" class="muted small note">The Coach reads it with your move.</p>
          {/if}
          {#if phase === 'feedback' && result && node}
            <section class="card choice" aria-label="Your choice">
              <p>You played <strong>{result.san}</strong> <GradeBadge grade={result.grade} /></p>
              {#if popular.length}
                <h2>What players rated {BANDS[band].label} play here</h2>
                <table aria-label="Move popularity at your level">
                  <tbody>
                    {#each popular as p (p.uci)}
                      <tr class:mine={p.uci === result.uci}>
                        <td>{p.san}</td>
                        <td class="bar"><span style:width={`${p.percent}%`}></span></td>
                        <td>{p.percent}%</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              <div class="row">
                {#if poorChoice}
                  <button type="button" onclick={retry}>Try another move</button>
                  <button type="button" class="secondary" onclick={next} disabled={coach.busy || advancing}>Continue with the main line</button>
                {:else}
                  <button type="button" onclick={next} disabled={coach.busy || advancing}>Continue</button>
                {/if}
              </div>
            </section>
          {/if}
          {#if phase === 'done'}
            <section class="card" aria-label="Lesson complete">
              <p><strong>Lesson complete.</strong> It is marked complete in your Player Profile.</p>
              {#if tally}
                <p>{tallyLead}: {tally}.</p>
              {/if}
              {#if nextLesson}
                <p><a href={`#/lesson/${nextLesson.id}`}>Next Lesson: {nextLesson.name}</a></p>
              {/if}
              {#if lesson.playOut}
                <p><a href={`#/play-out/${lesson.id}`}>Play it out against the Engine: {lesson.playOut.title}</a></p>
              {/if}
              {#if lesson.kind === 'opening' || lesson.puzzleThemes.length}
                <a href={`#/puzzles/${lesson.id}`}>Practise with {lesson.name} Puzzles</a> ·
              {/if}
              <a href="#/lessons">Back to the Lessons</a>
            </section>
          {/if}
          <!-- While the Player chooses, the thinking box is the one place to type; Why Questions follow the Move Grade. -->
          <CoachPanel thread={coach} onwhy={phase === 'decide' ? undefined : why}>
            {#snippet actions()}
              {#if phase === 'decide'}
                <button type="button" class="secondary" onclick={hint} disabled={coach.busy}>{hintLevel === 0 ? 'Hint' : 'Show the move'}</button>
              {/if}
            {/snippet}
          </CoachPanel>
          {#if node?.notes}
            <p class="credit small">
              Lesson notes adapted from <a href={node.notes.credit.url} target="_blank" rel="noreferrer">{node.notes.credit.source}</a>,
              {node.notes.credit.authors}, <a href={node.notes.credit.licenceUrl} target="_blank" rel="noreferrer">{node.notes.credit.licence}</a>.
              {#if lesson.statsSource && popular.length}Popularity: {lesson.statsSource}.{/if}
            </p>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .intro { max-width: 42rem; display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  .credit { color: var(--muted); }
  .small { font-size: 0.8rem; }
  .center { text-align: center; }
  .typed { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  /* Two lines that wrap, so the example and the Player's own words show whole on any phone's font. */
  .typed textarea { width: 100%; box-sizing: border-box; resize: vertical; }
  .note { margin: -0.5rem 0 0; }
  h2 { font-size: 0.95rem; margin: 0.6rem 0 0.3rem; }
  section[aria-label='Position'] h2 { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  td { padding: 0.15rem 0.3rem; }
  .bar { width: 60%; }
  .bar span { display: block; height: 0.7rem; background: var(--accent); border-radius: 3px; min-width: 2px; }
  tr.mine td { font-weight: 700; }
  .row { display: flex; gap: 0.5rem; margin-top: 0.6rem; flex-wrap: wrap; }
  /* On a phone the board and the side panel stack: put the Player's choice, Continue and the Coach's
     reply straight under the board, before the position's text, so no decision needs scrolling. */
  @media (max-width: 820px) {
    .side.feedback > .choice { order: -2; }
    .side.feedback > :global(.coach) { order: -1; }
  }
</style>
