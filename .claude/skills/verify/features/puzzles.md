# Puzzle

Puzzles from the Lichess puzzle database (CC0), picked near the Player's rating or level, filtered
by Lesson: an opening's Puzzles by the opening, a Theme's or endgame's by Lichess's theme tags
(ADR 0008). A wrong move is shown as wrong and the Player retries.

**Reached from:** Main menu → `Learn` (`#/learn`) → `Puzzles` (`#/puzzles`), or `#/puzzles/<lessonId>` from a Lesson.

## Sub-features

- `Choose what to practise`, a disclosure under the heading, opens the navigation `Puzzles to
  practise`: a link per set, `Mixed: every Lesson` (the default, `#/puzzles`) then each Lesson with
  Puzzles in the lists `Openings`, `Themes` and `Endgames` (`#/puzzles/<lessonId>`), written like
  "Pins", then "25 Puzzles · 2 done (1 missed)"; the set shown is `aria-current="page"`. Missed counts only
  Puzzles that are done. Lessons without Puzzles are not offered. Beside it, this set's progress on
  the device: "Pins: 2 of 25 done (1 missed)." Only following a link changes the set (arrow keys
  don't), and focus comes back to `Choose what to practise` on the new set. On a phone the links
  wrap their names.
- A link to a Lesson without Puzzles (`#/puzzles/queen-mate`) or to no Lesson serves every Lesson's
  Puzzles, with the note "There are no Puzzles for Mate with king and queen, so these are from every
  Lesson."
- The region `Puzzle` with "Find the best move for <side>" and the Puzzle's rating. Once solved
  it reads "You found the best move for <side>."; after `Show the solution`, "The solution for
  <side> is on the board."
- A wrong move: "<move> is not the move. Try again." and it is taken back.
- `Show the solution`; `Next Puzzle`; a Why Question after solving.
- Once solved or shown, the region writes out the solution ("Solution: 19. Bxc6 Qxc6 20. Nxa7+ …",
  numbered from the Puzzle's own move number), each move a button (`Move 19. Bxc6`) that shows its
  position, and `First position` / `Previous move` / `Next move` / `Last position` step through it;
  the first position is the Puzzle as it was set.
- A Why Question shows the position it explains (the Puzzle as set), so the Coach's arrows start
  on its pieces; stepping elsewhere hides them.
- When a Lesson's Puzzles (or all of them) are done on this device, the region `No more Puzzles`
  offers `Try the N you missed again` (the ones not solved first time), `Start these Puzzles
  again`, and `Puzzles from every Lesson`.
- Every Puzzle's first try is recorded in the Player Profile ("Puzzles: N solved first time out of
  M"). Trying it again, from the missed list or after `Start these Puzzles again`, adds nothing.
- No Winning Chances bar: it would give the answer away.

## Drive

Browser: `#/puzzles/italian-game` (an opening) or `#/puzzles/forks` (a Theme). The Puzzle id is on
the region as `data-puzzle-id`; its moves are in `data/puzzles.json` or `data/theme-puzzles.json`. Play them, then `$C db get puzzle_attempts`.

## Proof

- `puzzle_attempts` has the Puzzle, with its Lesson id in `opening`, and `solved: 1, mistakes: 0` for a clean solve, or
  `solved: 0` with the mistake count after a retry or `Show the solution`. A Puzzle tried again
  keeps its first row and adds none.
- The status reads "Solved first time!" or "Solved after N wrong tries."

## Gotchas

- Done Puzzles are remembered on the device, so the next one always differs; wait for the id to change.
- Missed Puzzles (`puzzlesMissed`) are also kept on the device only, beside `puzzlesDone`.
