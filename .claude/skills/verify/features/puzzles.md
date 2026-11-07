# Puzzle

Puzzles from the Lichess puzzle database (CC0), picked near the Player's rating or level, filtered
by Lesson: an opening's Puzzles by the opening, a Theme's or endgame's by Lichess's theme tags
(ADR 0008). A wrong move is shown as wrong and the Player retries. Stuck, the Player gets a Hint
from the Coach first, naming no move, and only then the solution.

**Reached from:** Main menu → `Learn` (`#/learn`) → `Puzzles` (`#/puzzles`), or `#/puzzles/<lessonId>` from a Lesson.

## Sub-features

- `Choose what to practise`, a disclosure under the heading, opens the navigation `Puzzles to
  practise`: a link per set, `Mixed: every Lesson` (the default, `#/puzzles`) then each Lesson with
  Puzzles in a list per track of the Lessons, in the Lessons' order (`Themes`, `Endgames`,
  `Openings`, `How to think during a game`; a track with no Puzzles is left out)
  (`#/puzzles/<lessonId>`), written like
  "Pins", then "25 Puzzles · 2 done (1 missed)"; the set shown is `aria-current="page"`. Missed counts only
  Puzzles that are done. Lessons without Puzzles are not offered. Beside it, this set's progress on
  the device: "Pins: 2 of 25 done (1 missed)." Only following a link changes the set (arrow keys
  don't), and focus comes back to `Choose what to practise` on the new set. On a phone the links
  wrap their names, and the progress line shares the choice's row (the set's name, which the
  heading gives, is left to screen readers: "2 of 25 done (1 missed)."), so the board starts right
  under it, at most 144 px from the top, at 390×664, 402×714, 440×790 and 390×844, even for Mixed
  and the longest names, in the app's font and in a wider one (DejaVu Sans). Where the count is too
  wide it takes a second line, breaking only between its phrases ("1 of 28 done" / "(1 missed)."),
  inside the choice's 44 px row. The heading takes up to two lines within the header line's 44 px,
  so a long name shows whole while the button reads `Hint` (after a Hint, the wider
  `Show the solution` can cut the two longest names at 390 and 402 px).
- A link to a Lesson without Puzzles (`#/puzzles/queen-mate`) or to no Lesson serves every Lesson's
  Puzzles, with the note "There are no Puzzles for Mate with king and queen, so these are from every
  Lesson."
- The header line "Rated <rating> · from a real Lichess game"; the region `Puzzle` with "Find the
  best move for <side>". The board stays in view and, once the Puzzle is over, the Ask box is docked. Once solved
  it reads "You found the best move for <side>."; after `Show the solution`, "The solution for
  <side> is on the board."
- A wrong move: "<move> is not the move. Try again." and it is taken back.
- `Hint` then `Show the solution`, one button at the end of the header line, as a Lesson's Hint then
  Show the move. The Hint is the Coach's `hint` job: the desktop's Engine works out the facts of the
  Puzzle's position (its best move is the solution's), the brief has `hideMoves: true` and no
  `winningChances`, and the reply names and draws no move: the guard strips every move, arrow and
  square, and a text that names a legal move is replaced (`namedMove`: SAN with or without x, = and
  + or #, figurines, the piece and square, UCI, a bare square only for the Engine's own pawn moves;
  in words, a sentence naming a piece and a square it can move to, or a word for taking with the
  piece taken and its square, or castling words when castling is legal) by "Look at every
  check, capture and threat in this position, for both sides, before you choose your move.", logged
  in `coach_calls.stripped` ("text names Bxc6, which a Hint keeps back") while `raw_reply` keeps
  what the Coach said. A Hint's words never stream: they arrive once checked (this holds for every
  Hint, the Lesson's and the Engine Game's too). The Coach panel shows "Hint, please." and the Hint
  under the board, with no Ask box while the answer is still to find, and the board takes no move
  while the Coach answers ("One moment: the Coach is giving a Hint."). Then the button reads
  `Show the solution`, with the focus on it, until the Player finds the move; at the Puzzle's next
  move to find it is `Hint` again. Without the Coach, the Hint says "Hints need the Coach, which is
  unavailable. Press Show the solution to see the moves." and makes no Coach call.
- `Next Puzzle`; a Why Question after solving. The Ask box names the move it asks about: "Ask why
  about 19. Bxc6" ("Why 19. Bxc6?" on a phone, so the longest label, "Why 30. fxe8=Q#?", fits at
  390 px in 16 px type), the Puzzle's answer as the board shows it (the solution's move, or another
  mate the Player found), wherever the Player steps, and the Why Question asks about that same
  move; in a variation, the variation's move shown.
