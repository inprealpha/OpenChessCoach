# Lesson

Lessons built from open data (ADR 0005, ADR 0008). Openings: Lichess opening statistics for what
players at the Player's level choose, and Wikibooks notes (CC BY-SA, credited on screen). Themes and
endgames: worked examples translated from Wikibooks and Wikipedia, and Lichess puzzle positions, in
several parts, each with its own credit. At each decision the Player picks a move; the desktop's Engine grades it, so the Move Grade matches the facts the
Coach is given (ADR 0007), and the Coach explains.

**Reached from:** Main menu → `Learn` (`#/learn`) → `Lessons` (`#/lessons`, sections Openings for White, Defences for
Black, Themes, Endgames), then a Lesson (`#/lesson/<id>`). The ids are in `data/lessons/index.json`:
openings `italian-game`, `ruy-lopez`, `london-system`, `queens-gambit`, `caro-kann`,
`two-knights-defence`, `queens-gambit-declined`; Themes `forks`, `pins`, `skewers`,
`discovered-attacks`, `back-rank-mate`, `removing-the-defender`; endgames `queen-mate`, `rook-mate`,
`king-and-pawn`, `rook-endgames`. Play it out: `#/play-out/<id>` for the endgames.

## Sub-features

- `Start the Lesson` / `Resume the Lesson`; progress saved per decision. However fast it is
  clicked, the first prompt ("What are your options here?") shows once.
- `Hint` then `Show the move` ("The Engine’s move here is X." with a green arrow), said once per
  decision: another click only brings the arrow back.
- After each choice the region `Your choice` says "You played <move>" with its Move Grade, how
  often players at the Player's level choose it (openings, where the games database has enough
  games), and the Coach's explanation. On a phone (below 820px) `Your choice` and the Coach come
  straight under the board, before the region `Position`, so `Continue` shows without scrolling.
- While choosing, the one place to type is `Explain your thinking (optional)` (sent with the move;
  its example fits the Lesson, e.g. a pin in Pins), a two-line box that wraps so the example shows
  whole on any phone; the Coach's Why Question box appears once the move is graded.
- While the Player's choice is shown, the board carries its Move Grade symbol on the square the
  move landed on (`Mistake on g4`, `Best on e4`; none for Good); `Try another move` and
  `Continue` clear it.
- Theme and endgame Lessons show the region `Position` with the part's title, its text and its
  credit (`Wikibooks, …`, `Wikipedia, …` or `Lichess puzzle database, puzzle …`).
- `Try another move` after a poor choice; `Continue` to the next decision (one decision per
  Continue, however fast it is clicked).
- The region `Lesson complete` at the end, with the Move Grades of the Player's first tries
  ("Your first tries: 4 Best, 2 Blunders."), `Next Lesson: <name>` (the next one in the same
  catalogue section), `Practise with <Lesson> Puzzles` (not for the two mates) and, for endgames,
  `Play it out against the Engine: …`.
- Play it out (`#/play-out/<id>`): the region `Play it out` says the goal ("Checkmate the black
  king." or "Promote your pawn."); the Engine answers at full strength; `Start again` resets it;
  reaching the goal says "Well played!"; losing the pawn says "Your pawn is gone, so it can no
  longer promote." Under the board, "N moves played" counts the Player's own moves.
- No Winning Chances bar, in a Lesson or in Play it out: it would give the answer away.
- The Wikibooks credit links (`Wikibooks, Chess Opening Theory/…`) on every note.

## Drive

Browser: `#/lesson/italian-game` → `Start the Lesson` → play the main move at each decision
(`data/lessons/<id>.json` lists them as `parts[].mainLine`) → `Continue`. Then `$C db get lesson_progress`.

## Proof

- `lesson_progress` has the Lesson with `completed: 1` at the last step.
- The catalogue link reads `Italian Game: Complete`, or `Italian Game: 1 of N decisions` part way.
- `coach_calls` has one `lesson-turn` call per decision.
- In the Italian Game, 1.g4 shows one symbol on g4 (Inaccuracy or worse) and 1.e4 shows
  `Best on e4`.

## Gotchas

- When the desktop can't be reached, the browser's Engine grades the move and the Coach's
  features are greyed out. `Show the move` after a Hint also asks the desktop's Engine first.
- Some Wikibooks notes come from the nearest page in the opening tree rather than the exact
  position; the credit names the page used.
- `npm test` checks every Lesson line is legal and every note and position is credited
  (`content.test.ts`). `node data-prep/engine-check.ts` checks every main-line move the Player is
  asked for is Best or Good at depths 10 and 14 (pass the ids you changed: all of them take a few
  minutes); `npm test` checks it at depth 10 on every Lesson (`lesson-engine.test.ts`). The Lesson
  journeys walk one Lesson of each kind in the browser, not the whole catalogue.
- Popularity for the Ruy Lopez and Two Knights Defence stops after move 3: the bundled games
  statistics do not have enough games deeper in those lines. The table is hidden there.
