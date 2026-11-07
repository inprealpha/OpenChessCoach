# Board and Engine

An accessible board where every move is graded by Stockfish running in the browser (ADR 0002,
ADR 0007). Move Grades use the Lichess formula (Best, Good, Inaccuracy, Mistake, Blunder), with one floor: giving up 3 pawns or more against the best move is at least a Mistake, even in a decided game, unless the Engine still sees a forced mate after the move (ADR 0002).

**Reached from:** the small `Board` link under the main menu's three choices (`#/board`).

## Sub-features

- Move by clicking two squares or dragging; promotion asks for a piece. The king clicked (or
  dragged) onto its own rook castles, as on Lichess (`board.spec.ts`, "the king castles when …").
- Illegal moves are refused, with the reason under the board when it is about the Player's own
  king: "Your king is in check, and that move doesn’t get it out of check.", "Your king can’t go to
  e2: it would be in check there." or "Your knight on e2 is pinned to your king by the rook on e8:
  moving it would put your king in check."; otherwise "That move isn’t legal." (`illegalReason` in
  `packages/shared/src/chess.ts`, `chess.test.ts`; `board.spec.ts`, "an illegal move says why …").
  The Board is shared, so Lessons, Puzzles and Engine Games say the same.
- When the position on the board ends the game, the status `Result` under the toolbar says how
  ("Checkmate. White wins.", a stalemate or a draw); stepping back empties it (`board.spec.ts`, "the
  Board says when the game is over, …").
- Pieces slide to their new square (180 ms) when the position changes by exactly one move: the
  board's last move played (a clicked move, the Engine's reply, `▶`) or taken back (`◀`, a
  takeback); castling slides king and rook, a promotion slides the pawn in as its new piece, even
  when dragged. Anything else shows at once: a dragged piece (already there), `New board`, a jump
  through the moves, opening or closing a key moment, the next Puzzle; and nothing slides when the
  device asks for reduced motion. A step taken back mid-slide draws a captured piece straight back
  on its square. Square names change at once (`board.spec.ts`, "a move slides its piece; …",
  "en passant slides …", "the Engine’s reply …", "a step taken back before its slide ends …" and
  "in a Review, a step slides its piece …").
