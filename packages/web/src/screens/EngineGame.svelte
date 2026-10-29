<script lang="ts">
  // An Engine Game: the Player picks a colour and the Engine's strength, and plays. Live Coaching
  // speaks up only on a Mistake or Blunder, and the Player may then take the move back. Hint gives
  // the idea first and the Engine's move second. The game in progress survives a reload.
  import { tick } from 'svelte';
  import { candidatesFrom, type GradedMove } from '@chess-coach/shared/analysis';
  import { outcomeOfLine, SIDE_NAMES, turnOf, type PlayedMove, type Side } from '@chess-coach/shared/chess';
  import type { Analysis, Score } from '@chess-coach/shared/engine';
  import { GRADE_THRESHOLDS, MATERIAL_FLOOR_CP, negateScore, scoreToCp, winningChances, type MoveGrade } from '@chess-coach/shared/grader';
  import type { EngineGameRecord } from '@chess-coach/shared/protocol';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import GameEnd from '../components/GameEnd.svelte';
  import MoveList from '../components/MoveList.svelte';
  import StepButtons from '../components/StepButtons.svelte';
  import ThreatButton from '../components/ThreatButton.svelte';
  import WinningChancesBar from '../components/WinningChancesBar.svelte';
  import { api } from '../lib/api.svelte.ts';
  import { threatArrows } from '../lib/arrows.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { analyse, analyseForCoach, bestMove, gradeMove, threat } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { gradeMark } from '../lib/grades.ts';
  import { saveFinishedEngineGame } from '../lib/offline.ts';
  import { scoreFromAnalysis } from '../lib/position-score.ts';
  import { randomId } from '../lib/random-id.ts';
  import { router } from '../lib/router.svelte.ts';
  import { store } from '../lib/storage.ts';
  import { threatSetting, ThreatView } from '../lib/threat.svelte.ts';

  /** Strength levels, mapped to Stockfish's Skill Level and a short search. */
  const LEVELS = [
    { value: 1, name: 'Beginner', skill: 0, depth: 4 },
    { value: 2, name: 'Casual', skill: 5, depth: 6 },
    { value: 3, name: 'Club', skill: 12, depth: 9 },
    { value: 4, name: 'Strong', skill: 20, depth: 12 },
  ] as const;

  interface Saved {
    clientId: string;
    playerSide: Side;
    strength: number;
    moves: string[];
    grades: (MoveGrade | undefined)[];
    live: boolean;
    /** Live Coaching's takeback offer on the last move, while the Player has not yet answered it. */
    offer?: { san: string; grade: MoveGrade; comment?: string };
    startedAt: string;
    result?: EngineGameRecord['result'];
    termination?: string;
    finishedAt?: string;
    /** Where the finished game was saved: in the game list, or on this device until the desktop is back. */
    saved?: { id: number } | 'queued';
  }

  const KEY = 'engineGame';
  const line = new Line();
  const coach = new CoachThread();

  let game = $state<Saved | null>(null);
  let loaded = $state(false);
  let side = $state<Side>('white');
  let strength = $state(2);
  let thinking = $state(false);
  let awaitingChoice = $state(false);
  let notice = $state('');
  let hintLevel = $state(0);
  let hintArrow = $state<{ from: string; to: string; brush: 'green' } | null>(null);
  /** The Engine's move once shown, so Show the move says it once per position. */
  let shownMove: { fen: string; arrow: { from: string; to: string; brush: 'green' } } | null = null;
  /** A Hint in flight: a second click while it is answered does nothing. */
  let hinting = false;
  let saved = $state<{ id: number } | 'queued' | null>(null);
  let resaving = false;
  let confirmingResign = $state(false);
  let confirmingNewGame = $state(false);
  let resignButton = $state<HTMLButtonElement>();
  let newGameButton = $state<HTMLButtonElement>();
  let endActions = $state<HTMLDivElement>();
  let setupForm = $state<HTMLFormElement>();

  const finished = $derived(Boolean(game?.result));
  const playerToMove = $derived(game !== null && !finished && !thinking && !awaitingChoice && turnOf(line.fen) === game.playerSide);
  // The Player's last graded move keeps its symbol through the Engine's reply, unless the reply
  // landed on that square. A finished game steps through its moves, so this follows the step shown.
  const mark = $derived.by(() => {
    if (!game) return undefined;
    const moves = line.moves.slice(0, line.cursor);
    for (let i = moves.length - 1; i >= Math.max(0, moves.length - 2); i--) {
      const m = moves[i] as PlayedMove;
      if (turnOf(m.fenBefore) !== game.playerSide) continue;
      const found = gradeMark(m, game.grades[i]);
      return found && moves.slice(i + 1).some((x) => x.uci.slice(2, 4) === found.square) ? undefined : found;
    }
    return undefined;
  });
  // The Engine's threat, shown while it's the Player's move: finding it is a search of its own
  // (the opponent's move as if they could move again), which would queue ahead of the Engine's reply.
  const threats = new ThreatView(threat);
  // A finished game's board shows only the final position: no Hint, Coach or threat arrows left over.
  const arrows = $derived(finished ? [] : [...threatArrows(threats.threat), ...coach.arrows, ...(hintArrow ? [hintArrow] : [])]);

  $effect(() => {
    threats.follow(threatSetting.on && playerToMove ? line.fen : null);
  });

  /** The browser Engine's analysis of the position on the board, for the Winning Chances bar (ADR 0007). */
  let analysis = $state<Analysis | null>(null);
  // A drawn game reads level: a repetition or an agreed draw is one the position alone doesn't show.
  const position = $derived(game?.result === '1/2-1/2' ? { score: { cp: 0 }, pov: turnOf(line.fen) } : scoreFromAnalysis(line.fen, analysis));
  $effect(() => {
    if (!game) return;
    const fen = line.fen;
    // The same cached analysis grades the moves either side of this position, so it costs no extra
    // search: after the Player's move it is the very search that grades it, which the Engine's
    // reply waits for anyway, so the bar needs no wait of its own.
    void analyse(fen, (partial) => {
      if (line.fen === fen) analysis = partial;
    }).then((a) => {
      if (line.fen === fen) analysis = a;
    });
  });

  $effect(() => {
    void restore();
  });

  // A finished game that only this device holds (the desktop was away, or a reload came before
  // the desktop answered) is sent again once the desktop is reachable. The desktop knows an Engine
  // Game by its id, so it is never saved twice, and the answer brings the Review link back.
  $effect(() => {
    if (api.state === 'online' && game?.result && saved === 'queued') void resave();
  });

  // Back or Forward to the Engine Game puts back the Player's place once the game on this device is read.
  const contentShown = router.loadsLater();
  $effect(() => {
    if (loaded) contentShown();
  });

  async function restore(): Promise<void> {
    const g = await store.get<Saved>(KEY);
    if (g) {
      game = g;
      line.reset(undefined, g.moves);
      if (g.result) saved = g.saved ?? 'queued';
      else if (g.offer) {
        // The Player had not answered the takeback offer: show it again and wait for their choice.
        awaitingChoice = true;
        coach.say(g.offer.comment ?? `${g.offer.san} is graded ${g.offer.grade}.`);
      } else {
        const last = line.moves.at(-1);
        // A reload while the Player's last move was being graded: grade it again, then the game ends there or the Engine replies.
        if (last && !g.grades[line.moves.length - 1] && turnOf(last.fenBefore) === g.playerSide) void respond(line.moves.length, last);
        // Over on the board but not saved as over (the app closed in between): end it, rather than ask the Engine for a move.
        else if (outcomeOfLine(line.startFen, line.moves)) void checkEnd();
        else if (turnOf(line.fen) !== g.playerSide) void engineMove();
      }
    }
    loaded = true;
  }

  async function resave(): Promise<void> {
    if (!game?.result || resaving) return;
    resaving = true;
    try {
      await save(recordOf(game));
    } finally {
      resaving = false;
    }
  }

  async function persist(): Promise<void> {
    if (game) await store.set(KEY, $state.snapshot(game));
  }

  async function startGame(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    let live = true;
    if (api.state === 'online') {
      try {
        live = (await api.request('settings.get', {})).liveCoachingDefault;
      } catch {
        // keep the default
      }
    }
    game = { clientId: randomId(), playerSide: side, strength, moves: [], grades: [], live, startedAt: new Date().toISOString() };
    line.reset();
    coach.reset();
    saved = null;
    notice = '';
    awaitingChoice = false;
    clearHint();
    await persist();
    if (side === 'black') await engineMove();
  }

  function clearHint(): void {
    hintLevel = 0;
    hintArrow = null;
    shownMove = null;
  }

  async function onmove(uci: string): Promise<void> {
    if (!game || !playerToMove) return;
    const ply = line.moves.length + 1;
    const m = line.play(uci);
    if (!m) return;
    clearHint();
    coach.clearAnnotations();
    notice = '';
    game.moves = line.moves.map((x) => x.uci);
    await persist();
    await respond(ply, m);
  }

  /** After the Player's move: the game ends there, or Live Coaching or the Engine answers it. Either way the move gets its Move Grade. */
  async function respond(ply: number, m: PlayedMove): Promise<void> {
    if (!outcomeOfLine(line.startFen, line.moves)) return gradeAndRespond(ply, m);
    await grade(ply, m);
    await checkEnd();
  }

  /** Every move the Player makes gets its Move Grade, from the browser's Engine. */
  async function grade(ply: number, m: PlayedMove): Promise<GradedMove> {
    thinking = true;
    try {
      // With the moves before it, so a move that repeats a position a third time is graded as a draw.
      const g = await gradeMove(ply, m.fenBefore, m.uci, m.fenAfter, { startFen: line.startFen, moves: line.moves.slice(0, ply - 1) });
      if (game) game.grades[ply - 1] = g.grade;
      return g;
    } finally {
      thinking = false;
    }
  }

  /** Grades the Player's move, offers Live Coaching's takeback on a Mistake or Blunder, or lets the Engine reply. */
  async function gradeAndRespond(ply: number, m: PlayedMove): Promise<void> {
    if (!game) return;
    // Live Coaching only decides whether the Coach speaks.
    const g = await grade(ply, m);
    if (!game) return;
    const offer = (g.grade === 'Mistake' || g.grade === 'Blunder') && game.live && api.coachReady;
    // The takeback offer is saved with the game, so a reload shows it again instead of letting the Engine reply.
    if (offer) game.offer = { san: m.san, grade: g.grade };
    await persist();
    if (offer) {
      awaitingChoice = true;
      // The browser's Move Grade triggers Live Coaching; the desktop's Engine supplies the facts (ADR 0007).
      const reply = await coach.ask({
        job: 'live',
        fen: m.fenBefore,
        recentMoves: line.moves.slice(0, ply - 1).map((x) => x.san),
        playerSide: game.playerSide,
        moveUci: g.uci,
      });
      if (reply && game.offer) {
        game.offer.comment = reply.text;
        await persist();
      }
      return;
    }
    await engineMove();
  }

  async function takeBack(): Promise<void> {
    if (!game || !awaitingChoice) return;
    line.takeBack(1);
    game.moves = line.moves.map((x) => x.uci);
    game.grades = game.grades.slice(0, line.moves.length);
    delete game.offer;
    awaitingChoice = false;
    coach.clearAnnotations();
    coach.say('Move taken back. Have another look.');
    await persist();
  }

  async function carryOn(): Promise<void> {
    if (!game || !awaitingChoice) return;
    delete game.offer;
    awaitingChoice = false;
    coach.clearAnnotations();
    await persist();
    await engineMove();
  }

  async function engineMove(): Promise<void> {
    if (!game || game.result) return;
    const level = LEVELS.find((l) => l.value === game?.strength) ?? LEVELS[1];
    thinking = true;
    try {
      // Skill Level picks moves at random, so verify mode plays full strength at the level's depth.
      // The game's moves let the Engine see repetitions, so it never draws by one when it is better.
      const history = { startFen: line.startFen, moves: line.moves.map((m) => m.uci) };
      const uci = await bestMove(line.fen, { skill: api.engine.singleThread ? 20 : level.skill, depth: level.depth, history });
      if (!game || game.result) return;
      line.play(uci);
      game.moves = line.moves.map((x) => x.uci);
      await persist();
      await checkEnd();
    } finally {
      thinking = false;
    }
  }

  async function checkEnd(): Promise<boolean> {
    const o = outcomeOfLine(line.startFen, line.moves);
    if (!o) return false;
    const result = o.winner === 'white' ? '1-0' : o.winner === 'black' ? '0-1' : '1/2-1/2';
    const why: Record<string, string> = {
      checkmate: 'checkmate',
      stalemate: 'stalemate',
      insufficient: 'insufficient material',
      draw: 'the fifty-move rule',
      repetition: 'threefold repetition',
    };
    await finish(result, why[o.reason] ?? o.reason);
    return true;
  }

  async function finish(result: EngineGameRecord['result'], termination: string): Promise<void> {
    if (!game) return;
    game.result = result;
    game.termination = termination;
    game.finishedAt = new Date().toISOString();
    delete game.offer;
    confirmingResign = false;
    awaitingChoice = false;
    notice = '';
    await persist();
    await save(recordOf(game));
    // Resign and an agreed draw take away the button that ended the game: carry on from the card's
    // first action, Review this game (or New game while the game waits on this device).
    await tick();
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost) endActions?.querySelector<HTMLElement>('a, button')?.focus();
  }

  /** The record the desktop saves for a finished game. */
  function recordOf(g: Saved): EngineGameRecord {
    return {
      clientId: g.clientId,
      playerSide: g.playerSide,
      strength: g.strength,
      moves: [...g.moves],
      result: g.result as EngineGameRecord['result'],
      termination: g.termination as string,
      startedAt: g.startedAt,
      // Older devices kept no finish time; their game was already sent with one, and the desktop keeps the first it gets.
      finishedAt: g.finishedAt ?? g.startedAt,
    };
  }

  /** Saves the finished game, and keeps where it went with the game, so a reload still offers its Review. */
  async function save(record: EngineGameRecord): Promise<void> {
    const where = await saveFinishedEngineGame(record);
    if (game?.clientId !== record.clientId) return;
    saved = game.saved = where === 'queued' ? where : { id: where.id };
    await persist();
  }

  /** Resign asks first (ConfirmDialog focuses Keep playing, so a stray Enter does not end the game). */
  function askResign(): void {
    if (!game || finished) return;
    confirmingNewGame = false;
    confirmingResign = true;
  }

  async function keepPlaying(): Promise<void> {
    confirmingResign = false;
    await tick();
    resignButton?.focus();
  }

  async function resign(): Promise<void> {
    if (!game || finished || !confirmingResign) return;
    confirmingResign = false;
    await finish(game.playerSide === 'white' ? '0-1' : '1-0', 'resignation');
  }

  async function offerDraw(): Promise<void> {
    if (!game || finished || thinking) return;
    thinking = true;
    try {
      const a = await analyse(line.fen);
      const top = a.lines[0];
      // The score is from the side to move; turn it to the Engine's view.
      const score = top ? (turnOf(line.fen) === game.playerSide ? negateScore(top.score) : top.score) : { cp: 0 };
      if (acceptsDraw(score, line.moves.length)) await finish('1/2-1/2', 'draw agreed');
      else notice = 'The Engine declines the draw.';
    } finally {
      thinking = false;
    }
  }

  /**
   * The Engine agrees a draw as a person would: when it is a piece or more behind (the Grader's
   * material floor) or facing mate, or from move 20 in a level game, where neither side is an
   * Inaccuracy's worth of winning chances ahead. A small edge in the opening is no reason to stop.
   */
  function acceptsDraw(engineScore: Score, plies: number): boolean {
    if (scoreToCp(engineScore) <= -MATERIAL_FLOOR_CP) return true;
    return plies >= 40 && Math.abs(winningChances(engineScore)) < GRADE_THRESHOLDS.Inaccuracy;
  }

  /** New game in the middle of a game asks first, like Resign; otherwise it starts over at once. */
  async function askNewGame(): Promise<void> {
    if (game && !game.result && line.moves.length) {
      confirmingResign = false;
      confirmingNewGame = true;
    } else await newGame();
  }

  async function cancelNewGame(): Promise<void> {
    confirmingNewGame = false;
    await tick();
    newGameButton?.focus();
  }

  async function newGame(): Promise<void> {
    game = null;
    saved = null;
    confirmingResign = false;
    confirmingNewGame = false;
    notice = '';
    coach.reset();
    clearHint();
    line.reset();
    await store.del(KEY);
    // The button that started over is gone with the game: carry on from the form's first control.
    await tick();
    setupForm?.querySelector<HTMLElement>('input:checked')?.focus();
  }

  async function hint(): Promise<void> {
    if (!game || !playerToMove || hinting) return;
    // Show the move once per position: another click brings the arrow back, with no new line.
    if (shownMove?.fen === line.fen) {
      hintArrow = shownMove.arrow;
      return;
    }
    hinting = true;
    hintLevel++;
    try {
      if (hintLevel === 1) {
        if (api.coachReady) {
          await coach.ask({ job: 'hint', fen: line.fen, recentMoves: line.sansUntilCursor(), playerSide: game.playerSide }, 'Hint, please.');
        } else coach.say('Hints need the Coach, which is unavailable. Press Hint again to see the Engine’s move.');
        return;
      }
      // From the desktop's Engine, like the facts behind the first Hint (ADR 0007).
      const fen = line.fen;
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
        coach.say(`The Engine’s move: ${candidatesFrom(a)[0]?.san ?? best}.`);
      }
    } finally {
      hinting = false;
    }
  }

  async function toggleLive(): Promise<void> {
    if (!game) return;
    game.live = !game.live;
    await persist();
  }

  function resultText(g: Saved): string {
    if (g.result === '1/2-1/2') return g.termination === 'draw agreed' ? 'Draw agreed.' : `Draw by ${g.termination}.`;
    return `${outcomeOf(g) === 'won' ? 'You won' : 'The Engine won'} by ${g.termination}.`;
  }

  /** How the game went for the Player, which colours the end-of-game card. */
  function outcomeOf(g: Saved): 'won' | 'lost' | 'drawn' {
    if (g.result === '1/2-1/2') return 'drawn';
    return (g.result === '1-0') === (g.playerSide === 'white') ? 'won' : 'lost';
  }
