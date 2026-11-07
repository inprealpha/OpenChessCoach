<script lang="ts">
  // An Engine Game: the Player picks a colour and the Engine's strength, and plays. Live Coaching
  // speaks up only on a Mistake or Blunder, and the Player may then take the move back. Hint gives
  // the idea first and the Engine's move second. The game in progress survives a reload. During
  // play the steps look back at earlier positions while the game waits at its latest, and a move
  // there starts the Player's own line, which shows no Move Grades or Winning Chances until they
  // press Analyze. Once the game is over its board is free: a move on it starts a variation. Back
  // to the game drops either.
  import { tick } from 'svelte';
  import { candidatesFrom, type GradedMove } from '@chess-coach/shared/analysis';
  import { otherSide, outcomeOfLine, SIDE_NAMES, turnOf, type PlayedMove, type Side } from '@chess-coach/shared/chess';
  import type { Analysis, Score } from '@chess-coach/shared/engine';
  import { GRADE_THRESHOLDS, MATERIAL_FLOOR_CP, negateScore, scoreToCp, winningChances, type MoveGrade } from '@chess-coach/shared/grader';
  import type { EngineGameRecord } from '@chess-coach/shared/protocol';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import MenuButton from '../components/MenuButton.svelte';
  import GameEnd from '../components/GameEnd.svelte';
  import MoveList from '../components/MoveList.svelte';
  import StepButtons from '../components/StepButtons.svelte';
  import SheetHandle from '../components/SheetHandle.svelte';
  import SheetStrip from '../components/SheetStrip.svelte';
  import { sheet } from '../lib/sheet.svelte.ts';
  import ThreatButton from '../components/ThreatButton.svelte';
  import FlipButton from '../components/FlipButton.svelte';
  import ThumbBar from '../components/ThumbBar.svelte';
  import VariationBar from '../components/VariationBar.svelte';
  import WinningChancesBar from '../components/WinningChancesBar.svelte';
  import { api } from '../lib/api.svelte.ts';
  import { punishingArrow, threatArrows, type BoardArrow } from '../lib/arrows.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { analyse, analyseForCoach, bestMove, gradeMove, threat } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { gradeMark } from '../lib/grades.ts';
  import { LookBack, positionName } from '../lib/look-back.svelte.ts';
  import { saveFinishedEngineGame } from '../lib/offline.ts';
  import { scoreFromAnalysis } from '../lib/position-score.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { randomId } from '../lib/random-id.ts';
  import { router } from '../lib/router.svelte.ts';
  import { store } from '../lib/storage.ts';
  import { threatSetting, ThreatView } from '../lib/threat.svelte.ts';
  import { stepLine, Variation, type Step } from '../lib/variation.svelte.ts';

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
  /**
   * The Coach on the Player's own line, a thread of its own: what it says about a line the game never
   * played stays out of the game's thread and its briefs (ADR 0009), and an answer still on its way
   * when the Player leaves the line is dropped with it.
   */
  const lineCoach = new CoachThread();
  /** The Player's own moves from a position of the game, graded by the browser's Engine (during play, once they press Analyze). */
  const variation = new Variation();
  /** During play, the earlier position the Player is looking at; the game stays at its latest. */
  const look = new LookBack(line);
  let game = $state<Saved | null>(null);
  let loaded = $state(false);
  let side = $state<Side>('white');
  let strength = $state(2);
  /** Whether the Player picked a strength; until then it follows their level, "at your strength". */
  let strengthPicked = false;
  $effect(() => {
    const level = profile.player.level;
    if (!strengthPicked) strength = level === 'beginner' ? 1 : level === 'club' ? 3 : 2;
  });
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
  /** The ⋯ Game menu, which gets the focus back once a question its items asked is answered. */
  let gameMenu = $state<ReturnType<typeof MenuButton>>();
  let endActions = $state<HTMLDivElement>();
  let setupForm = $state<HTMLFormElement>();
  let screen = $state<HTMLElement>();

  const finished = $derived(Boolean(game?.result));
  /** The Player turned the board; the Winning Chances bar turns with it. */
  let flipped = $state(false);
  const orientation = $derived<Side>(game ? (flipped ? otherSide(game.playerSide) : game.playerSide) : 'white');
  const playerToMove = $derived(game !== null && !finished && !thinking && !awaitingChoice && turnOf(line.fen) === game.playerSide);
  /** Away from the game's latest position during play: looking back, or trying the Player's own line from there. */
  const away = $derived(!finished && (look.active || variation.active));
  /** The Player's own line before Analyze: it shows no Move Grades or Winning Chances, and the Engine searches only for the game. */
  const unanalyzed = $derived(variation.active && !variation.analyzed);
  /** How far the game's moves are shown: a finished game's step, or during play the position looked at. */
  const gameCursor = $derived(finished ? line.cursor : look.cursor);
  /** The position on the board: the game's, the one looked back at, or the Player's own line. */
  const boardFen = $derived(variation.active ? variation.fen : look.active ? look.fen : line.fen);
  const shownLast = $derived(variation.active ? variation.line.lastMove : look.active ? look.lastMove : line.lastMove);
  /** Why the board takes no move while the game is on, in one line beside it. Away from the latest position every move is the Player's own line. */
  const refusal = $derived(away ? '' : thinking ? 'It’s the Engine’s move.' : awaitingChoice ? 'Take the move back or carry on first.' : '');
  /** Where the Player's own line branches from the game, in words: "after 8. Bb3", or "from the start". */
  const lineFrom = $derived(variation.from ? `after ${positionName(line.moves, variation.from)}` : 'from the start');
  /** The position the Coach last explained on the Player's own line: Analyze asks once per position. */
  let explained = $state<string | null>(null);
  /** The Coach panel's thread: the line's own while the board shows the Player's own line during play. */
  const shownCoach = $derived(away && variation.active ? lineCoach : coach);
  /** Analyze is offered until the line is graded and the Coach has explained the position shown. */
  const analyzeOffered = $derived(variation.active && (!variation.analyzed || (api.coachReady && explained !== variation.fen)));
  // The Player's last graded move keeps its symbol through the Engine's reply, unless the reply
  // landed on that square. Stepping through the game's moves, this follows the step shown.
  const mark = $derived.by(() => {
    if (!game) return undefined;
    const moves = line.moves.slice(0, gameCursor);
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
  // The Blunder pause draws the move that punishes the Player's move: the Engine's best reply in
  // the position on the board, from the same search the bar shows (ADR 0007), so it costs nothing.
  const punishing = $derived.by(() => {
    if (!awaitingChoice || !game || !analysis || analysis.fen !== line.fen) return [];
    const reply = candidatesFrom(analysis)[0];
    return punishingArrow(reply?.uci, reply?.san, otherSide(game.playerSide));
  });
  /** The Engine's best move on the Player's own line once it is analyzed, in green, from the search the bar shows. */
  const bestOnLine = $derived.by((): BoardArrow[] => {
    if (!variation.active || !variation.analyzed || analysis?.fen !== boardFen) return [];
    const best = candidatesFrom(analysis)[0];
    return best ? [{ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), kind: 'best', label: `Engine’s best: ${best.san}` }] : [];
  });
  // Hint, Coach and threat arrows are about the position to play from: away from it, and once the
  // game is over, the board shows none of them.
  const arrows = $derived(away ? bestOnLine : finished ? [] : [...threatArrows(threats.threat), ...punishing, ...coach.arrows, ...(hintArrow ? [hintArrow] : [])]);

  $effect(() => {
    threats.follow(threatSetting.on && playerToMove && !away ? line.fen : null);
  });

  /** The browser Engine's analysis of the position on the board, for the Winning Chances bar (ADR 0007). */
  let analysis = $state<Analysis | null>(null);
  // A drawn game reads level: a repetition or an agreed draw is one the position alone doesn't show.
  const position = $derived(game?.result === '1/2-1/2' && !variation.active ? { score: { cp: 0 }, pov: turnOf(line.fen) } : scoreFromAnalysis(boardFen, analysis));
  $effect(() => {
    // The Player's own line waits for Analyze, so its positions never queue ahead of the Engine's reply.
    if (!game || unanalyzed) return;
    const fen = boardFen;
    // The same cached analysis grades the moves either side of this position, so it costs no extra
    // search: after the Player's move it is the very search that grades it, which the Engine's
    // reply waits for anyway, so the bar needs no wait of its own.
    void analyse(fen, (partial) => {
      if (boardFen === fen) analysis = partial;
    }).then((a) => {
      if (boardFen === fen) analysis = a;
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
    backToGame();
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

  /** Shows the position after `cursor` of the game's moves: a finished game's step, or during play a look back. */
  function showGameAt(cursor: number): void {
    if (finished) line.goTo(cursor);
    else look.goTo(cursor);
  }

  /**
   * A move on a board that shows an earlier position, or a finished game's: the game's own next
   * move steps to it; any other starts the Player's own line from the position shown, or carries on
   * the one shown. During play the line waits for Analyze before it is graded.
   */
  function explore(uci: string): void {
    const to = variation.gameStep(uci, line.moves, gameCursor);
    if (to !== null) {
      leaveLine();
      showGameAt(to);
    } else variation.play(uci, { cursor: gameCursor, fen: finished ? line.fen : look.fen, analyzeLater: !finished });
  }

  /** Steps through the Player's own line while the board shows one, otherwise through the game's moves. */
  function step(where: Step): void {
    if (awaitingChoice) return;
    if (variation.active) stepLine(variation.line, where);
    else if (finished) stepLine(line, where);
    else look.step(where);
  }

  /** A move picked in the move list: the board leaves the Player's own line for it. The take-back choice keeps the board on the move it is about. */
  function pickMove(cursor: number): void {
    if (awaitingChoice) return;
    leaveLine();
    showGameAt(cursor);
  }

  /** Drops the Player's own line, with what the Coach said about it, an answer still on its way included. */
  function leaveLine(): void {
    lineCoach.reset();
    explained = null;
    variation.leave();
  }

  /** Back to the game: the board shows the game's latest position, where its next move is played. */
  function backToGame(): void {
    leaveLine();
    look.leave();
  }

  /**
   * The game's status card at the panel's top, from its first line: a phone's short panel may be
   * scrolled past it, to a move looked back at, when the game ends or asks for a choice.
   */
  async function statusInView(): Promise<void> {
    await tick();
    const card = screen?.querySelector<HTMLElement>('.game-status');
    const panel = card?.closest<HTMLElement>('.panel-body');
    if (card && panel) panel.scrollTop += card.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  }

  /** The bar's Back to the game, which goes with the bar: the game's status in view, and the focus on the board, where the next move is played. */
  async function backFromBar(): Promise<void> {
    backToGame();
    await statusInView();
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost) screen?.querySelector<HTMLElement>('.board')?.focus({ preventScroll: true });
  }

  /**
   * Analyze on the Player's own line during play: the browser Engine grades its moves and draws its
   * best move (ADR 0007), and the Coach answers one Why Question about the position shown, as in a
   * Review. Moving pieces on the line never calls the Coach; only this does.
   */
  async function analyze(): Promise<void> {
    if (!game || !variation.active || lineCoach.busy) return;
    variation.analyze();
    if (!api.coachReady || explained === variation.fen) return;
    explained = variation.fen;
    const { label, ...asked } = variation.question(line.moves);
    await lineCoach.ask({ job: 'why', ...asked, playerSide: game.playerSide }, label);
  }

  async function onmove(uci: string): Promise<void> {
    if (finished || away) return explore(uci);
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
      // The choice is about the move just played: a look back taken while it was graded ends, so the
      // board shows that move and the choice is at the top of the panel, in its first screen.
      const wasAway = away;
      backToGame();
      awaitingChoice = true;
      if (wasAway) void statusInView();
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
    // The Player has another look from the position before the move, wherever they were looking.
    backToGame();
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
    // The finished game's card says how it went: the Coach's lines from during play go, and so do a
    // look back and a line of the Player's own. The one time the board doesn't stay where the Player
    // is looking: when the Engine's reply ends the game, it shows the final position the card is about.
    backToGame();
    coach.reset();
    await persist();
    await save(recordOf(game));
    // Resign and an agreed draw take away the button that ended the game: carry on from the card's
    // first action, Review this game (or New game while the game waits on this device).
    await statusInView();
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost) endActions?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
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
    gameMenu?.focus();
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
    gameMenu?.focus();
  }

  async function newGame(): Promise<void> {
    game = null;
    flipped = false;
    saved = null;
    confirmingResign = false;
    confirmingNewGame = false;
    notice = '';
    backToGame();
    coach.reset();
    clearHint();
    line.reset();
    await store.del(KEY);
    // The button that started over is gone with the game: carry on from the form's first control.
    await tick();
    setupForm?.querySelector<HTMLElement>('input:checked')?.focus();
  }

  async function hint(): Promise<void> {
    if (!game || !playerToMove || away || hinting) return;
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

<section class="screen board-screen engine-game" class:sheet-full={sheet.shown} bind:this={screen}>
  <header class="frame-head">
    <h1>Engine Game</h1>
    {#if game}
      <p class="head-line">You play {SIDE_NAMES[game.playerSide]} · Engine strength: {LEVELS.find((l) => l.value === game?.strength)?.name}</p>
      <div class="frame-tools">
        {#if finished && variation.active}<VariationBar place="header" back="Back to the game" onback={leaveLine} />{/if}
        <!-- Hint and Show threat are about the position to play from, so they go while the Player looks away from it. -->
        {#if !finished && !away}
          <button
            type="button"
            class="secondary"
            onclick={hint}
            disabled={!playerToMove || coach.busy}
            title={awaitingChoice ? 'Hint comes back once you’ve decided on the take-back' : undefined}>{hintLevel === 0 ? 'Hint' : 'Show the move'}</button
          >
          <ThreatButton view={threats} />
        {/if}
        <FlipButton onflip={() => (flipped = !flipped)} />
        {#if !finished}
          <!-- What ends or abandons the game sits behind a menu, away from Hint; each still asks first. -->
          <MenuButton text="⋯ Game" label="Game options" bind:this={gameMenu}>
            <button type="button" role="menuitem" onclick={offerDraw} disabled={thinking || awaitingChoice}>Offer a draw</button>
            <button type="button" role="menuitem" class="danger" onclick={askResign}>Resign</button>
            <button type="button" role="menuitem" onclick={askNewGame}>New game</button>
          </MenuButton>
        {/if}
      </div>
    {/if}
  </header>
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
          <label><input type="radio" bind:group={strength} value={l.value} onchange={() => (strengthPicked = true)} /> {l.name}</label>
        {/each}
      </fieldset>
      <button type="submit">Start the Engine Game</button>
    </form>
  {:else}
    <div class="board-layout">
      <div class="board-col">
        <div class="board-and-bar">
          <SheetStrip />
          <div class="with-bar">
            <WinningChancesBar score={unanalyzed ? null : (position?.score ?? null)} pov={position?.pov ?? 'white'} {orientation} waiting={unanalyzed ? 'press Analyze to see them' : undefined} />
            <Board
              fen={boardFen}
              {orientation}
              movable={finished || away ? 'both' : playerToMove ? game.playerSide : 'none'}
              lastMove={shownLast ? { from: shownLast.uci.slice(0, 2), to: shownLast.uci.slice(2, 4) } : undefined}
              {arrows}
              highlights={away ? [] : coach.highlights}
              gradeMark={variation.active ? variation.mark : mark}
              {onmove}
              {refusal}
              label="Engine Game board"
            />
          </div>
        </div>
      </div>
      <div class="side panel">
        <SheetHandle />
        {#if finished && variation.active}<VariationBar place="panel" back="Back to the game" onback={leaveLine} />{/if}
        {#if away}
          <!-- At the panel's top while the board is away from the game's latest position, at every
               size: what the board shows, what the Engine played meanwhile where there is room, and
               the way back. The game waits at its latest position for the Player's move. -->
          <div class="away-bar" role="group" aria-label="Away from the game">
            <p>
              {#if variation.active}
                <strong>Your own line</strong><span class="roomy">{` ${lineFrom}`}</span>
              {:else}
                <strong>Looking at {look.where}</strong>{#if look.playedSince}<span class="roomy muted">{` · The Engine has played ${look.playedSince}`}</span>{/if}
              {/if}
            </p>
            <div class="away-actions">
              {#if analyzeOffered}<button type="button" class="secondary" onclick={analyze} disabled={lineCoach.busy}>Analyze</button>{/if}
              <button type="button" onclick={backFromBar}>Back to the game</button>
            </div>
          </div>
        {/if}
        <div class="panel-body" {@attach sheet.gestures}>
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
          <div class="card game-status" class:ended={finished} data-outcome={game.result ? outcomeOf(game) : undefined}>
            <div class="live" role="status" aria-live="polite" aria-label="Game status">
              {#if game.result}
                <GameEnd headline={resultText(game)} moves={Math.ceil(game.moves.length / 2)} grades={game.grades} />
              {:else if thinking}
                <p>The Engine is thinking…</p>
              {:else if awaitingChoice}
                <p>Take the move back, or carry on?</p>
                <!-- First in the panel, so on a phone the choice and its reason show right under the board. -->
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
            </div>
            {#if game.result}
              <!-- On the card but outside the status region, so a screen reader reads the result and the
                   summary once, and not the whole card again when the Review link arrives. -->
              <div class="end-actions" bind:this={endActions}>
                {#if saved === 'queued'}
                  <p class="muted queued">Saved on this device.</p>
                {:else if saved}
                  <a class="button" href={`#/review/${saved.id}`}>Review this game</a>
                {/if}
                <button type="button" class="secondary" onclick={askNewGame}>New game</button>
              </div>
            {/if}
          </div>
          {#if !finished && !away}
            <label class="toggle"><input type="checkbox" checked={game.live} onchange={toggleLive} /> Live Coaching in this game</label>
          {/if}
          <!-- At the game's latest position the panel stays on the game's status: its choice to take a
               move back above all during play, and once it is over the end-of-game card, whole, also
               when the finished game is reopened. Steps away from it keep their move in view. -->
          <MoveList
            followInPanel={away || (finished && (variation.active || line.cursor < line.moves.length))}
            moves={line.moves}
            grades={game.grades}
            cursor={gameCursor}
            ongoto={awaitingChoice ? undefined : pickMove}
            variation={variation.active
              ? { from: variation.from ?? 0, moves: variation.line.moves, grades: variation.grades, cursor: variation.line.cursor, ongoto: (c) => variation.line.goTo(c) }
              : undefined}
          />
        </div>
        <!-- Docked at the panel's foot, as beside every other board, with the step buttons either
             side. Away from the latest position Hint is gone, so the panel doesn't suggest it. The
             Blunder pause takes the steps' row, so the choice and its reason stay in a phone's first
             screen. Once the game is over the Coach's lines are gone and the thumb bar keeps the steps. -->
        {#snippet steps(part: 'back' | 'on')}
          <StepButtons only={part} onfirst={() => step('first')} onprevious={() => step('previous')} onnext={() => step('next')} onlast={() => step('last')} />
        {/snippet}
        {#if !finished}
          <CoachPanel
            thread={shownCoach}
            empty={away ? undefined : game.live
              ? 'The Coach speaks up when a move is a Mistake or Blunder. Press Hint for a nudge.'
              : 'Live Coaching is off in this game. Press Hint for a nudge.'}
            steps={awaitingChoice ? undefined : steps}
          />
        {:else}
          <ThumbBar {steps} />
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .setup { display: flex; flex-direction: column; gap: 0.7rem; max-width: 420px; }
  fieldset { display: flex; flex-wrap: wrap; gap: 0.8rem; border: 1px solid var(--line); border-radius: 8px; }
  .toggle { display: flex; gap: 0.4rem; align-items: center; }
  .game-status, .game-status > .live { display: flex; flex-direction: column; gap: 0.45rem; }
  .game-status p { margin: 0; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  /* The end-of-game card: a band in the colour of how it went, the colours of the Move Grades. */
  .game-status.ended { border-left: 6px solid var(--outcome); }
  .game-status.ended, .game-status.ended > .live { gap: 0.55rem; }
  .end-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.3rem; }
  /* While the game waits on this device, the note takes Review this game's place beside New game,
     so the card is no taller than when it is saved. */
  .end-actions:has(.queued) { flex-wrap: nowrap; }
  .end-actions > :is(button, .button) { flex: none; white-space: nowrap; }
  .queued { flex: 1 1 auto; min-width: 0; font-size: 0.85rem; line-height: 1.3; }
  .button {
    display: inline-block; background: var(--accent); color: var(--accent-text); border-radius: 8px;
    padding: 0.55rem 1.1rem; text-decoration: none; font-weight: 600;
  }
  .button:hover { filter: brightness(1.08); }
  .game-status[data-outcome='won'] { --outcome: #145c26; }
  .game-status[data-outcome='drawn'] { --outcome: #7a5a00; }
  .game-status[data-outcome='lost'] { --outcome: #7b8088; }
  /* The bar at the panel's top while the board is away from the game's latest position. */
  .away-bar {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem 0.6rem;
    padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  }
  .away-bar p { margin: 0; }
  .away-actions { display: flex; gap: 0.4rem; }
  @media (max-width: 820px) {
    /* One row on a phone: the words give way to the buttons, and what needs room waits for a wider screen. */
    .away-bar { flex-wrap: nowrap; padding: 0.3rem 0.5rem; }
    .away-bar p { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .away-actions { flex: none; }
    .roomy { display: none; }
    /* The end-of-game card whole in the first screen, down to a 390×664 iPhone in Safari, with room
       to spare when a wider font wraps the result and the summary onto two lines each: its lines
       closer together, and on a short phone the board smaller. Tap targets keep their size. */
    .engine-game:has(.game-status.ended) { --phone-reserve: 22rem; }
    .game-status.ended, .game-status.ended > .live { gap: 0.35rem; }
    .game-status.ended .end-actions { margin-top: 0.2rem; }
  }
</style>