- Once solved or shown, the region writes out the solution ("Solution: 19. Bxc6 Qxc6 20. Nxa7+ …",
  numbered from the Puzzle's own move number), each move a button (`Move 19. Bxc6`) that shows its
  position, and `First position` / `Previous move` / `Next move` / `Last position` step through it;
  the first position is the Puzzle as it was set. The board is then free to explore: a move that
  isn't the solution's starts a variation, written out under the solution as `Your variation`,
  and `Back to the Puzzle` drops it (see `explore.md`); the solution's own next move steps along it.
- A Why Question shows the position it explains (the Puzzle as set), so the Coach's arrows start
  on its pieces; stepping elsewhere hides them.
- When a Lesson's Puzzles (or all of them) are done on this device, the region `No more Puzzles`
  offers `Try the N you missed again` (the ones not solved first time), `Start these Puzzles
  again`, and `Puzzles from every Lesson`.
- Every Puzzle's first try is recorded in the Player Profile ("Puzzles: N solved first time out of
  M"). Trying it again, from the missed list or after `Start these Puzzles again`, adds nothing.
- No Winning Chances bar: it would give the answer away. The Coach's brief for a Why Question here
  carries no `winningChances` either (`puzzles.spec.ts`).

## Drive

Browser: `#/puzzles/italian-game` (an opening) or `#/puzzles/forks` (a Theme). The Puzzle id is on
the region as `data-puzzle-id`; its moves are in `data/puzzles.json` or `data/theme-puzzles.json`. Play them, then `$C db get puzzle_attempts`.
Stuck: `Hint`, then the same button, now `Show the solution`, shows the moves (two presses). To see
the guard at work, script the fake Coach with a Hint that names the solution (`app.script` in
`puzzles.spec.ts`), then `$C db get coach_calls`.

## Proof

- `puzzle_attempts` has the Puzzle, with its Lesson id in `opening`, and `solved: 1, mistakes: 0` for a clean solve, or
  `solved: 0` with the mistake count after a retry or `Show the solution`. A Puzzle tried again
  keeps its first row and adds none.
- The status reads "Solved first time!" or "Solved after N wrong tries.", or "Here is the solution."
  after `Show the solution`.
- Before a Hint there is no `Show the solution` and no Ask box. After `Hint` the conversation names
  none of the position's legal moves, the board has no arrows, and `coach_calls` has one `hint`
  call whose brief is the Puzzle as set with `hideMoves: true`, no `winningChances` and the
  solution's move as `candidates[0]`; `Show the solution` then has the focus. After it the Ask box
  reads "Ask why about <the solution's move>" and the `why` brief's `move.uci` is that move; in a
  variation it names the variation's move ("a Puzzle offers a Hint before Show the solution, from
  the Engine’s line, naming no move").
- A scripted Hint "Play <answer> now, it wins." (with its move, arrow and square) shows "Look at
  every check, capture and threat in this position, …", no frame the page receives holds the
  move's SAN or UCI, and `coach_calls.stripped` says "text names <answer>, which a Hint keeps back"
  ("a Hint whose words name the solution reaches the Player as a general Hint, and no word of it
  streams first"); so does one in words ("The <piece> belongs on <square>, so look there.") or
  with a figurine ("Try ♗xc6 now.") ("a Hint that says the solution in words, or with a figurine, …").
- With the Coach unavailable, `Hint` shows "Hints need the Coach, which is unavailable. …", no
  `coach_calls` row, and `Show the solution` still works ("a Hint without the Coach says why, …").
  While a slow Hint is on its way the solution's move is refused with "One moment: the Coach is
  giving a Hint." ("while the Coach gives a Hint › the board takes no move and says why; …"). In a
  Puzzle of several moves the button reads `Hint` again at the next move to find ("a Puzzle of
  several moves offers a Hint again for each move to find").
- Puzzle zwIo0 solved with 30. fxe8=R# (the solution is fxe8=Q#) reads "Ask why about 30. fxe8=R#"
  and the `why` brief has `move.uci: f7e8r` ("another mate on the last move: …"). On every phone
  size the Puzzle's Ask box, between the step buttons, reads "Why <move>?" in 16 px type, and the
  24 longest Puzzle and Lesson labels ("Why 30. fxe8=Q#?" among them) fit whole ("on a phone the
  Ask box fits the longest move it can name, in Puzzles and in Lessons").
- At 402×714, 440×790, 390×844 and 390×664, for `#/puzzles`, `#/puzzles/rook-endgames` and the
  Italian Game after a missed Puzzle, in both fonts: the progress line sits in the choice's row,
  the board less than 12 px under it and at most 144 px from the top, the choice at least 44 px
  tall, the count whole, the heading not cut and the header line at most 44 px ("on a phone the
  progress line shares the choice’s row, so the board starts right under it").

## Gotchas

- Done Puzzles are remembered on the device, so the next one always differs; wait for the id to change.
- Missed Puzzles (`puzzlesMissed`) are also kept on the device only, beside `puzzlesDone`.
