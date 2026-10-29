# A Course in four Tracks, with goals, written fresh

The Learn screens hold a Course from complete beginner to the end of intermediate level, in four Tracks: Themes, endgames, openings, and how to think during a game. The last one teaches habits and plans: for example the Blunder check; Checks, captures and threats; Simple plans; and, at intermediate level, Pawn chains and breaks, Weak squares and outposts, and Good and bad pieces. Each Track has a beginner and an intermediate level. Advanced level is future work and is listed in `docs/course-outline.md` only. The outline is the plan: which Lessons exist, in what order, and what each one is for.

## Every Lesson has a learning goal, and every part a key idea

Each Lesson has a learning goal: one or two plain sentences saying what the Player can do afterwards. It also lists its prior knowledge: the Lessons a Player should know first. Each part of a Lesson has a key idea: one line saying what that position teaches. Writing the goal first keeps a Lesson on one point, and the Coach uses the same words: every Coach call during a Lesson (a Lesson turn, a Hint, a Why Question) carries the learning goal and the current key idea in its brief, so the Coach stays on the Lesson's point. The one exception is a Lesson turn that keeps the answer back (below): it carries the learning goal only. They are short (a learning goal at most 240 characters, a key idea at most 140), so the brief stays within its budget (ADR 0004). The Engine's facts still decide what is true (ADR 0002, ADR 0009): a key idea never overrides them.

## The Lesson's move is never given away

A Lesson asks the Player to find a move. When the Player plays a different one, the screen gives its Move Grade, says so when it is sound but not the move the Lesson teaches, and offers to try again or to continue with the Lesson's move. A move that gives checkmate is never told to try again: it counts as the Lesson's move, and it ends its part. The Coach's brief for that turn carries no candidates, no Lesson note, no key idea and nothing of the Engine's lines past the replies to the Player's move, where the Lesson's move is often still the best one, so the Coach explains what the Player's move does and allows without naming or drawing the Lesson's move. It keeps the Lesson's name and learning goal. The key idea stays out because it often comes close to the answer ("a piece put in the way blocks the attack"), and a Hint is the place for a nudge. A Hint never names a move either. So a key idea names an idea, never a move its part asks for, in the opening Lessons too: the screen keeps it back until the part is played, and the Coach sees it during a Hint, a Why Question and the turn after the Lesson's move. An opening's learning goal may still name its moves, since the screen shows it before the Lesson starts.

After the Lesson's move, the Coach's arrows show no other move for the Player, not even the Engine's top choice: an arrow stays on the board while the Player looks for the next move, and that move may be the answer to the Lesson's next decision. The prompt tells the Coach so, and the Lesson screen leaves out any such arrow the Coach draws anyway. This is about the arrows only. The brief for the Lesson's move keeps its candidates and their lines, so the Coach's words may still compare the move with the other moves in that position, and a line can pass through the next decision's move.

## Nothing is locked

Every Lesson can be opened at any time. The app suggests one next Lesson: the one the Player started and has not finished, or else the first Lesson in the Course order whose prior knowledge the Player has finished. A Player above beginner level is not sent through the beginner Lessons first: for them, beginner Lessons count as finished, also when another Lesson lists them as prior knowledge. Locking would stop a Player who already knows a topic, and the suggestion is enough to guide a Player who doesn't.

The level the suggestion goes by is the same level band the "what players at your level play" tables use: the level the Player chose in the Player Profile, or, once a Lichess or chess.com account is linked, the band its rating falls in (under 1400, 1400 to 1799, 1800 and above). A Player who chose casual but whose linked rating is under 1400 starts with the beginner Lessons, which hold the habits such a Player most often lacks.

## Books guide what to teach, never the text

The owner keeps chess books in a private folder outside the repository: the Steps Method trainer manuals, Levy Rozman's two books, and Yasser Seirawan's three books. They are used only to decide which topics to teach, in what order, and what each Lesson should achieve. They are never copied into the repository. Their explanations, notes and examples are never copied or closely paraphrased, and the Course does not follow any one book section by section. The repository is public, and the books are not ours to publish.

Every position and line comes from open data: Lichess's puzzle database, games database and chess-openings list (all CC0), a famous game as a Wikipedia or Wikibooks page gives it, or a position kept from the earlier Wikibooks and Wikipedia Lessons. Every explanation is written fresh for OpenChessCoach. A text kept from the earlier Wikibooks and Wikipedia Lessons keeps its CC BY-SA 4.0 credit, shown on screen; a test compares every uncredited text with those earlier texts, so a kept text cannot lose its credit by accident.

This supersedes the parts of ADR 0005 and ADR 0008 that said Lesson text is adapted or translated from Wikibooks and Wikipedia. Their rules on open positions, credits and the Engine check still apply.

## The Engine check stays

Every move a Lesson asks the Player to find must be graded Best or Good by the Engine at verify mode's depth and at the desktop's depth (ADR 0008): `node data-prep/engine-check.ts` checks both, and `npm test` checks verify mode's depth on every Lesson. A line that fails is cut where it fails, or another position is chosen. It is never kept with a move the Engine grades worse.

## Consequences

- A Lesson has a Track, a level, a learning goal and prior knowledge, and each part has a key idea. The Lesson data check fails when one is missing, too long, or names a Lesson that does not exist, when prior knowledge goes round in a circle, and when a key idea names a move its part asks for, in any kind of Lesson.
- A fourth kind of Lesson, `thinking`, teaches a way of thinking from several positions. Most are in the how-to-think Track; three are in the openings Track: Opening principles, Opening traps and Gambits.
- Each Lesson has its own source file, `data/lesson-sources/<id>.json`, and `data-prep/course.ts` gives the Course order. `data-prep/lesson-tools.ts` helps find positions in the puzzle database and check lines with the Engine.
- The Learn screens show the four Tracks and their levels, and the Player's next Lesson.
- The books' wording, examples and order are kept out by review: before a Lesson is merged, a reviewer with access to the books compares it with them, and the PR says who did. The books are not in the repository, so no test can do it.
- ADR 0011 leaves tempting moves out of Lesson turns, because the opening Lessons already show how often players at the Player's level choose each move. That reason holds only for the opening Lessons. In the other Lessons the notes name the tempting wrong moves, and Hints and Why Questions still get tempting moves. Adding tempting moves to their Lesson turns is future work.
