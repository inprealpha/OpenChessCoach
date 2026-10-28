# Review

Every move of a game graded by the desktop's Engine (ADR 0007), then the key moments (the worst
few of the Player's moves) explained by the Coach, one call per moment. A saved Review reopens
with no Coach call.

**Reached from:** Main menu → `Review your games` (`#/games`) → `Review: …`, the end of an Engine Game (`Review this game`), or
`#/review/<gameId>`.

## Sub-features

- `Start the Review`: grading progress as the desktop reports each position analysed, then the
  region `Key moments` streams in. The button is disabled from the first click, and a second
  `review.start` for a game whose Review is being made waits for that one, so a double click
  makes one Review with no error.
- A Review being made goes on while the Player is on another screen: coming back (inside the
  app, no reload) shows its progress again, not `Start the Review`, and it finishes there with no
  second `review.start` (the device keeps the request in `packages/web/src/lib/review-runs.svelte.ts`).
- A Review being made outlives the page too: a reload or a closed tab leaves the desktop to finish
  and save it, because a Review stops only when the desktop app closes, never with the connection
  that asked for it. Reopened while it is being made (`review.get` says `beingMade`), the screen
  asks again, which joins it: "Grading move N of 48…" from where it has got to, then the key
  moments, with no `Start the Review`.
- With the desktop away, the note "Reviews live on your desktop, which can’t be reached right
  now. This one opens here once it is back." with the game's line from the list this device kept,
  instead of "Loading the game…"; the Review opens by itself when the desktop is back.
- A game that can't be loaded, such as one deleted from the game list, says why ("That game is not
  in your game list.") and offers `Back to the menu`.
