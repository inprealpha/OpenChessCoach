<script lang="ts">
  // A Lesson: an opening, or worked examples of a Theme, an endgame or a way of thinking, in one or
  // more parts. The intro says what the Player will learn and which Lessons it builds on (ADR 0012).
  // At each of the Player's decisions the Coach asks "what are your options here?", the Engine grades
  // the chosen move, the app shows how often players at the Player's level choose each move (openings
  // only), and the Coach explains. One Coach call per decision. Every Coach call carries the Lesson's
  // learning goal and the part's key idea; the Player sees a key idea only once its part is played.
  // A move that isn't the Lesson's keeps the answer back: the Player may try another move, or
  // continue with the Lesson's move, which then shows with its note before the Lesson moves on. A
  // move that gives checkmate counts as the Lesson's move, and ends its part. The Coach's arrows show
  // no move for the Player but the one on the board: another may be the next decision's answer.
  // "How moves are written" explains the move notation the Lesson's texts use, for a beginner.
  import { tick } from 'svelte';
  import type { GradedMove } from '@chess-coach/shared/analysis';
  import { isCheck, otherSide, outcomeOf, playUci, SIDE_NAMES } from '@chess-coach/shared/chess';
  import type { CoachRequest } from '@chess-coach/shared/coach/types';
  import { knownLevels, LEVEL_NAMES, suggestNext, TRACK_NAMES } from '@chess-coach/shared/content/course';
  import {
    bandFor,
    BANDS,
    decisionAfter,
    decisions,
    type Credit,
    type Decision,
    type LessonData,
    type LessonKind,
    type LessonNode,
    type LessonPart,
  } from '@chess-coach/shared/content/lessons';
  import { MOVE_GRADES, type MoveGrade } from '@chess-coach/shared/grader';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import GradeBadge from '../components/GradeBadge.svelte';
  import { api } from '../lib/api.svelte.ts';
  import { lessonArrows } from '../lib/arrows.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { lessonCatalogue, loadLesson } from '../lib/content.ts';
  import { gradeForCoach } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { gradeCount, gradeMark } from '../lib/grades.ts';
  import { lessonProgress, lessonStatus } from '../lib/lesson-progress.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { store } from '../lib/storage.ts';

  let { lessonId }: { lessonId: string } = $props();

  let lesson = $state<LessonData | null>(null);
  let missing = $state(false);
  /** `shown`: the Player chose to continue with the Lesson's move, which the board now shows with its note. */
  let phase = $state<'intro' | 'decide' | 'feedback' | 'shown' | 'done'>('intro');
  let step = $state(0);
  let resumeStep = $state(0);
  let typed = $state('');
  let result = $state<GradedMove | null>(null);
  let hintLevel = $state(0);
  let hintArrow = $state<{ from: string; to: string; brush: 'green' } | null>(null);
  let grading = $state(false);
  let advancing = $state(false);
  let board = $state<ReturnType<typeof Board>>();
  let shownContinue = $state<HTMLButtonElement>();
  let hintButton = $state<HTMLButtonElement>();
  let doneCard = $state<HTMLElement>();
  /** The Lesson's move once shown, so Show the move says it once per decision. */
  let shownMove: { fen: string; arrow: { from: string; to: string; brush: 'green' } } | null = null;
  /** A Hint in flight: a second click while it is answered does nothing. */
  let hinting = false;
  /** The Move Grade of the Player's first try at each decision played this time, for the summary at the end. */
  let firstGrades = $state<Record<number, MoveGrade>>({});
  /** The decisions where Show the move came before the Player's first try: the summary counts them apart. */
  let shownFirst = $state<Record<number, true>>({});
  /** The decisions a checkmate made needless: the rest of its part. The summary counts them as covered. */
  let skipped = $state<Record<number, true>>({});
  const line = new Line();
  const coach = new CoachThread();
  const progress = lessonProgress();

  /** An example for the thinking box that fits the Theme or endgame being taught, within its two lines on a 375px phone. */
  const THINKING: Record<string, string> = {
    forks: 'I want to attack two pieces at once…',
    pins: 'I want to pin a piece to a more valuable one behind it…',
    'pinned-pieces': 'I want to attack the piece that can’t move…',
    skewers: 'I want to attack a piece and win the one behind it…',
    'discovered-attacks': 'I want to move one piece out of another’s way…',
    'back-rank-mate': 'I want to mate the king on its back rank…',
    'mating-patterns': 'I want to trap the king where it stands…',
    'removing-the-defender': 'I want to take away the piece that guards it…',
    'king-and-pawn': 'I want my king in front of the pawn…',
    'rook-endgames': 'I want my rook active, behind the passed pawn…',
    'candidate-moves': 'My candidates are … and …',
    'simple-plans': 'My worst piece is … so I want to…',
  };
  /** The example for a Lesson without its own, by kind. */
  const KIND_THINKING: Record<LessonKind, string> = {
    opening: 'I want to control the centre…',
    theme: 'I want to win a piece by…',
    endgame: 'I want to cut off the enemy king…',
    thinking: 'I want to check what they threaten…',
  };

  /** The Player's band: their level, or the band of their linked rating. It picks the popularity table and the next Lesson. */
  const band = $derived(bandFor(profile.player.level, profile.player.rating));
  const decisionList = $derived<Decision[]>(lesson ? decisions(lesson) : []);
  const current = $derived<Decision | undefined>(decisionList[step]);
  const node = $derived<LessonNode | undefined>(current?.node);
  const part = $derived(current?.part ?? lesson?.parts[0]);
  const isOpening = $derived(lesson?.kind === 'opening');
  /** Popularity at the Player's band, when the games database has enough games for this position. */
  const popular = $derived(node ? node.popular[band] : []);
  /** Whether the Player's move gives checkmate: like the Lesson's move, it is correct, and it ends its part. */
  const mates = $derived(result !== null && givesMate(result));
  /** Whether the Player's move is the one the Lesson teaches here, or a checkmate, which is as good. */
  const lessonMove = $derived(result !== null && node !== undefined && (result.uci === node.main || mates));
  /** A move that isn't the Lesson's: the answer stays hidden while the Player may try again. */
  const otherMove = $derived(phase === 'feedback' && result !== null && !lessonMove);
  const sound = $derived(result !== null && (result.grade === 'Best' || result.grade === 'Good'));
  /** How often players at the Player's level choose the move the Player chose, without the others, which would show the answer. */
  const mine = $derived(result ? popular.find((p) => p.uci === result?.uci) : undefined);
  /** "Checkmate!" or a stalemate, when the move on the board ends the game. */
  const ending = $derived.by(() => {
    if (phase !== 'feedback' && phase !== 'shown') return '';
    const outcome = outcomeOf(line.fen);
    if (outcome?.reason === 'checkmate') return 'Checkmate!';
    if (outcome?.reason === 'stalemate') return 'Stalemate: the game is drawn.';
    return '';
  });
  const thinkingExample = $derived(lesson ? (THINKING[lesson.id] ?? KIND_THINKING[lesson.kind]) : '');
  /**
   * The Lessons this one builds on, with how far the Player got in each. Nothing is locked: they are
   * links, not a gate. One below the Player's level counts as known (ADR 0012), so it is optional.
   */
  const builtOn = $derived(
    (lesson?.priorKnowledge ?? []).flatMap((id) => {
      const l = lessonCatalogue.find((x) => x.id === id);
      if (!l) return [];
      const status = lessonStatus(progress.list, l.id, l.decisions);
      return [{ ...l, status: status === 'Not started' && knownLevels(band).includes(l.level) ? 'Optional at your level' : status }];
    }),
  );
  /** Whether the decision on screen is the last of its part, so the part's key idea can show once it is played well. */
  const lastOfPart = $derived(current !== undefined && decisionList[step + 1]?.partIndex !== current.partIndex);
  /** Whether the move on the board ends its part: the part's last decision, or a checkmate before it. */
  const endsPart = $derived(lastOfPart || (phase === 'feedback' && mates));
  /** Whether it is the first of its part: the part's text describes the position it starts from. */
  const firstOfPart = $derived(current !== undefined && decisionList[step - 1]?.partIndex !== current.partIndex);
  /** The opponent's move that led to this decision. */
  const lastReply = $derived(node && node.ply > 0 ? line.moves[node.ply - 1] : undefined);
  /** A part where the Player changes sides from the part before it, so the board has turned round. */
  const sideChanged = $derived(current !== undefined && current.partIndex > 0 && lesson?.parts[current.partIndex - 1]?.side !== current.part.side);
  /** The key ideas of every part, for the summary at the end. */
  const keyIdeas = $derived((lesson?.parts ?? []).map((p) => p.keyIdea));
  /** "5 Best, 1 Good, 2 Mistakes, 1 after Show the move": the Player's first tries, in Move Grade order. */
  const tally = $derived.by(() => {
    const tries = Object.entries(firstGrades)
      .filter(([s]) => !(s in shownFirst))
      .map(([, g]) => g);
    const counts = MOVE_GRADES.map((g) => [g, tries.filter((x) => x === g).length] as const)
      .filter(([, n]) => n > 0)
      .map(([g, n]) => gradeCount(n, g));
    const shown = Object.keys(firstGrades).filter((s) => s in shownFirst).length;
    return [...counts, ...(shown ? [`${shown} after Show the move`] : [])].join(', ');
  });
  /** What the tally covers: every decision, or only those played since the Player resumed. */
  const tallyLead = $derived.by(() => {
    const n = Object.keys(firstGrades).length;
    if (n + Object.keys(skipped).length === decisionList.length) return 'Your first tries';
    return n === 1 ? 'Your first try at the one decision you played this time' : `Your first tries at the ${n} decisions you played this time`;
  });
  /** The Player's progress with this Lesson counted complete, for what comes after it. */
  const progressAfter = $derived.by(() => {
    if (!lesson) return progress.list;
    const { id } = lesson;
    const done = { lessonId: id, step: decisionList.length, completed: true, updatedAt: new Date().toISOString() };
    return [...progress.list.filter((p) => p.lessonId !== id), done];
  });
  /** The Lesson the app suggests next, counting this one as complete (ADR 0012). */
  const nextLesson = $derived(lesson ? suggestNext(lessonCatalogue, progressAfter, profile.player)?.lesson : undefined);
  /** The next unfinished Lesson in this one's track, in the course order, whatever its level. */
  const nextInTrack = $derived.by(() => {
    if (!lesson) return undefined;
    const { id, track } = lesson;
    const finished = new Set(progressAfter.filter((p) => p.completed).map((p) => p.lessonId));
    const at = lessonCatalogue.findIndex((l) => l.id === id);
    return lessonCatalogue.slice(at + 1).find((l) => l.track === track && !finished.has(l.id));
  });

  /** The Lesson's learning goal and the part's key idea, sent with every Coach call during the Lesson (ADR 0012). */
  function lessonFocus(p: LessonPart | undefined = part): Pick<CoachRequest, 'lessonFocus'> {
    if (!lesson || !p) return {};
    return { lessonFocus: { lesson: lesson.name, learningGoal: lesson.goal, keyIdea: p.keyIdea } };
  }

  function givesMate(move: Pick<GradedMove, 'fenAfter'>): boolean {
    return outcomeOf(move.fenAfter)?.reason === 'checkmate';
  }

  /** What the Player hears about a move that isn't the Lesson's: its Move Grade, never the answer. */
  function otherMoveText(san: string, grade: MoveGrade): string {
    const verdict = grade === 'Best' || grade === 'Good' ? `${san} is graded ${grade}: a sound move, but not the one this Lesson is teaching.` : `${san} is graded ${grade}.`;
    return `${verdict} Try another move, or continue with the Lesson’s move.`;
  }

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
    shownFirst = {};
    skipped = {};
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
    if (lesson.kind === 'opening') coach.say(`Move ${Math.floor(n.ply / 2) + 1}, ${SIDE_NAMES[d.part.side]} to play. What are your options here? Play the move you would choose.`);
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
    // One Coach call at a time: a move played while a Hint is still on its way waits for it.
    if (phase !== 'decide' || !node || !lesson || grading || coach.busy) return;
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
    // Any checkmate is as good as the Lesson's move. The notes explain the Lesson's own move only.
    const mated = givesMate(g);
    const isLessonMove = g.uci === node.main || mated;
    const notes = g.uci === node.main ? (node.notes?.text ?? '') : '';
    const popularity = popular.map((p) => ({ san: p.san, percent: p.percent }));
    const side = current?.part.side ?? lesson.side;
    if (!api.coachReady) {
      // The Lesson's notes explain the Lesson's move; for another move they would give the answer away.
      coach.say(isLessonMove ? `${played.san} is graded ${g.grade}. ${notes}`.trim() : otherMoveText(played.san, g.grade));
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
        // When the move isn't the Lesson's, the desktop's brief keeps the answer back (the notes too).
        lesson: {
          lessonId: lesson.id,
          opening: lesson.name,
          notes,
          popularity,
          finalTurn: decisionAfter(decisionList, step, mated) >= decisionList.length,
          isLessonMove,
        },
        ...lessonFocus(current?.part),
        ...(lesson.kind === 'opening' ? { opening: lesson.name } : {}),
      },
      typed.trim() ? `${played.san}: ${typed.trim()}` : played.san,
    );
  }

  /**
   * Try another move, once the Coach has answered: its arrows are about the move taken back. The
   * reasoning typed for that move goes too. The keyboard carries on from the board.
   */
  async function retry(): Promise<void> {
    if (!node || phase !== 'feedback' || coach.busy) return;
    line.takeBack();
    result = null;
    typed = '';
    phase = 'decide';
    coach.clearAnnotations();
    coach.say('Try another move.');
    await tick();
    board?.focus();
  }

  /** Continue with the Lesson's move: the board shows it, with its note, before the Lesson moves on. */
  async function showLessonMove(): Promise<void> {
    if (!node || phase !== 'feedback' || lessonMove) return;
    line.takeBack();
    line.play(node.main);
    coach.clearAnnotations();
    phase = 'shown';
    await tick();
    shownContinue?.focus();
  }

  async function next(): Promise<void> {
    // One Continue per decision: a second click while the first is saving would otherwise read the
    // step the first one has just advanced, and skip a decision.
    if (!node || !lesson || advancing || !(phase === 'shown' || (phase === 'feedback' && lessonMove))) return;
    advancing = true;
    const from = step;
    // A checkmate ends its part: the decisions left in it are needless.
    const mated = phase === 'feedback' && mates;
    const to = decisionAfter(decisionList, from, mated);
    for (let s = from + 1; s < to; s++) skipped[s] = true;
    try {
      if (to >= decisionList.length) {
        const last = decisionList[from]?.part;
        // The Player's own checkmate stays on the board.
        if (last && !mated) line.reset(last.fen, last.mainLine);
        // The finished board keeps no arrow or highlight from the last decision.
        coach.clearAnnotations();
        hintArrow = null;
        phase = 'done';
        // On a phone the card is under the board: bring it into view, so the next Lesson shows
        // without scrolling, and give it the focus, so the keyboard carries on from there.
        await tick();
        const box = doneCard?.getBoundingClientRect();
        if (box && (box.top < 0 || box.bottom > innerHeight)) doneCard?.scrollIntoView({ block: 'start' });
        doneCard?.focus({ preventScroll: true });
        await saveProgress(decisionList.length, true);
        return;
      }
      await saveProgress(to, false);
      showDecision(to);
      await tick();
      board?.focus();
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
        if (api.coachReady) {
          await coach.ask({ job: 'hint', fen: node.fen, recentMoves: line.sansUntilCursor(), ...(part ? { playerSide: part.side } : {}), ...lessonFocus() }, 'Hint, please.');
          // The button was disabled while the Coach answered, which drops the focus: it is Show the move now.
          await tick();
          if (document.activeElement === document.body) hintButton?.focus();
        } else {
          coach.say('Hints need the Coach, which is unavailable. Press Hint again to see the Lesson’s move.');
        }
        return;
      }
      // The Lesson's move, which the Engine grades Best or Good (ADR 0008), never another move the
      // Engine likes as well: the Player would then be told it isn't the one the Lesson teaches.
      hintArrow = { from: node.main.slice(0, 2), to: node.main.slice(2, 4), brush: 'green' };
      shownMove = { fen: node.fen, arrow: hintArrow };
      if (!(step in firstGrades)) shownFirst[step] = true;
      coach.say(`The Lesson’s move here is ${node.mainSan}.`);
    } finally {
      hinting = false;
    }
  }

  /**
   * A Lesson hides the Winning Chances bar so it doesn't give the answer away, and so does the Coach.
   * Like every Coach call in a Lesson, a Why Question carries the Lesson's goal and the part's key idea.
   */
  function whyContext(): Pick<CoachRequest, 'playerSide' | 'opening' | 'hideWinningChances' | 'lessonFocus'> {
    return {
      ...(part ? { playerSide: part.side } : {}),
      ...(lesson?.kind === 'opening' ? { opening: lesson.name } : {}),
      hideWinningChances: true,
      ...lessonFocus(),
    };
  }

  async function why(question: string): Promise<void> {
    const cursor = line.cursor;
    const move = line.moves[cursor - 1];
    // About the move on the board: the Player's, or the Lesson's once shown.
    const asked = phase === 'shown' && node ? { uci: node.main, label: `Why ${node.mainSan}?` } : result ? { uci: result.uci, label: `Why is ${result.san} graded ${result.grade}?` } : undefined;
    if ((phase === 'feedback' || phase === 'shown') && asked && move) {
      await coach.ask(
        {
          job: 'why',
          fen: move.fenBefore,
          recentMoves: line.moves.slice(0, cursor - 1).map((m) => m.san),
          ...whyContext(),
          moveUci: asked.uci,
          ...(question ? { question } : {}),
        },
        question || asked.label,
      );
    } else {
      await coach.ask(
        { job: 'why', fen: line.fen, recentMoves: line.sansUntilCursor(), ...whyContext(), ...(question ? { question } : {}) },
        question || 'What are the ideas in this position?',
      );
    }
  }

  /** The Coach's arrows, less any other move for the Player (`lessonArrows`), then Show the move's. */
  const arrows = $derived.by(() => {
    const side = part?.side ?? lesson?.side ?? 'white';
    const shown = lessonArrows(coach.arrows, line.fen, line.lastMove?.uci, side);
    return hintArrow ? [...shown, hintArrow] : shown;
  });
