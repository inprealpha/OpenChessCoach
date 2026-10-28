# A course in four tracks, with goals, written fresh

The Learn section is a course from complete beginner to the end of intermediate level, in four tracks: Themes, endgames, openings, and how to think during a game (a blunder check, checks, captures and threats, simple plans, and at intermediate level pawn structure, weak squares, and good and bad pieces). Each track has a beginner and an intermediate level. Advanced level is future work and is listed in `docs/course-outline.md` only. The outline is the plan: which Lessons exist, in what order, and what each one is for.

## Every Lesson has a goal, and every part a key idea

Each Lesson has a learning goal: one or two plain sentences saying what the Player can do afterwards. It also lists its prior knowledge: the Lessons a Player should know first. Each part of a Lesson has a key idea: one line saying what that position teaches. Writing the goal first keeps a Lesson on one point, and the Coach uses the same words: every Coach call during a Lesson (a Lesson turn, a Hint, a Why Question) carries the goal and the current key idea in its brief, so the Coach stays on the Lesson's point. They are short (at most 240 and 140 characters), so the brief stays within its budget (ADR 0004). The Engine's facts still decide what is true (ADR 0002, ADR 0009): a key idea never overrides them.

## Nothing is locked

Every Lesson can be opened at any time. The app suggests one next Lesson: the one the Player started and has not finished, or else the first Lesson in the course order whose prior knowledge the Player has finished. A Player who chose casual or club level in the Player Profile is not sent through the beginner Lessons first. Locking would stop a Player who already knows a topic, and the suggestion is enough to guide a Player who doesn't.

## Books guide what to teach, never the text

The owner keeps chess books in a private folder outside the repository: the Steps Method trainer manuals, Levy Rozman's two books, and Yasser Seirawan's three books. They are used only to decide which topics to teach, in what order, and what each Lesson should achieve. They are never copied into the repository. Their explanations, notes and examples are never copied or closely paraphrased, and the course does not follow any one book section by section. The repository is public, and the books are not ours to publish.

Every position and line comes from open data: Lichess's puzzle database, games database and chess-openings list (all CC0), or a famous game as a Wikipedia or Wikibooks page gives it. Every explanation is written fresh for OpenChessCoach. A text kept from the earlier Wikibooks and Wikipedia Lessons keeps its CC BY-SA 4.0 credit, shown on screen; a test compares every uncredited text with those earlier texts, so a kept text cannot lose its credit by accident.

This supersedes the parts of ADR 0005 and ADR 0008 that said Lesson text is adapted or translated from Wikibooks and Wikipedia. Their rules on open positions, credits and the Engine check still apply.

## The Engine check stays

Every move a Lesson asks the Player to find must be graded Best or Good by the Engine at verify mode's depth and at the desktop's depth (ADR 0008): `node data-prep/engine-check.ts` checks both, and `npm test` checks verify mode's depth on every Lesson. A line that fails is cut where it fails, or another position is chosen. It is never kept with a move the Engine grades worse.

## Consequences

- A Lesson has a track, a level, a goal and prior knowledge, and each part has a key idea. The Lesson data check fails when one is missing, too long, or names a Lesson that does not exist, and when prior knowledge goes round in a circle.
- A fourth kind of Lesson, `thinking`, teaches a way of thinking during a game. The opening principles are one, in the openings track.
- Each Lesson has its own source file, `data/lesson-sources/<id>.json`, and `data-prep/course.ts` gives the course order. `data-prep/lesson-tools.ts` helps find positions in the puzzle database and check lines with the Engine.
- The Learn screens show the four tracks and their levels, and the suggested next Lesson.
- The books' wording, examples and order are kept out by review: before a Lesson is merged, a reviewer compares it with the books.