</script>

<section class="screen">
  <h1>Engine Game</h1>
  {#if !loaded}
    <p class="muted">Loading…</p>
  {:else if !game}
    <form class="card setup" onsubmit={startGame} aria-label="New Engine Game" bind:this={setupForm}>
      <fieldset>
        <legend>Your colour</legend>
        <label><input type="radio" bind:group={side} value="white" /> White</label>
        <label><input type="radio" bind:group={side} value="black" /> Black</label>
      </fieldset>
      <fieldset>
        <legend>The Engine’s strength</legend>
        {#each LEVELS as l (l.value)}
          <label><input type="radio" bind:group={strength} value={l.value} /> {l.name}</label>
        {/each}
      </fieldset>
      <button type="submit">Start the Engine Game</button>
    </form>
  {:else}
    <div class="board-layout">
      <div class="board-and-bar">
        <div class="with-bar">
          <WinningChancesBar score={position?.score ?? null} pov={position?.pov ?? 'white'} orientation={game.playerSide} />
          <Board
            fen={line.fen}
            orientation={game.playerSide}
            movable={playerToMove ? game.playerSide : 'none'}
            lastMove={line.lastMove ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) } : undefined}
            {arrows}
            highlights={coach.highlights}
            gradeMark={mark}
            {onmove}
            label="Engine Game board"
          />
        </div>
        <div class="toolbar">
          {#if finished}
            <!-- Only a finished game steps back: while it is on, the board shows the position to play from. -->
            <StepButtons onfirst={() => line.goTo(0)} onprevious={() => line.back()} onnext={() => line.forward()} onlast={() => line.goTo(line.moves.length)} />
          {:else}
            <button type="button" class="secondary" onclick={hint} disabled={!playerToMove || coach.busy}>{hintLevel === 0 ? 'Hint' : 'Show the move'}</button>
            <button type="button" class="secondary" onclick={offerDraw} disabled={thinking || awaitingChoice}>Offer a draw</button>
            <button type="button" class="secondary" onclick={askResign} aria-expanded={confirmingResign} bind:this={resignButton}>Resign</button>
          {/if}
          {#if !finished}
            <!-- Once the game is over, New game is on the end-of-game card. -->
            <button type="button" class="secondary" onclick={askNewGame} aria-expanded={confirmingNewGame} bind:this={newGameButton}>New game</button>
            <ThreatButton />
          {/if}
        </div>
        {#if confirmingResign && !finished}
          <ConfirmDialog
            id="resign"
            title="Resign this game?"
            detail="The Engine wins, and the game is saved as finished."
            keepLabel="Keep playing"
            confirmLabel="Yes, resign"
            onkeep={keepPlaying}
            onconfirm={resign}
          />
        {/if}
        {#if confirmingNewGame && !finished}
          <ConfirmDialog
            id="new-game"
            title="Abandon this game?"
            detail="It isn’t saved: only finished games go to your game list."
            keepLabel="Keep playing"
            confirmLabel="Yes, start a new game"
            onkeep={cancelNewGame}
            onconfirm={newGame}
          />
        {/if}
      </div>
      <div class="side">
        <div class="card game-status" class:ended={finished} data-outcome={game.result ? outcomeOf(game) : undefined}>
          <div class="live" role="status" aria-live="polite" aria-label="Game status">
            {#if game.result}
              <GameEnd
                headline={resultText(game)}
                moves={Math.ceil(game.moves.length / 2)}
                side={game.playerSide}
                level={LEVELS.find((l) => l.value === game?.strength)?.name ?? ''}
                grades={game.grades}
              />
            {:else if thinking}
              <p>The Engine is thinking…</p>
            {:else if awaitingChoice}
              <p>Take the move back, or carry on?</p>
              <!-- Here, right under the board, rather than in the Coach panel: on a phone that is below the fold. -->
              {#if !coach.busy}
                <div class="row">
                  <button type="button" onclick={takeBack}>Take the move back</button>
                  <button type="button" class="secondary" onclick={carryOn}>Carry on</button>
                </div>
              {/if}
            {:else}
              <p>Your move ({SIDE_NAMES[game.playerSide]}).</p>
            {/if}
            {#if notice}<p>{notice}</p>{/if}
            {#if !finished}<p class="muted small">Engine strength: {LEVELS.find((l) => l.value === game?.strength)?.name}</p>{/if}
          </div>
          {#if game.result}
            <!-- On the card but outside the status region, so a screen reader reads the result and the
                 tally once, and not the whole card again when the Review link arrives. -->
            <div class="end-actions" bind:this={endActions}>
              {#if saved === 'queued'}
                <p class="muted">Saved on this device. It goes to your game list when your desktop is reachable.</p>
              {:else if saved}
                <a class="button" href={`#/review/${saved.id}`}>Review this game</a>
              {/if}
              <button type="button" class="secondary" onclick={askNewGame}>New game</button>
            </div>
          {/if}
        </div>
        <!-- The Coach comes before the move list, as beside every other board. Once the game is over
             it stays only if it said something worth rereading. -->
        {#if !finished || coach.entries.length}
          <CoachPanel
            thread={coach}
            empty={game.live
              ? 'The Coach speaks up when a move is a Mistake or Blunder. Press Hint for a nudge.'
              : 'Live Coaching is off in this game. Press Hint for a nudge.'}
          />
        {/if}
        {#if !finished}
          <label class="toggle"><input type="checkbox" checked={game.live} onchange={toggleLive} /> Live Coaching in this game</label>
        {/if}
        <MoveList moves={line.moves} grades={game.grades} cursor={line.cursor} ongoto={finished ? (c) => line.goTo(c) : undefined} />
      </div>
    </div>
  {/if}
</section>

<style>
  .setup { display: flex; flex-direction: column; gap: 0.7rem; max-width: 420px; }
  fieldset { display: flex; flex-wrap: wrap; gap: 0.8rem; border: 1px solid var(--line); border-radius: 8px; }
  .toggle { display: flex; gap: 0.4rem; align-items: center; }
  .small { font-size: 0.8rem; }
  /* Five buttons, one of them "Show the move", fit one row under a full-size board. */
  .toolbar :global(button) { padding-inline: 0.7rem; }
  .game-status, .game-status > .live { display: flex; flex-direction: column; gap: 0.45rem; }
  .game-status p { margin: 0; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  /* The end-of-game card: a band in the colour of how it went, the colours of the Move Grades. */
  .game-status.ended { border-left: 6px solid var(--outcome); }
  .game-status.ended, .game-status.ended > .live { gap: 0.55rem; }
  .end-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.3rem; }
  .button {
    display: inline-block; background: var(--accent); color: var(--accent-text); border-radius: 8px;
    padding: 0.55rem 1.1rem; text-decoration: none; font-weight: 600;
  }
  .button:hover { filter: brightness(1.08); }
  .game-status[data-outcome='won'] { --outcome: #145c26; }
  .game-status[data-outcome='drawn'] { --outcome: #7a5a00; }
  .game-status[data-outcome='lost'] { --outcome: #7b8088; }
</style>
