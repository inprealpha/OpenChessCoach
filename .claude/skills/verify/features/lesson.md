# Lesson

A course from first moves to the end of intermediate level in four tracks: Themes, Endgames,
Openings and How to think during a game, each at Beginner and Intermediate level (ADR 0012). Every
position comes from open data (ADR 0005, ADR 0008): Lichess's puzzles, games and chess-openings
(CC0), or a Wikibooks or Wikipedia page. Text is written for OpenChessCoach; a text kept from
Wikibooks or Wikipedia carries its CC BY-SA credit on screen. Openings add Lichess statistics for
what players at the Player's level choose. At each decision the Player picks a move; the desktop's
Engine grades it, so the Move Grade matches the facts the Coach is given (ADR 0007), and the Coach
explains. Nothing is locked: the app only says which Lesson to do next.

**Reached from:** Main menu → `Learn` (`#/learn`, with "Your next Lesson: <name>") → `Lessons`
(`#/lessons`), then a Lesson (`#/lesson/<id>`). `data/lessons/index.json` lists every Lesson in the
course order with its `track`, `level`, `goal` and `priorKnowledge`; `data-prep/course.ts` sets
the order. `#/lessons?track=<track>` opens the catalogue at a track. Play it out:
`#/play-out/<id>` for Lessons with a play-out (the endgames).

## Sub-features

