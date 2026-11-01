# Exploring a position

Every board that shows a position to learn from takes moves, so the Player can try their own idea
and get back in one step (`docs/design/interface-guidelines.md`, "Exploring a position"): the
Review, a Lesson once it is complete, a Puzzle once it is solved or shown, an Engine Game once it
is over, and the Board after stepping back. The state lives in
`packages/web/src/lib/variation.svelte.ts`; the game's own line never changes.

**Reached from:** a move on the `Review board` (before or after the Review is made), on a
Lesson's board once `Lesson complete` shows, on the `Puzzle board` after solving or
`Show the solution`, on the `Engine Game board` once the game is over, or on the Board after
`Previous move`.

## Sub-features

- A move that isn't the game's own next move starts a **variation** from the position on the
  board. The list `Moves` shows it on a row of its own, under the move it branches from: the list
  `Variation from move 10… dxe4` (or `Variation from the start`), each move a button
  `Variation move 11. axb4, Best`. The game's moves stay. A Puzzle writes it out as
  `Your variation` under its solution; a Lesson has no move list.
- The game's own next move steps along the game, as on Lichess, also from the variation's first
  position, which leaves the variation.
- The browser's Engine grades each variation move on screen (ADR 0007): its Move Grade badge in the
  list and its symbol on the board. In the Review the Winning Chances bar follows the variation from
  those grades; at the variation's first position it shows the game's, and a move the Engine can't
  grade reads `Winning Chances bar: not graded in this variation`.
- The step buttons and their keys walk the variation while it shows. `Back to the game` (in the
  Review and a finished Engine Game; `Back to the main line` on the Board, `Back to the Puzzle`,
  `Back to the Lesson`) drops it and puts the board back where the Player left the game, an open key
  moment included. Picking a move in the game's list, a key moment, an overview move or the graph
  leaves the variation for that position.
- A Why Question (in the Review, on the Board, a complete Lesson and a finished Puzzle; a finished
  Engine Game's Review takes them) about a variation move sends only the moves (the game's up to the branch, then the
  variation's) and the move: the desktop's Engine works out the Coach's facts, and a Review's
  `gameId` is left out, so no Review score is quoted for a position the game never had. While the
  desktop can't be reached, the Coach panel says so and takes no question.
- Within a variation, a different move after stepping back replaces the variation's later moves;
  it never touches the game's line.
- Where moving is not allowed, a refused move says why beside the board: during a Lesson
  ("Press Continue for the Lesson’s next move.", "Try another move, or continue with the Lesson’s
  move.", "The Engine is grading your move."), while a Puzzle's reply is played, and during an
  Engine Game ("It’s the Engine’s move.", "Take the move back or carry on first.").

## Proof

`e2e/journeys/explore.spec.ts`:

- Review of game 1: the Review opens on 11. Bxf7+; `a3b4` on the board shows the position after
  axb4, `Back to the game`, and `Variation move 11. axb4, Best` (or Good) in
  `Variation from move 10… dxe4`, with all 48 game moves still listed. A reply carries it on;
  `Previous move` and `First position` walk it. A Why Question about axb4 writes one `why` row to
  `coach_calls` whose brief names axb4. `Back to the game` shows the moment's position again with
  `Show moment: move 11. Bxf7+, Mistake` still pressed. `c4f7` from there steps the game
  (`Mistake on f7`, no variation); `Move 12. Bg5, Mistake` leaves a variation.
- Before the Review is started, `d2d4` shows `Variation from the start`, and `Back to the game`
  returns to the start.
- Skewers, resumed at its last decision: waiting on Continue, a click on a piece says
  "Press Continue for the Lesson’s next move."; after `Lesson complete`, a move plays on the final
  board, `Previous move` returns, and `Back to the Lesson` goes.
- A shown Puzzle: from `First position` a move that isn't the solution's shows one button in
  `Your variation`; `Back to the Puzzle` drops it; the solution's own move steps the solution.
- A resigned Engine Game: a move on the final board shows a one-move variation;
  `Back to the game` returns; from `Previous move` the Engine's own reply steps the game.
- The Board: after 1. e4 e5 2. Nf3 and two steps back, 1… c5 keeps all three moves and shows
  `Variation from move 1. e4`; `Back to the main line` returns; e5 steps along the line, and a move
  at its end extends it.