- The list `Moves` shows each move with its Move Grade badge; clicking a move shows that position.
  The list scrolls itself (never the page) to keep the current move in view, again once a move's
  Move Grade badge arrives and widens it (`board.spec.ts`, "on a phone, the move list keeps the
  move just played in view …").
- `Set up a position` (on the Board) opens the form `Set up a position`: paste a FEN and the board
  shows that position from the side to move; paste a PGN (headers optional, `[FEN]` set-ups too,
  and a `[FEN]` with no moves is that position) and the list `Moves` fills with its moves from
  the first position, each graded once the Player stops on it. The Engine is asked about a
  position only after the Player has stayed on it for 200 ms (a move they play, at once), so
  holding → asks only where they stop. Playing the game's own next move steps to it and keeps the
  rest; any other move after stepping back starts a variation and keeps the rest too (see
  `explore.md`). `New board` on a board with moves asks first: the alert dialog `Clear this board?` with
  `Keep this board` and `Yes, a new board`. A FEN or PGN that can't be read shows its error in the form (an alert) and leaves the
  board as it was: a board with no side to move or castling field, a link, a position no game can
  reach (more than 8 pawns, or more promoted pieces than the missing pawns allow) and castling
  rights standard chess can't have are refused or dropped. Set up and Cancel put focus back on
  `Set up a position`, and a hidden status says what was set up (`Position set up: Black to
  move.`). `#/board?fen=<FEN, URL-encoded>` opens the Board on that position; `New board`, or a
  position set up after it, drops the `?fen=` from the address and turns the board back to the
  side the Player chose.
- A position whose game is over but where moves can still be played (insufficient material, the
  fifty-move rule) says so in `Result`, adding "Moves played from here get no Move Grade.", and
  its moves stay ungraded.
- The step buttons `First position`, `Previous move`, `Next move`, `Last position`, and Lichess's
  keys for them anywhere on the page (`aria-keyshortcuts` on each button): ← and → one move, Home
  or ↑ the start, End or ↓ the end. The keys do nothing while the Player types (the Why Question
  box), while a dialog or a menu is open, with a modifier held, or while the Board's tabs have the
  keyboard's focus (below), and Alt+← reaches the browser unhandled (`board.spec.ts`, "the arrow
  keys step through the moves …" and "the arrow keys do nothing while the promotion dialog is open
  …"). One component, `StepButtons.svelte`, serves the Board, the Review and an Engine Game, during
  play and once it is over (see `engine-game.md`).
- The move that reached the position on the board shows its Move Grade symbol in the corner of
  the square it landed on, named like `Blunder on f6` (none for Good moves or the start position);
  1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 shows `Blunder on f6`, and it follows `Previous move`, `Next move` and
  `First position` (`board.spec.ts`, "a graded move on the Board shows its Move Grade symbol, …").
- The panel has the tabs `Lines`, `Moves` and `Coach` (the tablist `Board`, the guidelines' Board
  recipe, #52), the one the Player picks remembered on the device (`Moves` on a new device, or
  `Lines` where the Player had the old `Show Engine lines` on); a tab opens at its top. `Moves` holds
  the list `Moves` ("Play a move on the board, or set up a position, and its moves list here." while
  it is empty). The Ask box is docked under every tab; asking a question opens `Coach` (without
  changing the tab remembered for next time), whose conversation then fills the panel down to the
  Ask box (CoachPanel's `fill`; "Ask the Coach why below: its answers show here." before the first
  answer). On that tab the Coach is the tab's panel (`tabpanel "Coach"`, `#panel-coach`, which the
  tab's `aria-controls` names), on the others its own region `Coach`. The tabs are
  `PanelTabs.svelte`, the same component and look as the Review's (its Moments, Moves and Overview
  take the same keys): Tab reaches the picked tab only, and once the keyboard brought the focus
  there, ← → Home End move between the tabs and pick them, wrapping at the ends, and the board
  doesn't step; after a tab is clicked or tapped, ← → still step the board. A Why Question on the
  Board quotes White's Winning Chances, as its bar and lines name them, after a Black move too
  (`chancesSide: 'white'` in the Coach request; the brief's `winningChances` are then White's).
- `Lines` holds the region `Engine lines` with the Engine's top lines. Each line leads with White's
  Winning Chances after it ("53%", or a mate phrase such as "Black mates in 1"), whoever is to move,
  as on the bar and the Review's graph, with the evaluation ("+0.38") smaller beside it, then its
  first six moves with their numbers, as a scoresheet writes them ("14. Nxd5 Qxd5 15. c4", "14… Qxd5"
  when Black starts; `engineLineView` in `packages/shared/src/engine-lines.ts`). Only the top line
  shows until `More lines (4)` (remembered on the device; `Fewer lines` folds them again); under the
  lines, "White’s winning chances · Depth 10". A line's accessible name reads
  `Engine line 1: 1. e4, White’s winning chances: 53%, +0.38`. Each move is a button named like
  `Try 1. e4 e5 2. Nf3 on the board`; the best line's first move is in green. Pointing at a move
  with a mouse (or focusing it) shows the position after it on the board, with the header line
  reading `Engine line: 1. e4 e5 2. Nf3`, a hidden status "On the board: 1. e4 e5 2. Nf3", and no
  other arrows, marks or Move Grade symbol; a click, a tap or Enter plays the line up to it as a
  variation (the group `Your own line`, `Back to the main line`), where the game's own next move
  steps along the game instead. Under the lines: "Point at a move to see it on the board; click to
  try the line." (on a touch screen, "Tap a move to try the line on the board."). The pointer and
  the focus each keep their own preview: leaving a hovered move goes back to the focused one. A
  preview ends with the position, a line the deeper search changed, or the lines leaving the screen
  (another tab picked with the keyboard). Tabs, lines and previews make no Coach call.
  On a phone each line is one row of 44 px buttons that scrolls sideways, every move whole, and the
  board gives up a little (`--phone-reserve: 19.25rem`) so the top line sits whole above the Ask box
  at 390×664. While `Lines` is open, the best line's first move is the green arrow
  `Engine’s best: 1. e4` (`bestLineArrow` in `lib/arrows.ts`), and the Coach's arrows wait for the
  other tabs, so one green arrow shows at a time.
  Winning Chances come from the shared formatter `packages/shared/src/winning-chances.ts`: the
  Grader's winning chances as a percentage, so they always agree with the Move Grades.
