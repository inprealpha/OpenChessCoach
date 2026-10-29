<script lang="ts">
  // Play it out: after an endgame Lesson the Player takes the Lesson's position against the Engine
  // at full strength and has to mate, or promote a pawn, on their own (ADR 0008).
  import { otherSide, outcomeOfLine, piecesOf, SIDE_NAMES, turnOf } from '@chess-coach/shared/chess';
  import type { LessonData, PlayOut } from '@chess-coach/shared/content/lessons';
  import Board from '../components/Board.svelte';
  import { loadLesson } from '../lib/content.ts';
  import { analyse, bestMove } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';

  let { lessonId }: { lessonId: string } = $props();

  /** The Engine at full strength, with a short search so it answers quickly. */
  const ENGINE = { skill: 20, depth: 12 } as const;

  let lesson = $state<LessonData | null>(null);
  let missing = $state(false);
  let status = $state<'playing' | 'won' | 'lost'>('playing');
  let message = $state('');
  let thinking = $state(false);
  let hintArrow = $state<{ from: string; to: string; brush: 'green' } | null>(null);
  const line = new Line();

  const playOut = $derived<PlayOut | undefined>(lesson?.playOut);
  const playerToMove = $derived(playOut !== undefined && status === 'playing' && !thinking && turnOf(line.fen) === playOut.side);
  /** The Player's own moves, as a scoresheet counts them: the Engine's replies don't add to it. */
  const playerMoves = $derived(line.moves.filter((m) => turnOf(m.fenBefore) === playOut?.side).length);

  $effect(() => {
    void load(lessonId);
  });

  async function load(id: string): Promise<void> {
    const data = await loadLesson(id);
    if (!data?.playOut) {
      missing = true;
      return;
    }
    lesson = data;
    await restart();
  }

  async function restart(): Promise<void> {
    if (!playOut) return;
    line.reset(playOut.fen);
    status = 'playing';
    message = playOut.goal === 'mate' ? `Checkmate the ${otherSide(playOut.side)} king.` : 'Promote your pawn.';
    hintArrow = null;
    if (turnOf(playOut.fen) !== playOut.side) await engineMove();
  }

  /** Whether the goal is reached, or can no longer be reached, after the last move. */
  function judge(): boolean {
    if (!playOut) return true;
    const last = line.lastMove;
    const outcome = outcomeOfLine(line.startFen, line.moves);
    if (outcome?.reason === 'checkmate' && outcome.winner === playOut.side) return finish('won', 'Checkmate. Well played!');
    if (playOut.goal === 'promote' && last && last.uci.length === 5 && turnOf(last.fenBefore) === playOut.side) return finish('won', `${last.san}: your pawn has promoted. Well played!`);
    // Before the draw: taking the last pawn also leaves too little to mate, and the pawn is the reason.
    const pawns = piecesOf(line.fen).filter((p) => p.role === 'pawn' && p.color === playOut.side);
    if (playOut.goal === 'promote' && pawns.length === 0) return finish('lost', 'Your pawn is gone, so it can no longer promote. Try again.');
    const drawn: Record<string, string> = {
      stalemate: 'Stalemate: the game is drawn. Try again.',
      insufficient: 'Neither side has enough pieces left to give checkmate, so the game is drawn. Try again.',
      repetition: 'The same position came up three times: the game is drawn. Try again.',
    };
    if (outcome) return finish('lost', drawn[outcome.reason] ?? 'The game is drawn. Try again.');
    return false;
  }

  function finish(result: 'won' | 'lost', text: string): true {
    status = result;
    message = text;
    return true;
  }

  async function onmove(uci: string): Promise<void> {
    if (!playerToMove) return;
    if (!line.play(uci)) return;
    hintArrow = null;
    if (judge()) return;
    await engineMove();
  }

  async function engineMove(): Promise<void> {
    thinking = true;
    try {
      const uci = await bestMove(line.fen, { ...ENGINE, history: { startFen: line.startFen, moves: line.moves.map((m) => m.uci) } });
      line.play(uci);
    } finally {
      thinking = false;
    }
    judge();
  }

  async function hint(): Promise<void> {
    if (!playerToMove) return;
    const best = (await analyse(line.fen)).lines[0]?.pv[0];
    if (best) hintArrow = { from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' };
  }
</script>

<section class="screen">
  {#if missing}
    <h1>Nothing to play out</h1>
    <p><a href="#/lessons">Back to the Lessons</a></p>
  {:else if !lesson || !playOut}
    <p class="muted">Loading…</p>
  {:else}
    <!-- As on the Lesson screens: the way back first, then the name, on one line where both fit. -->
    <div class="title">
      <a class="back" href="#/lessons"><span aria-hidden="true">←</span> Back to the Lessons</a>
      <h1>{lesson.name}: play it out</h1>
    </div>
    <div class="board-layout">
      <div>
        <Board
          fen={line.fen}
          orientation={playOut.side}
          movable={playerToMove ? playOut.side : 'none'}
          lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
          arrows={hintArrow ? [hintArrow] : []}
          {onmove}
          label="Play-out board"
        />
        <p class="muted center" aria-live="polite">{thinking ? 'The Engine is thinking…' : `${playerMoves} ${playerMoves === 1 ? 'move' : 'moves'} played`}</p>
      </div>
      <div class="side">
        <section class="card" aria-label="Play it out">
          <h2>{playOut.title}</h2>
          <p>You play {SIDE_NAMES[playOut.side]} against the Engine at full strength. Use what the Lesson showed you.</p>
          <p role="status" class:won={status === 'won'}>{message}</p>
          <div class="row">
            {#if status === 'playing'}
              <!-- The Engine's choice for the Player's own side, not its reply. -->
              <button type="button" class="secondary" onclick={hint} disabled={!playerToMove}>Show the best move</button>
            {/if}
            <button type="button" class={status === 'playing' ? 'secondary' : ''} onclick={restart} disabled={thinking}>Start again</button>
          </div>
        </section>
        <p><a href={`#/lesson/${lesson.id}`}>Back to the Lesson</a></p>
      </div>
    </div>
  {/if}
</section>

<style>
  .title { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.2rem 1rem; margin-bottom: 0.8rem; }
  .title h1 { margin: 0; }
  .back { order: 1; font-size: 0.9rem; }
  h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .center { text-align: center; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .won { font-weight: 700; }
</style>
