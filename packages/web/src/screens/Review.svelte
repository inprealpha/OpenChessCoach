<script lang="ts">
  // A Review of one game: the desktop's Engine grades every move (ADR 0007), the desktop picks the
  // key moments, and the Coach writes an overview of the whole game (unless Settings turn it off),
  // then explains each key moment, streamed as it's written. Saved Reviews reopen with no Coach call.
  // The board frame (docs/design/interface-guidelines.md): the header line says whose side the
  // Player had and how it ended, the board stays in view, and the panel is one card with three tabs,
  // Moments (one line per key moment, the open one expanded), Moves and Overview, with the Ask box
  // docked at its foot. On a phone the panel is a sheet under the board: pulled up, the board
  // shrinks to a strip beside its bar, and a tap on the strip brings it back.
  // The board is free: a move on it starts a variation, which Back to the game drops.
  import { tick, untrack } from 'svelte';
  import { moveLabel, otherSide, SIDE_NAMES, type Side } from '@chess-coach/shared/chess';
  import type { MoveGrade } from '@chess-coach/shared/grader';
  import { scoreAfterPly } from '@chess-coach/shared/position-score';
  import { winningChancesFor, type WinningChances } from '@chess-coach/shared/winning-chances';
  import { overviewSegments } from '@chess-coach/shared/overview';
  import type { GameDetail, GameSummary, KeyMoment, OverviewMove, Review } from '@chess-coach/shared/protocol';
  import Board from '../components/Board.svelte';
  import CoachPanel from '../components/CoachPanel.svelte';
  import FlipButton from '../components/FlipButton.svelte';
  import GradeBadge from '../components/GradeBadge.svelte';
  import MoveList from '../components/MoveList.svelte';
  import SheetHandle from '../components/SheetHandle.svelte';
  import SheetStrip from '../components/SheetStrip.svelte';
  import StepButtons from '../components/StepButtons.svelte';
  import ThreatButton from '../components/ThreatButton.svelte';
  import WinningChancesBar from '../components/WinningChancesBar.svelte';
  import WinningChancesGraph from '../components/WinningChancesGraph.svelte';
  import { api, ApiError } from '../lib/api.svelte.ts';
  import { coachArrows, reviewArrows, threatArrows } from '../lib/arrows.ts';
  import { CoachThread } from '../lib/coach.svelte.ts';
  import { threatOnDesktop } from '../lib/engine/engine.svelte.ts';
  import { Line } from '../lib/game.svelte.ts';
  import { keptGames } from '../lib/kept-games.ts';
  import { desktopBack, droppedConnection, runningReview, startReview, type ReviewRun } from '../lib/review-runs.svelte.ts';
  import { router } from '../lib/router.svelte.ts';
  import { threatSetting, ThreatView } from '../lib/threat.svelte.ts';
  import { reveal } from '../lib/reveal.ts';
  import { foldFromNextVisit, foldOpen } from '../lib/folds.ts';
  import { gradeMark } from '../lib/grades.ts';
  import { narrow } from '../lib/narrow.svelte.ts';
  import { titleFrom } from '../lib/page-title.svelte.ts';
  import { stepLine, Variation, type Step } from '../lib/variation.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';
  import { sheet } from '../lib/sheet.svelte.ts';

  type Tab = 'moments' | 'moves' | 'overview';

  let { gameId }: { gameId: number } = $props();

  let game = $state<GameDetail | null>(null);
  /** The game as this device kept it, shown while the desktop can't be reached. */
  let kept = $state<GameSummary | null>(null);
  let review = $state<Review | null>(null);
  /** The Review being made, which goes on if the Player leaves this screen. */
  let run = $state<ReviewRun | null>(null);
  let phase = $state<'loading' | 'ready' | 'running' | 'done'>('loading');
  let error = $state('');
  let selected = $state<number | null>(null);
  /** The key moment whose explanation is open on the board: the position before it, with the Coach's arrows. */
  let open = $state<number | null>(null);
  /** The key moment whose row is expanded in the panel: the last one the Player opened. */
  let expanded = $state<number | null>(null);
  /** The panel's tab. */
  let tab = $state<Tab>('moments');
  /** A key moment's better move the Player is trying on the board, from that moment's position. */
  let trying = $state<{ ply: number; uci: string } | null>(null);
  /** The open key moment shows all the Coach's arrows, not only the move played and the best. */
  let allArrows = $state(false);
  /** The panel's tab when the Player started a variation, which Back to the game returns to. */
  let tabBeforeVariation: Tab = 'moments';
  /** The side at the bottom of the board: the Player's, until they flip it. */
  let flipped = $state(false);
  /** Whether the overview is new to the Player: the first visit to this game's Review. */
  let overviewNew = $state(true);
  const line = new Line();
  const coach = new CoachThread();
  /** The Player's own moves from a position of the game, graded by the browser's Engine; the game's line never changes. */
  const variation = new Variation();

  const grades = $derived((review?.moves ?? []).map((g) => g.grade as MoveGrade | undefined));
  titleFrom(() => game && `Review: ${game.white} vs ${game.black}`);

  // Loads the game once per game id. Only the id: a connection that drops and comes back must not
  // reload the screen, which would send the board to the start and close the open key moment.
  $effect(() => {
    const id = gameId;
    untrack(() => void load(id));
  });
  // Back or Forward to the Review puts back the Player's place once the game has loaded.
  const contentShown = router.loadsLater();
  $effect(() => {
    if (phase !== 'loading' || error) contentShown();
  });

  async function load(id: number): Promise<void> {
    phase = 'loading';
    error = '';
    kept = null;
    run = null;
    for (;;) {
      try {
        if (api.state !== 'online') kept = (await keptGames())?.games.find((g) => g.id === id) ?? null;
        await api.whenOnline();
        game = await api.request('games.get', { gameId: id });
        overviewNew = foldOpen(seenKey(id), true);
        line.reset(game.startFen, game.moves);
        line.goTo(0);
        const reply = await api.request('review.get', { gameId: id });
        review = reply.review;
        if (review) phase = 'done';
        else {
          // Started on this device before the Player left the screen: follow it rather than offer
          // Start. Started by a request this device no longer holds, before a reload or in a tab
          // since closed: the desktop is still making it, and asking for it joins it.
          const running = runningReview(id) ?? (reply.beingMade ? startReview(id, line.moves.length) : undefined);
          if (running) void follow(running);
          else phase = 'ready';
        }
        return;
      } catch (err) {
        // The connection dropped while loading: load again once the desktop is back.
        if (droppedConnection(err)) {
          await desktopBack();
          continue;
        }
        error = err instanceof ApiError ? err.message : 'This game couldn’t be loaded.';
        return;
      }
    }
  }

  function start(): void {
    if (!game || run) return;
    void follow(startReview(game.id, line.moves.length));
  }

  /** Shows a Review being made until it is done, then opens its first key moment. */
  async function follow(r: ReviewRun): Promise<void> {
    run = r;
    error = '';
    phase = 'running';
    try {
      const made = await r.done;
      if (run !== r) return;
      review = made;
      phase = 'done';
      const first = review.moments[0];
      if (first) jump(first);
    } catch (err) {
      if (run !== r) return;
      error = droppedConnection(err)
        ? 'The Review stopped because your desktop couldn’t be reached. Start it again once it is back.'
        : err instanceof ApiError
          ? err.message
          : 'The Review couldn’t be finished.';
      phase = 'ready';
    } finally {
      if (run === r) run = null;
    }
  }

  /** Opens a key moment's explanation on the board, or closes it when it is already open. */
  function jump(m: KeyMoment, byPlayer = false): void {
    coach.clearAnnotations();
    allArrows = false;
    selected = m.ply;
    const exploring = variation.active;
    variation.leave();
    if (momentOpen && open === m.ply && !exploring) {
      open = null;
      expanded = null;
      return;
    }
    open = m.ply;
    expanded = m.ply;
    line.goTo(m.ply);
    // Reading a moment needs the height: on a phone the sheet comes up, the board a strip beside it.
    if (byPlayer) sheet.pullUp();
    void tick().then(() => revealMoment(m.ply));
  }

  /** A key moment's better move, played on the board as a variation from the position before it. */
  function tryBetter(m: KeyMoment, uci: string): void {
    // The move plays on the board, so a phone's board comes back full size to show it.
    sheet.full = false;
    if (!(momentOpen && open === m.ply) || variation.active) {
      variation.leave();
      coach.clearAnnotations();
      selected = m.ply;
      open = m.ply;
      expanded = m.ply;
      line.goTo(m.ply);
    }
    trying = { ply: m.ply, uci };
    explore(uci, { keepTab: true });
    // The moment's row and its Trying line show under the tabs, above all in a phone's short panel.
    void tick().then(() => revealMoment(m.ply));
  }

  /**
   * Scrolls the panel so an opened key moment's row is at its top, under the tabs: closing the one
   * above can leave the panel scrolled past it, above all in a phone's short panel.
   */
  function revealMoment(ply: number): void {
    const row = document.querySelector<HTMLElement>(`.moment[data-ply="${ply}"]`);
    const body = row?.closest<HTMLElement>('.panel-body');
    if (!row || !body) return;
    reveal(body, row, 'start');
  }

  /** A move the overview names: the board goes to the position after it, as the move list does. */
  function showMove(m: OverviewMove): void {
    goto(m.ply);
  }

  // The overview has its own tab. On the first visit to its Review, the key moments open under its
  // first sentence, one tap from the rest; after that, the tab alone
  // (docs/design/interface-guidelines.md, Collapsing and density).
  $effect(() => {
    if (game && review?.overview) foldFromNextVisit(seenKey(game.id));
  });

  /**
   * Remembers that the Player has seen a game's overview. Not the old fold's key, which a Player
   * who opened the fold left at "open" and would bring the first sentence back on every visit.
   */
  function seenKey(id: number): string {
    return `review-overview-seen-${id}`;
  }

  function pickTab(to: Tab): void {
    tab = to;
    if (to === 'overview') overviewNew = false;
  }

  /** The overview's text split at the moves it names, and the moves it names that its text doesn't link. */
  const overview = $derived.by(() => {
    const o = review?.overview;
    if (!o) return null;
    const segments = overviewSegments(o.text, o.moves);
    const linked = new Set(segments.flatMap((p) => (p.move ? [p.move.ply] : [])));
    return { segments, unlinked: o.moves.filter((m) => !linked.has(m.ply)) };
  });

  /** A move picked in the move list. */
  function pickMove(cursor: number): void {
    goto(cursor);
  }

  /** How the game ended for the Player: "Won 1-0", "Lost 0-1", "Drew ½-½". */
  function outcome(g: Pick<GameSummary, 'result' | 'playerSide'>): string {
    if (g.result === '1/2-1/2') return 'Drew ½-½';
    if (g.result !== '1-0' && g.result !== '0-1') return g.result;
    return `${(g.result === '1-0') === (g.playerSide === 'white') ? 'Won' : 'Lost'} ${g.result}`;
  }

  /** The header line: the Player's side, how it ended, the opponent, the opening and the date. */
  function summaryOf(g: Pick<GameSummary, 'white' | 'black' | 'result' | 'opening' | 'date' | 'playerSide'>): string {
    const opponent = g.playerSide === 'white' ? g.black : g.white;
    return [`You had ${SIDE_NAMES[g.playerSide]}`, outcome(g), `vs ${opponent}`, g.opening, g.date?.slice(0, 10)].filter(Boolean).join(' · ');
  }

  /** Fewer moves of the Player's than this make a short game, such as one resigned in the opening. */
  const SHORT_GAME = 10;

  /**
   * What a Review with no key moments says, for how the game ended for the Player. Key moments
   * skip moves played once the game was decided, so the text never claims more than "while the
   * game was still open".
   */
  function noMoments(g: GameDetail): string {
    const won = (g.result === '1-0' && g.playerSide === 'white') || (g.result === '0-1' && g.playerSide === 'black');
    if (won) return 'A clean game: none of your moves was graded Inaccuracy or worse while the game was still open.';
    const moves = review?.moves.filter((m) => m.side === g.playerSide).length ?? 0;
    if (moves < SHORT_GAME) return 'A short game, with no key moment to walk through: step through the moves and ask the Coach why about any of them.';
    return 'None of your moves was graded Inaccuracy or worse while the game was still open, so there is no key moment to walk through. Step through the moves and ask the Coach why about any of them.';
  }

  function goto(cursor: number): void {
    const from = line.cursor;
    const exploring = variation.active;
    variation.leave();
    line.goTo(cursor);
    open = null;
    // The Coach's arrows belong to the move it was asked about.
    if (line.cursor !== from || exploring) coach.clearAnnotations();
    selected = review?.moments.some((m) => m.ply === line.cursor) ? line.cursor : null;
  }

  /**
   * A move on the board: the game's own next move steps to it, as on Lichess; any other starts a
   * variation from the position shown, or carries on the one shown. The Coach's arrows belong to
   * the position they were drawn on.
   */
  function explore(uci: string, { keepTab = false } = {}): void {
    const to = variation.gameStep(uci, line.moves, shownIndex);
    if (to !== null) goto(to);
    else {
      const starting = !variation.active;
      if (!variation.play(uci, { cursor: shownIndex, fen: boardFen })) return;
      coach.clearAnnotations();
      // A new variation shows in the move list, so the panel turns to it; Back to the game turns it back.
      // A better move tried from its key moment stays with the moment, which says what is tried.
      if (starting) {
        tabBeforeVariation = tab;
        if (!keepTab) tab = 'moves';
      }
    }
  }

  /** Steps through the variation while the board shows one, otherwise through the game. */
  function step(where: Step): void {
    if (!variation.active) {
      goto({ first: 0, previous: shownIndex - 1, next: shownIndex + 1, last: line.moves.length }[where]);
      return;
    }
    showVariationMove(where);
  }

  /** Moves through the variation: a step, or a move picked in its row of the move list. */
  function showVariationMove(to: Step | number): void {
    const before = variation.line.cursor;
    if (typeof to === 'number') variation.line.goTo(to);
    else stepLine(variation.line, to);
    if (variation.line.cursor !== before) coach.clearAnnotations();
  }

  /** Drops the variation: the board shows the game where the Player left it, an open key moment too. */
  function backToGame(): void {
    variation.leave();
    // The Coach's answer was about the variation: put away behind "Earlier", with its arrows.
    coach.settle();
    tab = tabBeforeVariation;
    // The key moment the variation started from comes back into view.
    const at = open;
    if (at !== null) void tick().then(() => revealMoment(at));
  }

  async function why(question: string): Promise<void> {
    if (variation.active && game) {
      // Only the moves go, and the desktop's Engine works out the facts (ADR 0007). No gameId: the
      // Review has no score for a position the game never reached.
      const { label, ...asked } = variation.question(line.moves);
      await coach.ask({ job: 'why', ...asked, playerSide: game.playerSide, opening: game.opening, ...(question ? { question } : {}) }, question || label);
      return;
    }
    const cursor = line.cursor;
    const move = line.moves[cursor - 1];
    if (!move || !game) return;
    const grade = review?.moves[cursor - 1]?.grade;
    await coach.ask(
      {
        job: 'why',
        fen: move.fenBefore,
        recentMoves: line.moves.slice(0, cursor - 1).map((m) => m.san),
        playerSide: game.playerSide,
        moveUci: move.uci,
        opening: game.opening,
        // The desktop quotes the Winning Chances this Review shows, from its graded moves.
        gameId: game.id,
        ...(question ? { question } : {}),
      },
      question || (grade ? `Why is ${move.san} graded ${grade}?` : `Why ${move.san}?`),
    );
  }

  /**
   * The Player's Winning Chances before and after a key moment's move, as the bar and the graph
   * show those positions, and after each better option, from the Review's own graded moves: no
   * new data and no Engine run.
   */
  function chancesOf(m: KeyMoment): { before: WinningChances; after: WinningChances; options: Map<string, WinningChances> } | null {
    const graded = review?.moves[m.ply - 1];
    const before = review ? scoreAfterPly(review.moves, m.ply - 1) : null;
    const after = review ? scoreAfterPly(review.moves, m.ply) : null;
    if (!graded || !before || !after || !game) return null;
    const side = game.playerSide;
    return {
      before: winningChancesFor(before.score, before.pov, side),
      after: winningChancesFor(after.score, after.pov, side),
      options: new Map(graded.candidates.map((c) => [c.uci, winningChancesFor(c.score, graded.side, side)])),
    };
  }

  const orientation = $derived<Side>(game ? (flipped ? otherSide(game.playerSide) : game.playerSide) : 'white');
  /** Evaluations show beside the percentages at the club level only. */
  const evals = $derived(profile.showsEvaluations);
  /** The move the Ask box asks about: the one on the board. */
  const askedMove = $derived(variation.active ? variation.line.lastMove : line.moves[line.cursor - 1]);
  /** The variation as the move list shows it, under the move it branches from. */
  const shownVariation = $derived(
    variation.active
      ? { from: variation.from ?? 0, moves: variation.line.moves, grades: variation.grades, cursor: variation.line.cursor, ongoto: showVariationMove }
      : undefined,
  );

  // The threat in the position on the board, from the desktop's Engine that graded the game (ADR 0007).
  const threats = new ThreatView(threatOnDesktop);
  const momentOpen = $derived(open !== null && line.cursor === open);
  const openMoment = $derived(momentOpen ? review?.moments.find((m) => m.ply === open) : undefined);
  /** The Coach is explaining on the board: an open key moment, or a Why Question's answer. */
  const coachExplains = $derived(Boolean(openMoment) || coach.arrows.length > 0);
  // One set of arrows at a time: the Coach's while it explains, otherwise the move played and the
  // Engine's best from the Review's graded moves, with the threat when Threat is on.
  // The move played is ink in the Coach's arrows too, as everywhere. A variation has no Review
  // arrows: only the threat, and the Coach's once it answers about it.
  /**
   * An open key moment's arrows: at most two by default, the move played and the best, as the
   * guidelines ask; the rest when the Player asks for them.
   */
  const momentArrows = $derived(coachArrows(openMoment?.arrows ?? [], line.moves[line.cursor - 1]?.uci));
  const momentArrowsShown = $derived(allArrows ? momentArrows : momentArrows.filter((a) => a.kind === 'played' || a.kind === 'best'));
  const shownArrows = $derived(
    variation.active
      ? coach.arrows.length ? coachArrows(coach.arrows, variation.line.lastMove?.uci) : threatArrows(threats.threat)
      : coachExplains
        ? coach.arrows.length ? coachArrows(coach.arrows, line.moves[line.cursor - 1]?.uci) : momentArrowsShown
        : [...threatArrows(threats.threat), ...reviewArrows(review?.moves[line.cursor - 1])],
  );
  /** The better move being tried from the open key moment, while the board shows its variation. */
  const tried = $derived(
    trying && variation.active && variation.from === trying.ply - 1 && variation.line.moves[0]?.uci === trying.uci ? trying : null,
  );
  const momentFen = $derived(openMoment ? openMoment.fenBefore : null);
  /** An open key moment shows the position before its move; any other cursor, the position after it. */
  const shownIndex = $derived(momentFen ? line.cursor - 1 : line.cursor);
  /** The Move Grade of the move that reached the position on the board, on the square it landed on. */
  const mark = $derived(variation.active ? variation.mark : gradeMark(line.moves[shownIndex - 1], grades[shownIndex - 1]));
  /**
   * The Winning Chances bar's facts, from the Review's graded moves: no new data and no Engine run.
   * In a variation, from the browser Engine's Move Grade of the move shown, and at its first
   * position, the game's.
   */
  const position = $derived.by(() => {
    if (!variation.active) return review ? scoreAfterPly(review.moves, shownIndex) : null;
    const v = variation.line;
    if (v.cursor === 0) return review ? scoreAfterPly(review.moves, variation.from ?? 0) : null;
    const g = variation.shownGrade;
    return g ? scoreAfterPly([g], 1) : null;
  });
  /** What the bar says while it has no score: a variation's move waits for the browser's Engine, unless it can't be graded. */
  const barWaiting = $derived(
    variation.active && variation.line.cursor > 0
      ? variation.shownGrade === null
        ? 'not graded in this variation'
        : 'the Engine is thinking'
      : review
        ? 'not graded in this Review'
        : 'shown once the Review is done',
  );
  const gameFen = $derived(momentFen ?? line.fen);
  const boardFen = $derived(variation.active ? variation.fen : gameFen);
  /** The move that reached the position on the board: none on an open key moment, which shows the position before its move. */
  const shownLast = $derived(variation.active ? variation.line.lastMove : momentFen ? undefined : line.lastMove);

  $effect(() => {
    threats.follow(threatSetting.on ? boardFen : null);
  });
