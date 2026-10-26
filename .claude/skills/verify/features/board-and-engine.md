# Board and Engine

An accessible board where every move is graded by Stockfish running in the browser (ADR 0002,
ADR 0007). Move Grades use the Lichess formula (Best, Good, Inaccuracy, Mistake, Blunder), with one floor: giving up 3 pawns or more against the best move is at least a Mistake, even in a decided game, unless the Engine still sees a forced mate after the move (ADR 0002).

**Reached from:** the small `Board` link under the main menu's three choices (`#/board`).

## Sub-features

- Move by clicking two squares or dragging; illegal moves are refused; promotion asks for a piece.
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
  rest. A FEN or PGN that can't be read shows its error in the form (an alert) and leaves the
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
  box), while a dialog is open or with a modifier held, and Alt+← reaches the browser unhandled
  (`board.spec.ts`, "the arrow keys step through the moves …" and "the arrow keys do nothing while
  the promotion dialog is open …"). One component, `StepButtons.svelte`, serves the Board, the
  Review and a finished Engine Game.
- The move that reached the position on the board shows its Move Grade symbol in the corner of
  the square it landed on, named like `Blunder on f6` (none for Good moves or the start position);
  1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 shows `Blunder on f6`, and it follows `Previous move`, `Next move` and
  `First position` (`board.spec.ts`, "a graded move on the Board shows its Move Grade symbol, …").
- `Show Engine lines` opens the region `Engine lines` with the Engine's top lines. Each line leads
  with the side to move's Winning Chances after it ("53%", or a mate phrase such as "White mates
  in 3"), with the evaluation ("+0.38") smaller beside it. A line's accessible name reads
  `Engine line 1: e4, White’s winning chances: 53%, +0.38`. Winning Chances come from the shared
  formatter `packages/shared/src/winning-chances.ts`: the Grader's winning chances as a
  percentage, so they always agree with the Move Grades.
- The meter `Winning Chances bar: White’s winning chances: 53%` stands beside the board: White
  and Black fill it in proportion to the position's Winning Chances, with each side's percentage
  at its end ("47%" at the top, "53%" at the bottom; a mate shows "M1" at the winner's end only).
  Its name names the side at the bottom of the
  board, so it flips with the board (`Flip board`: `Black’s winning chances: 47%`); a mate reads
  `Winning Chances bar: Black mates in 1`, a checkmate on the board `Black has checkmated`. It
  comes from the browser Engine's best line for the position shown (the same as `Engine line 1`,
  ADR 0007), follows `◀ ▶ ⏮ ⏭` with no Coach call, and works with the desktop off. Where beside
  the board doesn't fit (a phone), it lies under the board, as wide as the board, the bottom side
  filling from the left. It also shows in Engine Games and Reviews, never in Lessons or Puzzles
  (`packages/web/src/components/WinningChancesBar.svelte`; `offline.spec.ts` reads it with the
  desktop off).
- `Threat` (a toggle, `aria-pressed`, off by default and remembered on the device) draws a
  red arrow (`#d32f2f`, under any other arrow) named
  `Threat: <Side> threatens <SAN> (<from> to <to>)`: the opponent's best move if they could move
  now, from the browser's Engine searching the position with the side to move swapped (a null
  move). No arrow when the side to move is in check, when the move is not a
  capture, check or promotion, or when it would cost less than an Inaccuracy's worth of winning
  chances. The same button and arrow are on the Engine Game and Review boards.
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
  (`board.spec.ts`, "the Engine grades every move the same way on every run").
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
  `Engine line 1: e4, White’s winning chances: 53%, +0.38`; after 1. e4 it is
  `Engine line 1: e6, Black’s winning chances: 47%, -0.37` (`board.spec.ts`, "the Engine lines
  lead with the side to move’s Winning Chances, the evaluation beside them").
- The Winning Chances bar reads `Winning Chances bar: White’s winning chances: 53%` at the start
  and after 1. e4, matches `Engine line 1` after 1. e4 g5, follows `Previous move`, `First
  position` and `Last position` with no `coach_calls` row, and after `Flip board` names Black and
  fills from the bottom with Black (`board.spec.ts`, "the Winning Chances bar beside the board
  matches the Engine lines, …"). After 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 it reads `White’s
  winning chances: 48%` on two separate runs ("the Engine grades every move the same way on every
  run"). After 1. f3 e5 2. g4 it reads `Black mates in 1` with "M1" on it ("a mate shows on the
  Winning Chances bar as a mate, …"). At 390 px wide it lies under the board, as wide as the
  board ("the Winning Chances bar stands beside the board, and under it on a phone").
- With the Engine's files blocked, the alert appears and moves can still be played
  (`board.spec.ts`, "when the Engine can’t start, the Player is told instead of left waiting").
- Setting up `6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1` shows it with `Engine line 1: Rd8#…` and the
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