- The meter `Winning Chances bar: White’s winning chances: 53%` stands beside the board: White
  and Black fill it in proportion to the position's Winning Chances, with each side's percentage
  at its end ("47%" at the top, "53%" at the bottom; a mate shows "M1" at the winner's end only).
  On the Board its name is always White's, as on the Engine lines (its `names` prop, #52), while its
  fill flips with the board (`Flip board`: Black fills it from the bottom, and the name stays
  White's); a Review's and an Engine Game's names the side at the bottom of the board, the Player's
  until `Flip board`, as their key moments and Coach do (a Review of a game the Player had as Black
  reads `Black’s winning chances` on the bar, the key moments and the Coach); a mate reads
  `Winning Chances bar: Black mates in 1`, a checkmate on the board `Black has checkmated`. It
  comes from the browser Engine's best line for the position shown (the same as `Engine line 1`,
  ADR 0007), follows `◀ ▶ ⏮ ⏭` with no Coach call, and works with the desktop off. Where beside
  the board doesn't fit (a phone), it lies above the board, as wide as the board, the bottom side
  filling from the left. It also shows in Engine Games and Reviews, never in Lessons or Puzzles
  (`packages/web/src/components/WinningChancesBar.svelte`; `offline.spec.ts` reads it with the
  desktop off).
- `Show threat` (a toggle, `aria-pressed`, off by default and remembered on the device) draws a
  red dashed arrow (`--arrow-threat`, `data-kind="threat"`, under any other arrow) named
  `Threat: <Side> threatens <SAN> (<from> to <to>)`: the opponent's best move if they could move
  now, from the browser's Engine searching the position with the side to move swapped (a null
  move). No arrow when the side to move is in check, when the move is not a
  capture, check or promotion, or when it would cost less than an Inaccuracy's worth of winning
  chances. With it on and no arrow, the status "No threat" says the Engine found none. The same
  button and arrow are on the Engine Game and Review boards.
- Every board screen is one frame (`docs/design/interface-guidelines.md`): the header names the
  screen and one line of context ("White to move") with the board's tools at its end (`Flip board`
  (F), `Show threat`, and on the Board `Set up a position` and `New board`), the thumb bar at the
  panel's foot holds the step buttons either side of the Ask box, the panel beside the board scrolls inside itself on
  a desktop and under it on a phone, and the Coach's Ask box is docked at its foot: the page
  itself is one screen tall and never scrolls, so a choice at the panel's top (Continue, Take the
  move back) is never under the board or the Ask box. Phone controls are at least 44 px tall. Each arrow colour has one meaning (ink played, green best,
  blue other good move, red dashed threat, solid red a move that went wrong, orange the opponent's
  reply, `packages/web/src/lib/arrows.ts`),
  and the list `Arrow colours` under the board names the ones on it.
- In verify mode the Engine runs at depth 10, 5 lines, one thread: the same moves always get the
  same evaluations and Move Grades.