</script>

<section class="screen board-screen review" class:sheet-full={sheet.shown}>
  <header class="frame-head">
    <h1>Review</h1>
    {#if game}<p class="head-line" data-testid="review-summary">{summaryOf(game)}</p>{:else if kept}<p class="head-line">{summaryOf(kept)}</p>{/if}
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if game}
    <div class="board-layout">
      <div class="board-col">
        <div class="board-and-bar">
          <SheetStrip />
          <div class="with-bar">
            <WinningChancesBar
              score={position?.score ?? null}
              pov={position?.pov ?? 'white'}
              {orientation}
              waiting={barWaiting}
            />
            <!-- Opening or closing a key moment is not a move: a fresh Board shows it at once. -->
            {#key momentFen}
              <Board
                fen={boardFen}
                {orientation}
                movable="both"
                lastMove={shownLast ? { from: shownLast.uci.slice(0, 2), to: shownLast.uci.slice(2, 4) } : undefined}
                arrows={shownArrows}
                highlights={coach.highlights}
                gradeMark={mark}
                label="Review board"
                onmove={explore}
              />
            {/key}
          </div>
        </div>
        <div class="board-bar toolbar">
          <!-- Steps from the position on the board: an open key moment shows the one before its move. -->
          <StepButtons onfirst={() => step('first')} onprevious={() => step('previous')} onnext={() => step('next')} onlast={() => step('last')} />
          {#if variation.active}<button type="button" class="secondary back" onclick={backToGame}>Back to the game</button>{/if}
          <FlipButton onflip={() => (flipped = !flipped)} />
          <ThreatButton view={threats} />
        </div>
        <!-- The game's graph steps aside while the Player tries a variation, leaving its bar the room
             Back to the game takes, so the frame stays one screen tall. -->
        {#if review && !narrow.on && !variation.active}
          <WinningChancesGraph moves={review.moves} cursor={variation.from ?? shownIndex} ongoto={goto} compact />
        {/if}
      </div>
      <div class="side panel">
        <SheetHandle />
        <div class="panel-body" {@attach sheet.gestures}>
          {#if game.source === 'sample'}<p class="muted small" role="note">A sample game: it doesn’t count towards your Player Profile.</p>{/if}
          {#if phase === 'ready'}
            <div class="card">
              <p>The Engine grades every move, then the Coach sums up the game and explains the moments that mattered most.</p>
              <button type="button" onclick={start} disabled={api.state !== 'online'}>Start the Review</button>
            </div>
          {:else if phase === 'running' && run?.interrupted}
            <div class="card" role="status">
              <p>The connection to your desktop dropped. The Review goes on once it is back.</p>
            </div>
          {:else if phase === 'running' && run?.phase === 'grading'}
            <div class="card" role="status">
              <label for="grading">Grading move {run.progress.done} of {run.progress.total}…</label>
              <progress id="grading" max={run.progress.total} value={run.progress.done}></progress>
            </div>
          {:else if phase === 'running' && run?.phase === 'explaining'}
            <div class="card" role="status" aria-live="polite">
              <!-- The overview comes first when Settings have it on: the desktop says so as it starts on it. -->
              <p>{run.overviewFirst && !run.streaming.length ? 'The Coach is writing an overview of the game…' : 'The Coach is explaining the key moments…'}</p>
              {#if run.overview}<p class="stream" data-testid="overview-stream">{run.overview}</p>{/if}
              {#each run.streaming as text, i (i)}{#if text}<p class="stream">{text}</p>{/if}{/each}
            </div>
          {/if}

          {#if review}
            {@const tabs = (overview ? ['moments', 'moves', 'overview'] : ['moments', 'moves']) as Tab[]}
            {@const names = { moments: 'Moments', moves: 'Moves', overview: 'Overview' }}
            <div class="tabs" role="tablist" aria-label="Review">
              {#each tabs as t (t)}
                <button type="button" role="tab" id={`tab-${t}`} aria-controls={`panel-${t}`} aria-selected={tab === t} class:on={tab === t} onclick={() => pickTab(t)}
                  aria-label={t === 'overview' && overviewNew ? 'Overview, not read yet' : undefined}
                  >{names[t]}{#if t === 'overview' && overviewNew}<span class="new-dot" aria-hidden="true"></span>{/if}</button
                >
              {/each}
            </div>
            <div id="panel-moments" role="tabpanel" aria-labelledby="tab-moments" hidden={tab !== 'moments'} class="tab-panel rows">
              <section aria-label="Key moments">
                <h2 class="visually-hidden">Key moments</h2>
                {#if review.moments.length === 0}
                  <p class="muted none">{noMoments(game)}</p>
                {/if}
                <ol class="moments">
                  {#each review.moments as m (m.ply)}
                    {@const chances = chancesOf(m)}
                    {@const label = moveLabel(m.fenBefore, m.san)}
                    {@const isOpen = expanded === m.ply}
                    <li class="moment" class:active={selected === m.ply} class:expanded={isOpen} data-ply={m.ply}>
                      <button type="button" class="row" onclick={() => jump(m, true)} aria-pressed={momentOpen && open === m.ply} aria-expanded={isOpen} aria-label={`Show moment: move ${label}, ${m.grade}`}>
                        <strong class="san">{label}</strong>
                        <GradeBadge grade={m.grade} />
                        {#if chances}
                          <span class="change" data-testid="chances-change">{chances.before.short} → {chances.after.short}{#if evals}<span class="eval muted">{` ${chances.before.evaluation} → ${chances.after.evaluation}`}</span>{/if}</span>
                        {/if}
                      </button>
                      <!-- The row's numbers in words, for a screen reader. -->
                      {#if chances}
                        <p class="visually-hidden" data-testid="chances-before">Before: {chances.before.text}</p>
                        <p class="visually-hidden" data-testid="chances-after">After {label}: {chances.after.text}</p>
                      {/if}
                      {#if isOpen}
                        <div class="detail">
                          {#if tried?.ply === m.ply}
                            {@const t = variation.line.moves[0]}
                            {@const g = variation.grades[0]}
                            {@const c = chances?.options.get(tried.uci)}
                            <!-- What the board shows now, first, so it reads in a short sheet. -->
                            <p class="trying" role="status">
                              <strong>Trying {t ? moveLabel(t.fenBefore, t.san) : ''}</strong>
                              {#if g}<GradeBadge grade={g} />{/if}
                              instead of {m.san}{c ? ` · ${c.short}` : ''}. Your own line: Back to the game returns here.
                            </p>
                          {/if}
                          <p class="explanation">{m.explanation}</p>
                          {#if m.betterOptions.length}
                            {@const [best, ...others] = m.betterOptions}
                            {@const option = (o: (typeof m.betterOptions)[number]) => {
                              const c = chances?.options.get(o.uci);
                              return c ? `${o.san} ${c.short}${evals ? ` (${c.evaluation})` : ''}` : `${o.san} (${o.score})`;
                            }}
                            <div class="better small">
                              <span class="muted">Better</span>
                              <!-- The fix, on the board: a variation from the position before the move. -->
                              <button type="button" class="secondary try" onclick={() => tryBetter(m, best!.uci)} aria-label={`Try ${best!.san} on the board`}>{option(best!)}</button>
                              {#if others.length}
                                <details class="more">
                                  <summary>More moves</summary>
                                  <p>{others.map(option).join(', ')}</p>
                                </details>
                              {/if}
                            </div>
                          {/if}
                          {#if momentOpen && open === m.ply && !variation.active && momentArrows.length > momentArrowsShown.length}
                            <button type="button" class="link more-arrows small" onclick={() => (allArrows = true)}>Show all {momentArrows.length} arrows</button>
                          {/if}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ol>
                <p class="muted small explore-hint">Move a piece on the board to try your own idea. Back to the game returns here.</p>
              </section>
            </div>
            <div id="panel-moves" role="tabpanel" aria-labelledby="tab-moves" hidden={tab !== 'moves'} class="tab-panel">
              {#if narrow.on}
                <WinningChancesGraph moves={review.moves} cursor={variation.from ?? shownIndex} ongoto={goto} />
              {/if}
              <!-- Drawn when shown, so it opens scrolled to the current move. -->
              {#if tab === 'moves'}<MoveList moves={line.moves} {grades} cursor={variation.from ?? line.cursor} ongoto={pickMove} variation={shownVariation} />{/if}
            </div>
            {#if overview}
              <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" hidden={tab !== 'overview'} class="tab-panel">
                <section aria-label="Overview">
                  <p class="overview">
                    {#each overview.segments as part, i (i)}
                      {#if part.move}
                        {@const m = part.move}
                        <button
                          type="button"
                          class="link move"
                          class:current={line.cursor === m.ply}
                          onclick={() => showMove(m)}
                          aria-label={`Go to move ${m.label}, ${m.grade}`}>{part.text}</button
                        >
                      {:else}{part.text}{/if}
                    {/each}
                  </p>
                  {#if overview.unlinked.length}
                    <p class="small">
                      Moves it names:
                      {#each overview.unlinked as m, i (m.ply)}{i ? ', ' : ''}<button
                          type="button"
                          class="link move"
                          class:current={line.cursor === m.ply}
                          onclick={() => showMove(m)}
                          aria-label={`Go to move ${m.label}, ${m.grade}`}>{m.label}</button
                        >{/each}
                    </p>
                  {/if}
                </section>
              </div>
            {/if}
          {:else}
            <MoveList moves={line.moves} {grades} cursor={variation.from ?? line.cursor} ongoto={pickMove} variation={shownVariation} />
          {/if}
        </div>
        <CoachPanel
          thread={coach}
          onwhy={why}
          placeholder={askedMove ? `Ask why about ${moveLabel(askedMove.fenBefore, askedMove.san)}` : 'Ask why about this move'}
          closed={askedMove ? undefined : 'Step to a move to ask why about it'}
        />
      </div>
    </div>
  {:else if !error && api.state === 'offline'}
    <p class="card" role="note">Reviews live on your desktop, which can’t be reached right now. This one opens here once it is back.</p>
  {:else if !error}
    <p class="muted">Loading the game…</p>
  {:else}
    <!-- The game couldn't be loaded, for example after it was deleted from the game list. -->
    <p><a href="#/">Back to the menu</a></p>
  {/if}
</section>

<style>
  /* Under the board on desktop: the bar, the legend line and the graph's strip. On a phone, what the
     frame keeps under and above the board: the header, the bar, the legend, the panel's tabs and its
     first lines, and the Ask box. */
  .review { --under-board: 12.75rem; --phone-reserve: 25.25rem; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 1; margin-inline: calc(-1 * var(--panel-pad)); padding-inline: calc(var(--panel-pad) - 0.25rem); }
  .tabs button { background: none; color: var(--muted); border-radius: 0; padding: 0.45rem 0.75rem; min-height: 2.5rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button.on { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  .tab-panel { display: flex; flex-direction: column; gap: 0.6rem; }
  .tab-panel[hidden] { display: none; }
  .tab-panel.rows { gap: 0; }
  /* One line per key moment, ruled off from the next: the move, its Move Grade and what changed. */
  .moments { list-style: none; padding: 0; margin: 0 calc(-1 * var(--panel-pad)); display: flex; flex-direction: column; }
  .moment { border-bottom: 1px solid var(--line); }
  .moment.active { box-shadow: inset 3px 0 0 var(--accent); }
  .moment.expanded { background: color-mix(in srgb, var(--accent) 7%, var(--panel)); }
  .row {
    width: 100%; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    background: none; color: inherit; text-align: left; border-radius: 0;
    padding: 0.5rem var(--panel-pad); min-height: var(--tap);
  }
  .row .change { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .detail { padding: 0 var(--panel-pad) 0.65rem; }
  .link { background: none; border: none; padding: 0; color: inherit; cursor: pointer; text-align: left; }
  .small { font-size: 0.85rem; margin: 0.3rem 0; }
  .eval { font-size: 0.8rem; font-weight: 400; font-variant-numeric: tabular-nums; }
  .explanation { margin: 0 0 0.45rem; }
  /* Better: the best move as a button that tries it on the board, the others one tap away. */
  .better { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; margin-bottom: 0; }
  .better .try { padding: 0.15rem 0.6rem; min-height: 2rem; font-weight: 600; border-color: var(--accent); border-radius: 6px; font-variant-numeric: tabular-nums; }
  .more { margin-left: auto; }
  .more summary { cursor: pointer; color: var(--muted); }
  .more[open] { flex-basis: 100%; margin-left: 0; }
  .more p { margin: 0.2rem 0 0; }
  .none { margin: 0.6rem 0 0; }
  .explore-hint { margin: 0.6rem 0 0; }
  /* The overview not read yet: a dot on its tab, not a row that costs a phone's sheet a line. */
  .new-dot { display: inline-block; width: 0.45rem; height: 0.45rem; margin-left: 0.3rem; border-radius: 50%; background: var(--accent); vertical-align: 0.15rem; }
  .trying { margin: 0 0 0.45rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.4rem; }
  .more-arrows { display: block; margin-top: 0.4rem; color: var(--muted); text-decoration: underline; }
  .overview { margin: 0.6rem 0 0; line-height: 1.5; }
  /* A move the overview names reads as part of its sentence, marked as something to click. */
  .move { color: var(--accent); text-decoration: underline; text-underline-offset: 0.15em; font: inherit; }
  .move.current { font-weight: 600; }
  .stream { white-space: pre-wrap; }
  /* The card's padding is its spacing: no extra paragraph margin above its first line. */
  .card > p:first-child { margin-top: 0; }
  progress { width: 100%; }
  .panel-body > .card { margin-top: 0.6rem; }
  @media (max-width: 820px) {
    .tabs button { min-height: var(--tap); }
    .better .try { min-height: var(--tap); }
  }
</style>