</script>

<section class="screen">
  {#if missing}
    <h1>Lesson not found</h1>
    <p><a href="#/lessons">Back to the Lessons</a></p>
  {:else if !lesson}
    <p class="muted">Loading the Lesson…</p>
  {:else}
    {#snippet credited(c: Credit)}<a href={c.url} target="_blank" rel="noreferrer">{c.source}</a>, {c.authors},
      <a href={c.licenceUrl} target="_blank" rel="noreferrer">{c.licence}</a>{/snippet}
    <!-- The notation every Lesson's text uses, in plain words; closed until the Player opens it. -->
    {#snippet notation()}
      <details class="notation">
        <summary>How moves are written</summary>
        <p>
          A square is named by a letter and a number, such as e4. The letters a to h are the files: the columns, from White’s left. The
          numbers 1 to 8 are the ranks: the rows, counted from White’s side.
        </p>
        <dl>
          <dt>K Q R B N</dt>
          <dd>king, queen, rook, bishop, knight. A pawn has no letter: e4 is a pawn moving to e4.</dd>
          <dt>x</dt>
          <dd>takes: Nxe5 is a knight taking on e5</dd>
          <dt>Rdd1</dt>
          <dd>when two pieces of the same kind could go there, a letter or number says which: the rook on the d-file goes to d1</dd>
          <dt>+</dt>
          <dd>check</dd>
          <dt>#</dt>
          <dd>checkmate</dd>
          <dt>O-O</dt>
          <dd>castles kingside, on the king’s side of the board</dd>
          <dt>O-O-O</dt>
          <dd>castles queenside, on the queen’s side of the board</dd>
          <dt>=Q</dt>
          <dd>a pawn reaches the last rank and becomes a queen</dd>
          <dt>12.</dt>
          <dd>White’s 12th move</dd>
          <dt>12...</dt>
          <dd>Black’s 12th move</dd>
        </dl>
      </details>
    {/snippet}
    <!-- How often players at the Player's level choose each move here, the Player's (or the Lesson's) move in bold. -->
    {#snippet popularity(uci: string)}
      <div class="popular">
        <h2>What players rated {BANDS[band].label} play here</h2>
        <table aria-label="Move popularity at your level">
          <tbody>
            {#each popular as p (p.uci)}
              <tr class:mine={p.uci === uci}>
                <td>{p.san}</td>
                <td class="bar"><span style:width={`${p.percent}%`}></span></td>
                <td>{p.percent}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/snippet}
    <!-- The way back first, then the name; on one line where both fit, so a phone keeps the room for the board. -->
    <div class="title">
      <a class="back" href="#/lessons"><span aria-hidden="true">←</span> Back to the Lessons</a>
      <h1>{lesson.name}</h1>
    </div>
    {#if phase === 'intro'}
      {@const firstPart = lesson.parts[0]}
      <section class="card intro" aria-label="About this Lesson">
        <p class="muted small track">{TRACK_NAMES[lesson.track].name} · {LEVEL_NAMES[lesson.level]}</p>
        <div class="goal">
          <h2>What you will learn</h2>
          <p>{lesson.goal}</p>
        </div>
        {#if builtOn.length}
          <div class="built-on">
            <h2 id="built-on-heading">It builds on these Lessons</h2>
            <ul aria-labelledby="built-on-heading">
              {#each builtOn as l (l.id)}
                <li><a href={`#/lesson/${l.id}`}>{l.name}</a> <span class="muted small" class:complete={l.status === 'Complete'}>· {l.status}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
        <p>{lesson.intro.text}</p>
        {#if lesson.intro.credit}
          <p class="credit small">Text adapted from {@render credited(lesson.intro.credit)}.</p>
        {/if}
        <!-- An opening has no Position card while it is played, so its one part's text shows here. -->
        {#if isOpening && firstPart?.text}
          <p>{firstPart.text}</p>
          {#if firstPart.textCredit}
            <p class="credit small">Text adapted from {@render credited(firstPart.textCredit)}.</p>
          {/if}
        {/if}
        {#if isOpening && firstPart && firstPart.credit.url !== lesson.intro.credit?.url}
          <p class="credit small">Moves from {@render credited(firstPart.credit)}.</p>
        {/if}
        {@render notation()}
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
      </section>
    {:else if part}
      <div class="board-layout">
        <div>
          <Board
            bind:this={board}
            fen={line.fen}
            orientation={part.side}
            movable={phase === 'decide' && !grading && !coach.busy ? part.side : 'none'}
            lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
            {arrows}
            highlights={coach.highlights}
            gradeMark={phase === 'feedback' && result ? gradeMark(line.lastMove, result.grade) : undefined}
            {onmove}
            label={`${lesson.name} Lesson board`}
          />
          <!-- Straight under the board, so on a phone the Hint and the arrow Show the move draws are both in view. -->
          {#if phase === 'decide'}
            <div class="toolbar">
              <button type="button" class="secondary" bind:this={hintButton} onclick={hint} disabled={coach.busy}>{hintLevel === 0 ? 'Hint' : 'Show the move'}</button>
            </div>
          {/if}
          <p class="muted center progress" aria-live="polite">
            {#if phase === 'done'}Lesson complete{:else}Decision {step + 1} of {decisionList.length}{/if}
          </p>
        </div>
        <div class="side" class:feedback={phase === 'feedback' || phase === 'shown'} class:hinted={phase === 'decide' && hintLevel > 0}>
          {#if !isOpening && phase !== 'done'}
            <section class="card" aria-label="Position">
              <h2>{lesson.parts.length > 1 ? `${(current?.partIndex ?? 0) + 1} of ${lesson.parts.length}: ` : ''}{part.title}</h2>
              {#if firstOfPart}
                {#if sideChanged}<p><strong>You play {SIDE_NAMES[part.side]} in this part.</strong></p>{/if}
                {#if part.text}<p>{part.text}</p>{/if}
                <!-- A part whose line starts with the opponent's move: the board already shows it. -->
                {#if lastReply}
                  <p>{SIDE_NAMES[otherSide(part.side)]} played {lastReply.san}. {#if node && isCheck(node.fen)}Your king is in check.{/if}</p>
                {/if}
              {:else}
                <!-- The part's text describes the position it started from: after its first decision, it is folded away. -->
                {#if lastReply}
                  <p>{SIDE_NAMES[otherSide(part.side)]} replied {lastReply.san}. {#if node && isCheck(node.fen)}Your king is in check.{/if}</p>
                {/if}
                {#if part.text}
                  <details class="began">
                    <summary>How this part began</summary>
                    <p>{part.text}</p>
                  </details>
                {/if}
              {/if}
              <p class="credit small">
                {#if part.textCredit && part.textCredit.url === part.credit.url}
                  Position and text adapted from {@render credited(part.credit)}.
                {:else}
                  Position from {@render credited(part.credit)}.
                  {#if part.textCredit}Text adapted from {@render credited(part.textCredit)}.{/if}
                {/if}
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
              <!-- Why a sound move doesn't go on, in the same paragraph: on a phone it then shows with the buttons. -->
              <p>
                You played <strong>{result.san}</strong> <GradeBadge grade={result.grade} /> {#if ending}<strong>{ending}</strong>{/if}
                {#if sound && !lessonMove}<span class="sound">A sound move, but not the one this Lesson is teaching.</span>{/if}
              </p>
              {#if lessonMove}
                {#if popular.length}{@render popularity(result.uci)}{/if}
              {:else}
                <!-- Only the Player's own move: the table would show the Lesson's move. -->
                {#if mine}<p class="muted small">{mine.percent}% of players rated {BANDS[band].label} play {result.san} here.</p>{/if}
              {/if}
              <div class="row">
                {#if lessonMove}
                  <button type="button" onclick={next} disabled={coach.busy || advancing}>Continue</button>
                {:else}
                  <button type="button" onclick={retry} disabled={coach.busy}>Try another move</button>
                  <button type="button" class="secondary" onclick={showLessonMove} disabled={coach.busy}>Continue with the Lesson’s move</button>
                {/if}
              </div>
              <!-- After Continue, so on a phone the summing-up line never pushes the button off the screen. -->
              {#if endsPart && lessonMove}
                <p class="key-idea"><strong>Key idea:</strong> {part.keyIdea}</p>
              {/if}
            </section>
          {/if}
          {#if phase === 'shown' && node}
            <section class="card choice" aria-label="The Lesson’s move">
              <p>The Lesson continues with <strong>{node.mainSan}</strong>, the move it teaches. {#if ending}<strong>{ending}</strong>{/if}</p>
              {#if node.notes?.text}<p>{node.notes.text}</p>{/if}
              {#if popular.length}{@render popularity(node.main)}{/if}
              <div class="row">
                <button type="button" bind:this={shownContinue} onclick={next} disabled={coach.busy || advancing}>Continue</button>
              </div>
              {#if lastOfPart}
                <p class="key-idea"><strong>Key idea:</strong> {part.keyIdea}</p>
              {/if}
            </section>
          {/if}
          {#if phase === 'done'}
            <section class="card done" aria-label="Lesson complete" tabindex="-1" bind:this={doneCard}>
              <p><strong>Lesson complete.</strong> It is marked complete in your Player Profile.</p>
              {#if tally}
                <p>{tallyLead}: {tally}.</p>
              {/if}
              {#if keyIdeas.length}
                <h2 id="learned-heading">What you learned</h2>
                <ul class="learned" aria-labelledby="learned-heading">
                  {#each keyIdeas as idea, i (i)}<li>{idea}</li>{/each}
                </ul>
              {/if}
              {#if nextLesson}
                <p class="next"><a class="button" href={`#/lesson/${nextLesson.id}`}>Your next Lesson: {nextLesson.name}</a></p>
                {#if nextInTrack && nextInTrack.id !== nextLesson.id}
                  <p class="next"><a class="button secondary" href={`#/lesson/${nextInTrack.id}`}>Next in {TRACK_NAMES[lesson.track].name}: {nextInTrack.name}</a></p>
                {/if}
              {:else}
                <p>You have done every Lesson. Go over any of them again, or practise with <a href="#/puzzles">Puzzles</a>.</p>
              {/if}
              <ul class="more">
                {#if lesson.playOut}
                  <li><a href={`#/play-out/${lesson.id}`}>Play it out against the Engine: {lesson.playOut.title}</a></li>
                {/if}
                {#if lesson.kind === 'opening' || lesson.puzzleThemes.length}
                  <li><a href={`#/puzzles/${lesson.id}`}>Practise with {lesson.name} Puzzles</a></li>
                {/if}
                <li><a href="#/lessons">Back to the Lessons</a></li>
              </ul>
            </section>
          {/if}
          <!-- While the Player chooses, the thinking box is the one place to type; Why Questions follow
               the Move Grade, once the answer is no longer kept back. -->
          <CoachPanel thread={coach} onwhy={phase === 'decide' || otherMove ? undefined : why} />
          {@render notation()}
          {#if node?.notes?.credit || (lesson.statsSource && popular.length)}
            <p class="credit small">
              {#if node?.notes?.credit}Lesson notes adapted from {@render credited(node.notes.credit)}.{/if}
              {#if lesson.statsSource && popular.length}Popularity: {lesson.statsSource}.{/if}
            </p>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .title { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.2rem 1rem; margin-bottom: 0.8rem; }
  .title h1 { margin: 0; }
  .back { order: 1; font-size: 0.9rem; }
  .intro { max-width: 42rem; display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; }
  .intro p { margin: 0; }
  .intro h2 { margin: 0 0 0.2rem; }
  .intro .goal { border-left: 3px solid var(--accent); padding-left: 0.7rem; }
  .built-on ul { margin: 0; padding-left: 1.2rem; }
  .built-on li { margin: 0.15rem 0; }
  .built-on .complete { color: var(--accent); font-weight: 600; }
  .key-idea { margin: 0.6rem 0 0; }
  /* Focused when the Lesson ends, so the keyboard carries on from it: no ring after a click. */
  .done { scroll-margin-top: 0.5rem; }
  .done:focus:not(:focus-visible) { outline: none; }
  /* How moves are written: one quiet line until opened, then a short two-column list. */
  .notation { font-size: 0.85rem; max-width: 42rem; }
  .notation summary, .began summary { cursor: pointer; color: var(--muted); }
  .notation summary:hover, .began summary:hover { color: var(--text); }
  .notation p { margin: 0.4rem 0; }
  .notation dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.7rem; margin: 0; }
  .notation dt { font-weight: 700; white-space: nowrap; }
  .notation dd { margin: 0; }
  .began { margin: 0.5rem 0; font-size: 0.9rem; }
  .began p { margin: 0.4rem 0 0; }
  .learned { margin: 0 0 0.6rem; padding-left: 1.2rem; }
  .learned li { margin: 0.2rem 0; }
  /* What to do next, each a comfortable touch target. */
  .next { margin: 0.5rem 0; }
  .button {
    display: inline-block; background: var(--accent); color: var(--accent-text); border-radius: 8px;
    padding: 0.6rem 1.1rem; text-decoration: none; font-weight: 600;
  }
  .button:hover { filter: brightness(1.08); }
  .button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; }
  .more { list-style: none; padding: 0; margin: 0.6rem 0 0; }
  .more a { display: inline-block; padding: 0.4rem 0; }
  .credit { color: var(--muted); }
  .small { font-size: 0.8rem; }
  .center { text-align: center; }
  .progress { margin: 0.2rem 0 0; }
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
     reply straight under the board, before the position's text, so no decision needs scrolling. A
     Hint's answer comes there too, under the Hint button. */
  @media (max-width: 820px) {
    .side.feedback > .choice { order: -2; }
    .side.feedback > :global(.coach), .side.hinted > :global(.coach) { order: -1; }
    /* The buttons straight after the first line, then the rest, the popularity table last: so the
       way on shows on a phone even with Safari's bars. */
    .choice { display: flex; flex-direction: column; gap: 0.5rem; }
    .choice > :global(*) { margin: 0; order: 2; }
    .choice > :global(:first-child) { order: 0; }
    .choice > .row { order: 1; }
    /* Try another move and Continue with the Lesson’s move side by side, so both show at 390×664. */
    .choice > .row:has(> :nth-child(2)) { display: grid; grid-template-columns: 1fr 1fr; }
    .choice > .row:has(> :nth-child(2)) > button { padding: 0.4rem 0.5rem; line-height: 1.25; }
    .choice > :global(.popular) { order: 3; }
    .popular h2 { margin-top: 0; }
  }
</style>
