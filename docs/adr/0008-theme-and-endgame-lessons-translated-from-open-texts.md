# Theme and endgame Lessons are translated from open texts and checked by the Engine

> Partly superseded by ADR 0011: Lesson text is now written fresh, with positions from Lichess data or famous games, and Lessons cover four tracks. The Engine check below still applies to every Lesson.

Lessons cover three things: openings, Themes (forks, pins, skewers, discovered attacks, back-rank mate, removing the defender) and basic endgames (mate with king and queen, mate with king and rook, king and pawn, rook endgames). Theme and endgame Lessons follow ADR 0005: their content is translated from published lessons, not composed by Claude. Each Lesson is a few worked examples, each a position and a line taken from the source as it is written: Wikibooks' *Chess/Tactics* and *Chess/The Endgame* and Wikipedia's articles on each Theme and on the Lucena and Philidor positions (all CC BY-SA 4.0), plus positions from the Lichess puzzle database (CC0) where the texts have too few examples. The intro, each position's text and the notes are adapted from the same pages and credited on screen. Where the source does not give the opponent's reply, the Engine's best reply is used. Puzzles for each Theme and endgame come from the Lichess puzzle database by its theme tags. After an endgame Lesson the Player can play the position out against the Engine at full strength.

Every move the Player is asked to find must be graded Best or Good by the Engine (ADR 0002) at the depth verify mode grades at and at the desktop's depth, so a Player who plays the book move is never told it was a Mistake. `node data-prep/engine-check.ts` checks this at both depths, and `npm test` checks it at verify mode's depth on every Lesson. A source line that fails is cut where it fails, or the move is shown rather than asked; it is never rewritten.

## Consequences

- Lesson data now has parts: an opening is one part from the starting position; a Theme or endgame Lesson has several. Only openings have move popularity and require a note at every decision.
- "Tactic" stays a word the app avoids. The glossary term is Theme.
- The credit check accepts Wikibooks and Wikipedia pages under CC BY-SA 4.0, and Lichess puzzle pages under CC0 for positions only.
- Mating lines are where the Engine's grades are least stable: a slower mate that the search has not yet seen as mate can fall foul of the 300-centipawn floor (ADR 0002). Lines are chosen and trimmed to pass at both depths.
