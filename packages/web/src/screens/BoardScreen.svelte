<script lang="ts">
  // A free board: play moves for both sides, see each Move Grade and the Engine's candidates, and
  // ask the Coach a Why Question about any move or position. The Player can set up any position
  // from a FEN, or a game from its PGN, and #/board?fen=… opens on a position.
  import { tick, untrack } from 'svelte';
  import type { GradedMove } from '@chess-coach/shared/analysis';
  import type { Analysis } from '@chess-coach/shared/engine';
  import { INITIAL_FEN, otherSide, outcomeOf, playUci, SIDE_NAMES, turnOf, type Side } from '@chess-coach/shared/chess';
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { readPosition, type SetUpPosition } from '@chess-coach/shared/setup';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import EngineLines from '../components/EngineLines.svelte';
  import MoveList from '../components/MoveList.svelte';
  import StepButtons from '../components/StepButtons.svelte';
  import ThreatButton from '../components/ThreatButton.svelte';
  import { threatArrows } from '../lib/arrows.ts';
  import { gradeMark } from '../lib/grades.ts';
  import WinningChancesBar from '../components/WinningChancesBar.svelte';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { analyse, gradeMove, threat } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { router } from '../lib/router.svelte.ts';
  import { threatSetting, ThreatView } from '../lib/threat.svelte.ts';
  import { scoreFromAnalysis } from '../lib/position-score.ts';

  /** A FEN to open on, from #/board?fen=…. */
  let { fen: openAt }: { fen?: string } = $props();
  /** The link the Board last opened, until it drops it from the address. */
  let opened = untrack(() => openAt);

  const line = new Line();
  const coach = new CoachThread();
  let orientation = $state<Side>('white');
  /** The side the Player last turned the board to, which New board keeps; a set-up turns it on its own. */
  let chosenOrientation: Side = 'white';
  let showLines = $state(false);
  let analysis = $state<Analysis | null>(null);
  let graded = $state<(GradedMove | undefined)[]>([]);
  /** Counts new boards: each gets a fresh Board, so its start position shows at once rather than sliding. */
  let boards = $state(0);
  const grades = $derived(graded.map((g) => g?.grade as MoveGrade | undefined));
  /** The Move Grade of the move that reached the position on the board, on the square it landed on. */
  const mark = $derived(gradeMark(line.lastMove, grades[line.cursor - 1]));
  /** The browser Engine's verdict on the position shown, for the Winning Chances bar (ADR 0007). */
  const position = $derived(scoreFromAnalysis(line.fen, analysis));
  /** The move already sent to the Engine at each ply, so each move is graded once. */
  const asked: string[] = [];

  /**
   * How long the Player stays on a position before the Engine is asked about it. The Engine searches
   * one position at a time and can't drop a search it was given, so stepping through a game asks
   * only where the Player stops.
   */
  const SETTLE_MS = 200;
  /**
   * What the Board asks the Engine about without waiting: what it asked before, which the Engine's
   * cache answers at once, and the positions of a move the Player just played.
   */
  // A plain set, not state: nothing renders from it.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const known = new Set<string>();

  /** Asks once the Player has stayed `SETTLE_MS` on the position, or at once if all of `keys` are known; returns the effect's cleanup. */
  function whenSettled(keys: readonly string[], ask: () => void): () => void {
    if (keys.every((k) => known.has(k))) {
      ask();
      return () => undefined;
    }
    const timer = setTimeout(() => {
      for (const k of keys) known.add(k);
      ask();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }

  let settingUp = $state(false);
  let setupText = $state('');
  let setupError = $state('');
  /** What the last set-up put on the board, for a screen reader: the board changes out of sight. */
  let setupNote = $state('');
  let setupBox = $state<HTMLTextAreaElement>();
  let setupButton = $state<HTMLButtonElement>();

  const threats = new ThreatView(threat);

  /** What ends the game in the position shown: the free board has nobody else to say so. */
  const result = $derived.by(() => {
    const o = outcomeOf(line.fen);
    if (!o) return '';
    if (o.winner) return `Checkmate. ${SIDE_NAMES[o.winner]} wins.`;
    if (o.reason === 'stalemate') return 'Stalemate. It’s a draw.';
    // Moves can still be played here, but the Engine has no move to grade them against.
    const ungraded = 'Moves played from here get no Move Grade.';
    if (o.reason === 'insufficient') return `A draw: neither side has enough pieces left to mate. ${ungraded}`;
    return `A draw by the fifty-move rule. ${ungraded}`;
  });

  $effect(() => {
    const fen = line.fen;
    analysis = null;
    // Only this run writes, so a search for a position the Player has left can't overwrite the one shown.
    let current = true;
    const cancel = whenSettled([fen], () => {
      void analyse(fen, (partial) => {
        if (current) analysis = partial;
      }).then((a) => {
        if (current) analysis = a;
      });
    });
    return () => {
      current = false;
      cancel();
    };
  });

  // Each move gets its Move Grade once the Player is on it: as it is played, or, in a set-up
  // game, when they stop on it, so a long PGN costs the Engine nothing until it is looked at.
  $effect(() => {
    const ply = line.cursor;
    const m = line.lastMove;
    if (!m || graded[ply - 1]) return;
    // A move from a position whose game is over has nothing to be graded against: the Result says so.
    if (outcomeOf(m.fenBefore)) return;
    const key = `${m.fenBefore} ${m.uci}`;
    if (asked[ply - 1] === key) return;
    return whenSettled([m.fenBefore, m.fenAfter], () => {
      asked[ply - 1] = key;
      gradeMove(ply, m.fenBefore, m.uci, m.fenAfter).then(
        (g) => {
          // Dropped if the line no longer has this move there: a new set-up, or another move played.
          const now = line.moves[ply - 1];
          if (now?.fenBefore !== m.fenBefore || now.uci !== m.uci) return;
          const next = [...graded];
          next[ply - 1] = g;
          graded = next;
        },
        // The move stays ungraded; an Engine that can't start says so itself.
        () => undefined,
      );
    });
  });

  // After the position's own search, so the bar and the lines come first.
  $effect(() => {
    const fen = threatSetting.on ? line.fen : null;
    // The threat shown belongs to the position left; the new one's comes once the Player stays.
    if (!fen || !known.has(`threat ${fen}`)) threats.follow(null);
    if (fen) return whenSettled([`threat ${fen}`], () => threats.follow(fen));
  });

  function onmove(uci: string): void {
    const m = playUci(line.fen, uci);
    if (!m) return;
    known.add(m.fenBefore).add(m.fenAfter);
    coach.clearAnnotations();
    // The line's own next move steps to it, as on Lichess, so a set-up game keeps the rest of its moves.
    if (line.moves[line.cursor]?.uci === m.uci) {
      line.forward();
      return;
    }
    const ply = line.cursor + 1;
    line.play(uci);
    graded = graded.slice(0, ply - 1);
    asked.length = Math.min(asked.length, ply - 1);
  }

  async function why(question: string): Promise<void> {
    const cursor = line.cursor;
    const move = line.moves[cursor - 1];
    if (move) {
      const grade = graded[cursor - 1]?.grade;
      await coach.ask(
        {
          job: 'why',
          fen: move.fenBefore,
          recentMoves: line.moves.slice(0, cursor - 1).map((m) => m.san),
          moveUci: move.uci,
          ...(question ? { question } : {}),
        },
        question || (grade ? `Why is ${move.san} graded ${grade}?` : `Why ${move.san}?`),
      );
    } else {
      await coach.ask({ job: 'why', fen: line.fen, recentMoves: [], ...(question ? { question } : {}) }, question || 'What are the options in this position?');
    }
  }

  /** A fresh line from a start position and its moves, shown from its first position on a fresh Board, so it doesn't slide. */
  function start(p: SetUpPosition = { startFen: INITIAL_FEN, moves: [] }): void {
    boards++;
    line.reset(p.startFen, p.moves);
    line.goTo(0);
    graded = [];
    asked.length = 0;
    coach.reset();
  }

  function flip(): void {
    orientation = chosenOrientation = otherSide(orientation);
  }

  /** Drops a link's ?fen= from the address once the board no longer shows it, so a reload doesn't bring it back. */
  function leaveLink(): void {
    if (!openAt) return;
    opened = undefined;
    router.replace('board');
  }

  function newBoard(): void {
    start();
    orientation = chosenOrientation;
    setupNote = '';
    leaveLink();
  }

  /** Sets up a pasted FEN or PGN; on a mistake, says what's wrong and leaves the board as it was. */
  function setUp(text: string): boolean {
    let p: SetUpPosition;
    try {
      p = readPosition(text);
    } catch (e) {
      setupError = e instanceof Error ? e.message : String(e);
      return false;
    }
    start(p);
    // A position is seen from the side to move, as a Puzzle is; a game from White's side.
    orientation = p.moves.length ? 'white' : turnOf(p.startFen);
    setupError = '';
    settingUp = false;
    const n = p.moves.length;
    setupNote = n
      ? `Game set up at its first position: step through its ${n} move${n === 1 ? '' : 's'} with → and ←.`
      : `Position set up: ${SIDE_NAMES[turnOf(p.startFen)]} to move.`;
    return true;
  }

  async function openSetUp(): Promise<void> {
    settingUp = !settingUp;
    setupError = '';
    await tick();
    setupBox?.focus();
  }

  /** Closes the form and puts focus back on the button that opened it, as the app's other dialogs do. */
  async function closeSetUp(): Promise<void> {
    settingUp = false;
    await tick();
    setupButton?.focus();
  }

  async function submitSetUp(): Promise<void> {
    if (!setUp(setupText)) return;
    leaveLink();
    await closeSetUp();
  }

  /** Opens a link's FEN, or the form with it and its error, focused, when it can't be read. */
  async function openLink(fen: string): Promise<void> {
    if (setUp(fen)) return;
    settingUp = true;
    setupText = fen;
    await tick();
    setupBox?.focus();
  }

  // The link the Board opened with, then each address the Player goes to while it is shown, as if
  // the Board opened afresh: another link opens its position, and #/board (Back) a new board.
  if (opened) void openLink(opened);
  $effect(() => {
    const fen = openAt;
    if (fen === opened) return;
    opened = fen;
    untrack(() => (fen ? void openLink(fen) : newBoard()));
  });
</script>

<section class="screen">
  <h1>Board</h1>
  <div class="board-layout">
    <div class="board-and-bar">
      <div class="with-bar">
        <WinningChancesBar score={position?.score ?? null} pov={position?.pov ?? 'white'} {orientation} />
        {#key boards}
          <Board
            fen={line.fen}
            {orientation}
            movable="both"
            lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
            arrows={[...threatArrows(threats.threat), ...coach.arrows]}
            highlights={coach.highlights}
            gradeMark={mark}
            {onmove}
          />
        {/key}
      </div>
      <div class="toolbar">
        <StepButtons onfirst={() => line.goTo(0)} onprevious={() => line.back()} onnext={() => line.forward()} onlast={() => line.goTo(line.moves.length)} />
        <button type="button" class="secondary" onclick={flip}>Flip board</button>
        <button type="button" class="secondary" onclick={newBoard}>New board</button>
        <button type="button" class="secondary" onclick={() => {}}>Copy position</button>
        <button type="button" class="secondary" aria-expanded={settingUp} onclick={openSetUp} bind:this={setupButton}>Set up a position</button>
        <ThreatButton />
      </div>
      {#if settingUp}
        <form class="card setup" aria-label="Set up a position" onsubmit={(e) => { e.preventDefault(); void submitSetUp(); }}>
          <label for="setup-text">Paste a FEN for one position, or a PGN to step through its moves.</label>
          <textarea id="setup-text" rows="3" bind:value={setupText} bind:this={setupBox} spellcheck="false" placeholder={'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1\nor 1. e4 e5 2. Nf3 …'}></textarea>
          {#if setupError}<p class="error" role="alert">{setupError}</p>{/if}
          <div class="actions">
            <button type="submit">Set up</button>
            <button type="button" class="secondary" onclick={closeSetUp}>Cancel</button>
          </div>
        </form>
      {/if}
      <p class="visually-hidden" role="status">{setupNote}</p>
      <p class="result" role="status" aria-label="Result">{result}</p>
    </div>
    <div class="side">
      <MoveList moves={line.moves} {grades} cursor={line.cursor} ongoto={(c) => line.goTo(c)} />
      <button type="button" class="secondary" aria-pressed={showLines} onclick={() => (showLines = !showLines)}>
        {showLines ? 'Hide Engine lines' : 'Show Engine lines'}
      </button>
      {#if showLines}<EngineLines {analysis} fen={line.fen} />{/if}
      <CoachPanel thread={coach} onwhy={why} />
    </div>
  </div>
</section>

<style>
  .result { margin: 0.5rem 0 0; text-align: center; font-weight: 600; }
  .result:empty { margin: 0; }
  .setup { display: grid; gap: 0.5rem; margin-top: 0.6rem; }
  .setup label { font-size: 0.9rem; }
  .setup textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  /* A FEN in the message has no spaces to wrap at on a phone. */
  .setup .error { margin: 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .setup .actions { display: flex; gap: 0.5rem; }
</style>