- Outside verify mode the multi-threaded Engine is tried first; if it can't start (an error or no
  answer within 20 s) the single-threaded Engine is tried once, and if that fails too an alert under
  the header says the Engine couldn't start. The board keeps working without Move Grades.

## Drive

- Browser: click `e2, white pawn` then `e4, empty`. Each square is a button named
  `<square>, <colour> <piece>` or `<square>, empty`.
- coachctl: `$C play --moves "e4 Nf3 Bc4" --resign` prints each move's Move Grade.

## Proof

- 1.e4 is graded Best; 1.e4 d5 2.Nf3 is graded Blunder; 1.g4 is graded Mistake.
- The same line played twice (two runs, or browser and coachctl) gives identical grades
  (`board.spec.ts`, "the Engine grades every move, and finds the threat, the same way on every
  run").
- In verify mode the board's `Engine lines` (depth, moves, evaluations, continuations) match
  `engine.analyse` from the desktop for golden positions (`board.spec.ts`, "the browser Engine
  shows the same lines as the desktop Engine for golden positions").

- With Threat on, 1.e4 e5 2.Qh5 Nc6 3.Bc4 shows `Threat: White threatens Qxf7# (h5 to f7)`;
  3...g6 changes it to `Threat: Black threatens gxh5 (g6 to h5)`; 1.e4 e5 2.Nf3 shows
  `Threat: White threatens Nxe5 (f3 to e5)`; the choice survives a reload, and with it off there
  is no arrow (`board.spec.ts`, "the Threat button shows the opponent’s threat…").
- The threat after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 is `Threat: White threatens bxc5 (b4 to c5)`
  on two runs (`board.spec.ts`, "the Engine grades every move, and finds the threat, the same way
  on every run"). `packages/backend/test/threat.test.ts` holds the golden positions (a threat, a
  quiet position, a position in check) on both Engines.
- A threat query costs one more search at verify mode's depth (the position itself is already
  analysed): about 90 ms on average on the golden positions, single-threaded.
- At the start position in verify mode, `Engine line 1` is named
  `Engine line 1: 1. e4, White’s winning chances: 53%, +0.38`; after 1. e4 it is
  `Engine line 1: 1… e6, White’s winning chances: 53%, +0.37` (`board.spec.ts`, "the Engine lines
  lead with White’s Winning Chances whoever is to move, …"). With Black to move from a `?fen=` link
  (the board turned to Black's side) the bar and line 1 give the same White's percentage ("with
  Black to move, the bar and the Engine lines both give White’s Winning Chances").
- At 1280×800, 390×844, 402×714, 440×790 and 390×664 the tablist `Board` reads `Lines, Moves,
  Coach`, every tab wholly on screen; `Moves` shows the move list, `Lines` the top line on the
  first screen with `More lines`, `Coach` the conversation with the Ask box and the board on screen,
  the page never scrolls, and the tab picked is the one after a reload ("the Board’s panel has
  Lines, Moves and Coach tabs at desktop and phone sizes, and remembers the one picked"). A question
  asked from `Lines` opens `Coach`, the conversation takes over 60% of the panel, and after a reload
  the Board opens on `Lines` again ("asking the Coach opens the Coach tab, where the answer takes the
  panel’s room"); `Coach`'s `aria-controls` names the `tabpanel` holding the conversation, and on
  `Moves` it is the region `Coach` again ("the Coach tab’s panel is the Coach itself, …").
- With the focus brought by the keyboard, → on `Moves` picks `Coach`, then wraps to `Lines`, End
  and Home jump, and the board never steps; after a mouse click on a tab, ← and → step the board
  ("the arrow keys move between the Board’s tabs while one has the focus, and step the board
  otherwise").
- `Lines`' top line reads the desktop Engine's line with move numbers ("1. e4 e5 2. Nf3 …");
  hovering the third move puts the board on the position after it and the header line on
  `Engine line: 1. e4 e5 2. Nf3`, with no `Engine’s best` arrow, and moving away puts back the start
  and "White to move"; focus previews too, Enter tries the line (`Your own line`), and a click on
  the second move tries the line up to it ("an Engine line’s moves are numbered buttons: pointing at
  one shows it on the board, and a click tries the line"). A focused move stays on the board after
  the pointer passes over another and leaves ("a move kept in focus stays on the board …"); ← under
  a hovered move, or → on the tabs to `Moves`, ends the preview ("a preview ends when the position
  or the tab changes under the pointer: …"). On a 390×664 touch phone each move is at least 44 px
  tall and a tap tries the line ("on a touch phone, tapping an Engine line’s move tries the line on
  the board"); at 390×664 and 402×714 the top line sits whole above the Ask box and with
  `More lines` every line's last move scrolls into reach and plays ("on a short phone the top Engine
  line sits whole above the Ask box, …").
- `Engine’s best: 1. e4` (`data-kind="best"`, "best" in `Arrow colours`) shows only on `Lines`, then
  `Engine’s best: 1… e6` after 1. e4 ("the best line’s first move is drawn as the Engine’s-best arrow
  while the Lines tab is open"). After a Why Question each tab has one green arrow: the Coach's on
  `Coach` and `Moves`, the Engine's best on `Lines` ("after a Why Question, each tab shows at most
  one green arrow: …").
- After 3… Bc5 the Coach says "Bc5 is graded …. Before it, White’s winning chances: 54%. After it,
  White’s winning chances: N%.", N the bar's, and never "Black’s winning chances" ("the Coach
  quotes the Winning Chances the bar shows either side of the move").
- The Winning Chances bar reads `Winning Chances bar: White’s winning chances: 53%` at the start
  and after 1. e4, matches `Engine line 1` after 1. e4 g5, follows `Previous move`, `First
  position` and `Last position` with no `coach_calls` row, and after `Flip board` still names
  White's while Black fills it from the bottom (`board.spec.ts`, "the Winning Chances bar beside the
  board matches the Engine lines, follows the moves and fills from the bottom side when flipped").
  After 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 it reads `White’s winning chances: 48%` on two separate
  runs ("the Engine grades every move, and finds the threat, the same way on every run"). After
  1. f3 e5 2. g4 it reads `Black mates in 1` with "M1" on it ("a mate shows on the Winning Chances
  bar as a mate, …"). At 390 px wide it lies above the board, as wide as the board ("the Winning
  Chances bar stands beside the board, and above it on a phone"). A Review of a game the Player had
  as Black names Black's on the bar, the key moments and the Coach (`imported-game.spec.ts`, "a
  Review of a game the Player had as Black names Black’s Winning Chances …").
- With the Engine's files blocked, the alert appears and moves can still be played
  (`board.spec.ts`, "when the Engine can’t start, the Player is told instead of left waiting").
- Setting up `6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1` shows it with `Engine line 1: 1. Rd8#…` and the
  bar `White mates in 1`; a PGN of 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 fills six moves and → → shows the
  position after 1…e5; `#/board?fen=` with a Black-to-move FEN opens it with `data-orientation`
  black; `8/8/8/8 w - - 0 1` is refused (`board.spec.ts`, "setting up a position"). Holding →
  40 times through a 49-move game searches about three positions, each once ("holding → through a
  pasted game, …", which counts the `position fen` commands sent to the Engine's Worker).

## Gotchas

- The board's Move Grades and Engine lines come from the browser's Engine; a Why Question about a
  move goes to the desktop, whose Engine works out the facts (see `why-question.md`).
- Grades appear only once the Engine finishes; wait for the badge, not for the move.
- The threat arrow appears after the Engine's search of the position and of its null move; wait
  for the arrow by name. Coach arrows are named `Arrow …`, so `/^Arrow /` never matches it.
- The board label differs per screen (`Board`, `Lesson board`, `Puzzle board`, `Engine Game board`).