- A connection that drops and comes back leaves the screen as it was: the open key moment and the
  position on the board stay (the screen loads once per game, never on a reconnect). A Review
  being made says "The connection to your desktop dropped. The Review goes on once it is back.",
  asks the desktop again once it is back (which returns the finished Review, joins the one still
  being made from where it has got to, or starts over if the desktop was restarted) and finishes
  with no click; after five drops it stops and says so, with `Start the Review`. (`offline.spec.ts`,
  "a connection that drops and comes back …", "a Review being made rides out a dropped
  connection …" and "… rides out a blip with the desktop still up …".)
- A game with no key moments says why, in words that fit a win ("A clean game: …"), a short game
  the Player didn't win, under 10 of their moves, such as one resigned in the opening ("A short
  game, with no key moment to walk through: …"), or a longer loss or draw ("None of your moves was
  graded Inaccuracy or worse while the game was still open, …").
- The step buttons step from the position on the board: from an open key moment (the position
  before its move) `Next move` plays that move and `Previous move` goes one move back.
- On a phone the key moments and the moves sit under the board: picking one brings the board back
  into view (smoothly, unless the Player asked for reduced motion). Beside the board, as on a
  desktop, the page stays where it is, and the board's column stays in view as the page scrolls
  on a screen at least 800px tall, so a key moment picked low on the page shows on a whole board.
- The move list numbers moves from the game's start position, so a game set up from a position
  (`[SetUp "1"]`, `[FEN …]`) reads `40… Kd3`, `41. Ra3+`, as the key moments and the graph do.
- Each key moment: a button `Show moment: move N. <SAN>, <Move Grade>`, a Move Grade badge, the
  Player's Winning Chances before and after their move with the evaluation beside them
  ("Before: White’s winning chances: 48% -0.20", "After 11. Bxf7+: White’s winning chances: 35%
  -1.72"; a forced mate reads as a mate phrase such as "White mates in 3"), "Better: …" with the
  Engine's options, each with its Winning Chances and evaluation, and the Coach's explanation.
  Winning Chances come from the Review's own graded moves: no new data and no Engine run. The
  `Show moment` button opens the moment on the board (the position before the move, with the
  Coach's arrows; `aria-pressed` true) and a second click closes it.
- Review arrows on every move the board shows, drawn from the Review's graded moves with no
  Engine run: the img `Move played: <SAN>, <Move Grade>` in the Move Grade's color and the img
  `Engine’s best: <SAN>` in green, or one green img `Move played: <SAN>, <Move Grade>, the Engine’s
  best` when they are the same move. While a key moment is open, or the Coach has answered a Why
  Question on this move, only the Coach's arrows (`Arrow <from> to <to> (<brush>)`) show: no
  Review arrows and no threat arrow.
- The meter `Winning Chances bar: …` beside the board (see `board-and-engine.md`), with the
  Player's side at the bottom. It follows the board through the game from the Review's own
  graded moves: no Coach call and no Engine run. One number per position: the bar, the graph and a
  key moment's "Before" and "After" all read `scoreAfterPly` (`packages/shared/src/position-score.ts`),
  the score that graded the move reaching the position (the Engine's best line at the start), so
  they always agree with each other and with the Move Grades. An open key moment shows the position
  before its move, so the bar there agrees with the moment's "Before". Until the Review is done it reads
  `Winning Chances bar: shown once the Review is done`.
- The move list with every Move Grade, kept scrolled to the current move; a Why Question on any move.
- The step buttons and Lichess's keys for them (← → one move, Home or ↑ the start, End or ↓ the
  end; see `board-and-engine.md`), with or without a Review. On the graph's slider its own keys
  win: there ↑ is a step forward (`imported-game.spec.ts`, "in a Review, the arrow keys step …").
- Move Grade symbols on the board: stepping to a graded move (either side's) draws its symbol in
  the corner of the square it landed on, an image named like `Mistake on f7`: `?!` Inaccuracy, `?`
  Mistake, `??` Blunder, a star for Best, in the Move Grade's badge colors. Good moves and the
  start position get none. An open key moment shows the position before its move, so the symbol
  is the one of the move that reached that position, as is the graph's current point.
- The Winning Chances graph, under the board: the figure `Winning Chances graph` plots White's
  Winning Chances for every position of the game (the start, then after each move), as on Lichess,
  from the Review's own graded moves: no Coach call and no Engine run, so a saved Review shows it on
  reopening. Winning Chances run from 0 to 100, so a mate or a huge evaluation never flattens the
  rest. Mistakes and Blunders by either side are buttons in their Move Grade's color, named like
  `Mistake by White, move 11`; Inaccuracies are not marked. A click on a mark, or anywhere on the
  slider `Move on the Winning Chances graph` (arrow keys, Home and End too), jumps the board there.
  The current move is the image `Current position: 12. Bg5: White’s winning chances: 19%`, and a
  hover or tap reads the point under the pointer below the graph.
- `Threat` (off by default, remembered on the device): a red arrow with the opponent's threat in
  the position on the board, from the desktop's Engine (`engine.threat`, ADR 0007); see
  `board-and-engine.md`. Works before the Review is started too.
- The Player Profile's Move Grade counts update, and the Coach may add one note.
- With Think deeper on in Settings, each key moment's Coach call may ask the desktop's Engine up to
  3 questions (see `why-question.md`); the fake Coach asks one each, logged in `coach_questions`
  (`think-deeper.test.ts`).

## Drive

```bash
$C review --game 1        # positionsGraded: 49, coachCalls: 4, moments: Bxf7+ and Bg5 (Mistake), d5 and Bxc5 (Inaccuracy)
$C review --game 1        # reopened: true, coachCalls: 0
$C db get reviews
$C screenshot --route "#/review/1" --wait 3000
```

Browser, after the Review: `Move 11. Bxf7+, Mistake` in the list `Moves`, then `Next move`.

## Proof

- `review --game 1` on the default seed reports `positionsGraded: 49` (the start and every move)
  and lists exactly those four key moments.
- `reviews` has one row for the game; reopening adds no `review-moment` rows to `coach_calls`.
- After a double click on `Start the Review`: no alert, one `reviews` row, and `grade_counts`
  counted once.
- `grade_counts` has rows for Italian Game.
- The `Winning Chances graph` marks exactly `Mistake by White, move 11` and
  `Mistake by White, move 12`, before and after a reopen. Clicking `Mistake by White, move 12`
  shows `Mistake on g5` on the board and `Current position: 12. Bg5: White’s winning chances: 19%`;
  `Next move` moves it to `12… Qd5: White’s winning chances: 16%`; a click on the graph's left
  edge goes back to `Start: White’s winning chances: 53%` (`imported-game.spec.ts`, "a Review
  lists key moments …"). Marks for Black, mates and huge evaluations are covered on real games in
  `packages/shared/test/winning-chances-graph.test.ts`.
- The moment 11. Bxf7+ shows `Before: White’s winning chances: 48% -0.20`,
  `After 11. Bxf7+: White’s winning chances: 35% -1.72` and
  `Better: axb4 48% (-0.20), Ng5 44% (-0.67), Ne5 44% (-0.68)`, before and after a reopen
  (`imported-game.spec.ts`, "a Review lists key moments with Move Grades, …").
- On the `Review board`: `Move 11. Bxf7+` shows the image `Mistake on f7`; `Next move` shows
  `Best on f7` (11… Rxf7) and then `Mistake on g5` (12. Bg5), one symbol at a time;
  `Move 10. a3` (Good) and `First position` show none; 16… Nc6 shows `Inaccuracy on c6`.
- On `#/review/1` after the Review, move `11. Bxf7+` shows `Move played: Bxf7+, Mistake` (stroke
  `#8a3d00`) and `Engine’s best: axb4` (stroke `#15781b`); `5. d4` shows one arrow,
  `Move played: d4, Best, the Engine’s best`. `Show moment: move 11. Bxf7+, Mistake` swaps them for
  the Coach's arrows; clicking it again brings them back. After a reload they show again and the
  browser sends no `engine.*` or `review.start` request.
- After a reopen the Winning Chances bar reads `White’s winning chances: 53%` at the start, 48%
  at the moment 11. Bxf7+, 35% one move on and 4% at the last position, with no new
  `coach_calls` row (the same journey).
- One number per position (`imported-game.spec.ts`, "a Review shows one number per position, …"):
  after 12. Bg5 (the Engine's fourth line) the bar, the graph's current point and the moment's
  `After 12. Bg5: White’s winning chances: 19% -3.88` all read 19%. With Threat on, `Move 10… dxe4`
  shows `Best on e4`, the graph at `10… dxe4` (48%) and one threat arrow; opening
  `Show moment: move 11. Bxf7+, Mistake` keeps that symbol, graph point and bar, shows the Coach's
  arrows and no threat arrow; closing it shows `Mistake on f7` and `11. Bxf7+` (35%).
- With Threat on, after `Move 9… d5` of game 1 the arrow names Black's dxc4 or dxe4, exactly what
  `engine.threat` answers for that position (`imported-game.spec.ts`).
- From the open moment 11. Bxf7+ (graph at `10… dxe4`), `Next move` shows
  `Current position: 11. Bxf7+: White’s winning chances: 35%` and `Mistake on f7`; from the open
  moment again, `Previous move` shows `10. a3` (`imported-game.spec.ts`, "from an open key moment …").
- At 390×844, tapping the third key moment or `Move 16… Nc6` leaves the `Review board`'s top in the
  top half of the viewport; at 1280×800, scrolled to the bottom, picking the fourth key moment
  leaves the whole board on screen (`imported-game.spec.ts`, "on a phone, …").
- A pasted game from `[FEN "8/8/8/8/8/4k3/8/R3K3 b - - 0 40"]` lists `Move 40… Kd3`,
  `Move 41. Ra3+`, `Move 41… Kc4`, `Move 42. Kd2` (`imported-game.spec.ts`).
- Leaving a Review being made for the menu and coming back shows its progress, then the key
  moments, with one `review.start` frame and one `reviews` row (`imported-game.spec.ts`,
  "a Review being made …"). Offline, `#/review/1` shows the note and no "Loading the game…", and
  `Start the Review` once the desktop is back (`offline.spec.ts`).
- Reloading mid-Review, with the desktop's Engine held, reopens on "Grading move N of 48…" (N above
  0), never `Start the Review`; it finishes there with its first key moment open, two
  `review.start` frames (the second joined the first), one `reviews` row and four `review-moment`
  rows in `coach_calls` (`imported-game.spec.ts`, "a Review being made › goes on through a
  reload …"). A connection dropped with the desktop up gets progress on the new connection and
  finishes with no alert and one Review (`offline.spec.ts`, "… rides out a blip with the desktop
  still up …"). On the protocol: `games.test.ts`, "asked again on a new connection after a drop
  …", "finishes and saves a Review nobody is waiting for …" and "stops a Review when the desktop
  app closes".

## Gotchas

- Reviews grade on the desktop's Engine, never in the browser, so a Review needs the desktop.
  The browser and coachctl only ask for it.
- A Review's Move Grades are the record that counts. They can differ slightly from those shown
  during an Engine Game, which come from the browser's Engine. In verify mode both run
  single-threaded at the same fixed depth.
- Each key moment's brief gets the tempting moves of its position (ADR 0011), from the game's own
  moves: `coach_tempting` has one row per key moment, joined to its `coach_calls` row by `call_id`
  (`tempting-moves.test.ts`).