- The catalogue (`#/lessons`), top to bottom:
  - The region `Your next Lesson`: the Lesson's name (a heading), "<Track> · <Level>", its goal, one
    line on why ("Start here.", "You started this Lesson and have made 3 of its 7 decisions.", "You
    have done the Lessons it builds on.", "It comes next in the order of the Lessons.") and the link
    `Start <name>` or `Resume <name>`. When every Lesson is complete it says "You have done every
    Lesson." The choice is `suggestNext` in `packages/shared/src/content/course.ts`: the Lesson
    most recently started and not finished; else the first in the course order whose prior
    knowledge is complete; a casual or club Player (Player Profile level) skips the beginner Lessons
    and counts them as known (`course.test.ts`).
  - The navigation `Tracks`: a link per track ("Themes", "2 of 6 complete") that scrolls to the
    track and moves the focus to its heading.
  - Each track: a heading, a line on what it covers, then a list per level named like
    `Themes, Beginner`, in the course order. A track with no Lessons yet says so. Each card is a
    link named `<Lesson name>: <status>` (`Not started`, `3 of 7 decisions`, `Complete`) showing
    the name, the goal cut to two lines, "Opening code C54 · as White · 7 decisions" (openings) or
    "6 decisions", and the status.
- The intro (region `About this Lesson`): "<Track> · <Level>", `What you will learn` with the goal,
  the list `It builds on` with a link per prior-knowledge Lesson and its status ("You can start this
  Lesson now, or do those first." while one is not complete; `Start the Lesson` is never disabled),
  the intro text, and "Text adapted from <credit>" only when the text is kept from Wikibooks or
  Wikipedia. An opening shows its part's text here too (it has no `Position` region while played),
  and one whose moves come from elsewhere than its intro text says "Moves from …".
- `How moves are written`, a `<details>` closed until opened, in the intro and beside the board
  while playing: squares (files a to h, ranks 1 to 8), K Q R B N and no letter for a pawn, x, +, #,
  O-O, O-O-O, =Q, and "12." and "12..." for White's and Black's 12th move.

- `Start the Lesson` / `Resume the Lesson`; progress saved per decision. However fast it is
  clicked, the first prompt ("What are your options here?") shows once.
- `Hint` then `Show the move` ("The Engine’s move here is X." with a green arrow), said once per
  decision: another click only brings the arrow back.
- After each choice the region `Your choice` says "You played <move>" with its Move Grade, how
  often players at the Player's level choose it (openings, where the games database has enough
  games), and the Coach's explanation. On a phone (below 820px) `Your choice` and the Coach come
  straight under the board, before the region `Position`, so `Continue` shows without scrolling.
- While choosing, the one place to type is `Explain your thinking (optional)` (sent with the move;
  its example fits the Lesson, e.g. a pin in Pins, else its kind), a two-line box that wraps so the example shows
  whole on any phone; the Coach's Why Question box appears once the move is graded.
- While the Player's choice is shown, the board carries its Move Grade symbol on the square the
  move landed on (`Mistake on g4`, `Best on e4`; none for Good); `Try another move` and
  `Continue` clear it.
- Every Lesson but an opening shows the region `Position` with the part's title, its text,
  "Position from <credit>" (`Lichess puzzle database, puzzle …`, a Lichess game, `Wikibooks, …`)
  and, only when the text is kept from Wikibooks or Wikipedia, "Text adapted from <credit>" (one
  line, "Position and text adapted from …", when both come from the same page).
- The screen never shows a part's key idea before the Player's decision: it shows in `Your choice`
  as "Key idea: …" once the part's last decision is played well, and every part's key idea is in
  the list `What you learned` when the Lesson is complete. The Coach's replies may use it after a
  move (the fake Coach ends each Lesson turn with "Key idea: …").
- Every Coach call in a Lesson (the Lesson turn, a Hint, a Why Question) sends `lessonFocus`
  (`{ lesson, learningGoal, keyIdea }`, the current part's key idea); the desktop puts it in the
  brief as `focus`, the same fields, without `lesson` in a Lesson turn, whose `lesson.opening`
  already names it.
- `Try another move` after a poor choice, or `Continue with the Lesson’s move` ("The Lesson
  continues with the move it teaches, …"); `Continue` to the next decision (one decision per
  Continue, however fast it is clicked). An opening's prompt says whose move it is ("Move 4, Black
  to play. What are your options here?").
- The region `Lesson complete` at the end, with the Move Grades of the Player's first tries
  ("Your first tries: 4 Best, 2 Blunders."), `What you learned` (the key ideas),
  `Next Lesson: <name>` (the Lesson `suggestNext` gives with this one counted complete),
  `Practise with <Lesson> Puzzles` (for an opening, or a Lesson with Puzzle themes) and, for
  endgames, `Play it out against the Engine: …`.
- Play it out (`#/play-out/<id>`): the region `Play it out` says the goal ("Checkmate the black
  king." or "Promote your pawn."); the Engine answers at full strength; `Start again` resets it;
  reaching the goal says "Well played!"; losing the pawn says "Your pawn is gone, so it can no
  longer promote." Under the board, "N moves played" counts the Player's own moves.
- No Winning Chances bar, in a Lesson or in Play it out: it would give the answer away. No Coach
  brief in a Lesson carries `winningChances` either: Lesson turns, Hints and Why Questions
  (`lesson.spec.ts`).
- Every Lesson's text is written for OpenChessCoach today, so no note carries a credit. A text kept
  from Wikibooks or Wikipedia would carry its credit link ("Lesson notes adapted from …").

## Drive

Browser: `#/lessons` → the `Your next Lesson` link → `Start the Lesson` → play the main move at each
decision (`data/lessons/<id>.json` lists them as `parts[].mainLine`) → `Continue`. Then
`$C db get lesson_progress` and `$C db get coach_calls`. Screenshots at both sizes:
`$C screenshot --route "#/lessons" --width 390 --height 844` and
`$C screenshot --route "#/lesson/<id>" --width 1280 --height 800`.

## Proof

- `lesson_progress` has the Lesson with `completed: 1` at the last step.
- The catalogue link reads `Italian Game: Complete`, or `Italian Game: 1 of N decisions` part way;
  the `Your next Lesson` region has moved on to `Next Lesson`'s Lesson.
- `coach_calls` has one `lesson-turn` call per decision, and each Lesson brief (`lesson-turn`,
  `hint`, `why`) has `focus: { lesson, learningGoal, keyIdea }` (no `lesson` in a `lesson-turn`)
  with the key idea of the part on screen.
- `lesson.spec.ts` covers the catalogue's tracks and next Lesson, which moves on when a Lesson is
  finished, the intro's goal, `It builds on` links and `How moves are written`, `lessonFocus` on
  every Coach call through a whole `thinking` Lesson (the Why Question after the end has no move),
  and the catalogue and intro at 390×844 with nothing wider than the screen.
- In the Italian Game, 1.g4 shows one symbol on g4 (Inaccuracy or worse) and 1.e4 shows
  `Best on e4`.

## Gotchas

- When the desktop can't be reached, the browser's Engine grades the move and the Coach's
  features are greyed out. `Show the move` after a Hint also asks the desktop's Engine first.
- `npm test` checks every Lesson line is legal, every position is credited, any kept text keeps its
  credit, and no uncredited text keeps 8 words in a row from the earlier Wikibooks and Wikipedia
  texts in `data/open-texts.json` (`content.test.ts`). `node data-prep/engine-check.ts` checks every main-line move the Player is
  asked for is Best or Good at depths 10 and 14 (pass the ids you changed: all of them take a few
  minutes); `npm test` checks it at depth 10 on every Lesson (`lesson-engine.test.ts`). The Lesson
  journeys walk an opening, a Theme, an endgame and a `thinking` Lesson in the browser, not the
  whole catalogue.
- Journeys read goals, key ideas and prior knowledge from `data/lessons/`, never from the journey;
  the data check makes sure none is empty.
- The seed's Player is casual: `suggestNext` skips the beginner Lessons for them while intermediate
  ones exist. Change the level in the Player Profile to see a beginner's next Lesson.
- Popularity comes from about 5 million Lichess games (2013 to 2015). Deep in a line, where fewer than
  20 games at the Player's level reached the position, it is missing and the table is hidden.
