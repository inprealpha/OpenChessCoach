<script lang="ts">
  // A Review of one game: the desktop's Engine grades every move (ADR 0007), the desktop picks the
  // key moments, and the Coach writes an overview of the whole game (unless Settings turn it off),
  // then explains each key moment, streamed as it's written. Saved Reviews reopen with no Coach call.
  // The board frame (docs/design/interface-guidelines.md): the header line says whose side the
  // Player had and how it ended, the board stays in view, and the panel has two tabs, Moments (the
  // overview and one line per key moment, the open one expanded) and Moves, with the Ask box docked
  // at its foot.
  import { untrack } from 'svelte';
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
  import { foldOpen, rememberFold } from '../lib/folds.ts';
  import { gradeMark } from '../lib/grades.ts';
  import { narrow } from '../lib/narrow.svelte.ts';
  import { titleFrom } from '../lib/page-title.svelte.ts';
  import { profile } from '../lib/profile.svelte.ts';

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
  let tab = $state<'moments' | 'moves'>('moments');
  /** The side at the bottom of the board: the Player's, until they flip it. */
  let flipped = $state(false);
  /** Whether the overview is open: on the first visit to this game's Review, then as the Player left it. */
  let overviewOpen = $state(true);
  const line = new Line();
  const coach = new CoachThread();

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
        overviewOpen = foldOpen(`review-overview-${id}`, true);
        line.reset(game.startFen, game.moves);
        line.goTo(0);
        const reply = await api.request('review.get', { gameId: id });
        review = reply.review;
        if (review) {
          phase = 'done';
          // The first key moment's row starts expanded, so the panel opens on words, not a list.
          expanded = review.moments[0]?.ply ?? null;
        }
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
  function jump(m: KeyMoment): void {
    coach.clearAnnotations();
    selected = m.ply;
    if (momentOpen && open === m.ply) {
      open = null;
      expanded = null;
      return;
    }
    open = m.ply;
    expanded = m.ply;
    line.goTo(m.ply);
  }

  /** A move the overview names: the board goes to the position after it, as the move list does. */
  function showMove(m: OverviewMove): void {
    goto(m.ply);
  }

  function toggleOverview(e: Event): void {
    overviewOpen = (e.currentTarget as HTMLDetailsElement).open;
    if (game) rememberFold(`review-overview-${game.id}`, overviewOpen);
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

  /** The overview's first sentence, its one-line summary while it is folded. */
  function firstSentence(text: string): string {
    const m = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
    return m ? m[0] : text;
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
    line.goTo(cursor);
    open = null;
    // The Coach's arrows belong to the move it was asked about.
    if (line.cursor !== from) coach.clearAnnotations();
    selected = review?.moments.some((m) => m.ply === line.cursor) ? line.cursor : null;
  }

  async function why(question: string): Promise<void> {
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
  const askedMove = $derived(line.moves[line.cursor - 1]);

  // The threat in the position on the board, from the desktop's Engine that graded the game (ADR 0007).
  const threats = new ThreatView(threatOnDesktop);
  const momentOpen = $derived(open !== null && line.cursor === open);
  const openMoment = $derived(momentOpen ? review?.moments.find((m) => m.ply === open) : undefined);
  /** The Coach is explaining on the board: an open key moment, or a Why Question's answer. */
  const coachExplains = $derived(Boolean(openMoment) || coach.arrows.length > 0);
  // One set of arrows at a time: the Coach's while it explains, otherwise the move played and the
  // Engine's best from the Review's graded moves, with the threat when Threat is on.
  // The move played is ink in the Coach's arrows too, as everywhere.
  const shownArrows = $derived(
    coachExplains
      ? coachArrows(coach.arrows.length ? coach.arrows : (openMoment?.arrows ?? []), line.moves[line.cursor - 1]?.uci)
      : [...threatArrows(threats.threat), ...reviewArrows(review?.moves[line.cursor - 1])],
  );
  const momentFen = $derived(openMoment ? openMoment.fenBefore : null);
  /** An open key moment shows the position before its move; any other cursor, the position after it. */
  const shownIndex = $derived(momentFen ? line.cursor - 1 : line.cursor);
  /** The Move Grade of the move that reached the position on the board, on the square it landed on. */
  const mark = $derived(gradeMark(line.moves[shownIndex - 1], grades[shownIndex - 1]));
  /** The Winning Chances bar's facts, from the Review's graded moves: no new data and no Engine run. */
  const position = $derived(review ? scoreAfterPly(review.moves, shownIndex) : null);
  const boardFen = $derived(momentFen ?? line.fen);

  $effect(() => {
    threats.follow(threatSetting.on ? boardFen : null);
  });
</script>

<section class="screen board-screen review">
  <header class="frame-head">
    <h1>Review</h1>
    {#if game}<p class="head-line" data-testid="review-summary">{summaryOf(game)}</p>{:else if kept}<p class="head-line">{summaryOf(kept)}</p>{/if}
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if game}
    <div class="board-layout">
      <div class="board-col">
        <div class="board-and-bar">
          <div class="with-bar">
            <WinningChancesBar
              score={position?.score ?? null}
              pov={position?.pov ?? 'white'}
              {orientation}
              waiting={review ? 'not graded in this Review' : 'shown once the Review is done'}
            />
            <!-- Opening or closing a key moment is not a move: a fresh Board shows it at once. -->
            {#key momentFen}
              <Board
                fen={boardFen}
                {orientation}
                movable="none"
                lastMove={line.lastMove && !momentFen
                  ? { from: line.lastMove.uci.slice(0, 2), to: line.lastMove.uci.slice(2, 4) }
                  : undefined}
                arrows={shownArrows}
                highlights={coach.highlights}
                gradeMark={mark}
                label="Review board"
              />
            {/key}
          </div>
        </div>
        <div class="board-bar toolbar">
          <!-- Steps from the position on the board: an open key moment shows the one before its move. -->
          <StepButtons onfirst={() => goto(0)} onprevious={() => goto(shownIndex - 1)} onnext={() => goto(shownIndex + 1)} onlast={() => goto(line.moves.length)} />
          <FlipButton onflip={() => (flipped = !flipped)} />
          <ThreatButton />
        </div>
        {#if review && !narrow.on}
          <WinningChancesGraph moves={review.moves} cursor={shownIndex} ongoto={goto} compact />
        {/if}
      </div>
      <div class="side">
        <div class="panel-body">
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
            <div class="tabs" role="tablist" aria-label="Review">
              <button type="button" role="tab" id="tab-moments" aria-controls="panel-moments" aria-selected={tab === 'moments'} class:on={tab === 'moments'} onclick={() => (tab = 'moments')}>Moments</button>
              <button type="button" role="tab" id="tab-moves" aria-controls="panel-moves" aria-selected={tab === 'moves'} class:on={tab === 'moves'} onclick={() => (tab = 'moves')}>Moves</button>
            </div>
            <div id="panel-moments" role="tabpanel" aria-labelledby="tab-moments" hidden={tab !== 'moments'} class="tab-panel">
              {#if overview}
                <section class="card overview-card" aria-label="Overview">
                <details class="fold overview-fold" open={overviewOpen} ontoggle={toggleOverview}>
                  <summary><strong>Overview</strong>{#if !overviewOpen}<span class="summary-line"> · {firstSentence(review.overview?.text ?? '')}</span>{/if}</summary>
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
                </details>
                </section>
              {/if}
              <section aria-label="Key moments">
                <h2>Key moments</h2>
                {#if review.moments.length === 0}
                  <p class="muted">{noMoments(game)}</p>
                {/if}
                <ol class="moments">
                  {#each review.moments as m (m.ply)}
                    {@const chances = chancesOf(m)}
                    {@const label = moveLabel(m.fenBefore, m.san)}
                    {@const isOpen = expanded === m.ply}
                    <li class="moment" class:active={selected === m.ply} class:expanded={isOpen} data-ply={m.ply}>
                      <button type="button" class="row" onclick={() => jump(m)} aria-pressed={momentOpen && open === m.ply} aria-expanded={isOpen} aria-label={`Show moment: move ${label}, ${m.grade}`}>
                        <strong class="san">{label}</strong>
                        <GradeBadge grade={m.grade} />
                        {#if chances}
                          <span class="change" data-testid="chances-change">{chances.before.short} → {chances.after.short}{#if evals}<span class="eval muted"> {chances.before.evaluation} → {chances.after.evaluation}</span>{/if}</span>
                        {/if}
                      </button>
                      <!-- The row's numbers in words, for a screen reader. -->
                      {#if chances}
                        <p class="visually-hidden" data-testid="chances-before">Before: {chances.before.text}</p>
                        <p class="visually-hidden" data-testid="chances-after">After {label}: {chances.after.text}</p>
                      {/if}
                      {#if isOpen}
                        <div class="detail">
                          <p class="explanation">{m.explanation}</p>
                          {#if m.betterOptions.length}
                            {@const [best, ...others] = m.betterOptions}
                            {@const option = (o: (typeof m.betterOptions)[number]) => {
                              const c = chances?.options.get(o.uci);
                              return c ? `${o.san} ${c.short}${evals ? ` (${c.evaluation})` : ''}` : `${o.san} (${o.score})`;
                            }}
                            <p class="small better">Better: <strong>{option(best!)}</strong></p>
                            {#if others.length}
                              <details class="more small">
                                <summary>More moves</summary>
                                <p>{others.map(option).join(', ')}</p>
                              </details>
                            {/if}
                          {/if}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </section>
            </div>
            <div id="panel-moves" role="tabpanel" aria-labelledby="tab-moves" hidden={tab !== 'moves'} class="tab-panel">
              {#if narrow.on}
                <WinningChancesGraph moves={review.moves} cursor={shownIndex} ongoto={goto} />
              {/if}
              <MoveList moves={line.moves} {grades} cursor={line.cursor} ongoto={pickMove} />
            </div>
          {:else}
            <MoveList moves={line.moves} {grades} cursor={line.cursor} ongoto={pickMove} />
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
  /* Under the board on desktop: the bar, the legend line and the graph's strip. */
  .review { --under-board: 12.75rem; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 1; }
  .tabs button { background: none; color: var(--muted); border-radius: 8px 8px 0 0; padding: 0.45rem 0.9rem; min-height: 2.5rem; border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  .tab-panel { display: flex; flex-direction: column; gap: 0.6rem; }
  .tab-panel[hidden] { display: none; }
  .moments { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .moment { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .moment.active { outline: 2px solid var(--accent); }
  /* One line per key moment: the move, its Move Grade and what changed. */
  .row {
    width: 100%; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    background: none; color: inherit; text-align: left; padding: 0.5rem 0.75rem; min-height: var(--tap);
  }
  .row .change { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .detail { padding: 0 0.75rem 0.65rem; }
  .link { background: none; border: none; padding: 0; color: inherit; cursor: pointer; text-align: left; }
  .small { font-size: 0.85rem; margin: 0.3rem 0; }
  .eval { font-size: 0.8rem; font-weight: 400; font-variant-numeric: tabular-nums; }
  .explanation { margin: 0 0 0.3rem; }
  .better { margin-bottom: 0; }
  .more summary { cursor: pointer; color: var(--muted); }
  .more p { margin: 0.2rem 0 0; }
  .overview { margin: 0.4rem 0 0; }
  .overview-fold summary { line-height: 1.4; }
  /* A move the overview names reads as part of its sentence, marked as something to click. */
  .move { color: var(--accent); text-decoration: underline; text-underline-offset: 0.15em; font: inherit; }
  .move.current { font-weight: 600; }
  .stream { white-space: pre-wrap; }
  /* The card's padding is its spacing: no extra paragraph margin above its first line. */
  .card > p:first-child { margin-top: 0; }
  progress { width: 100%; }
  h2 { font-size: 1rem; margin: 0.2rem 0 0.4rem; }
</style>
