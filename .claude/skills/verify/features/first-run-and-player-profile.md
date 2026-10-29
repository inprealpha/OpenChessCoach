# First run and Player Profile

A fresh install asks the Player's level, optionally reads their rating from Lichess or chess.com,
and saves Goals. The Player Profile collects Move Grade counts by opening, Puzzle results and the
Coach's notes, and the Player can edit or delete any of it.

**Reached from:** the first visit after pairing on an empty install (`npm run verify -- --seed
empty`); later the header's `Player Profile` icon (`#/profile`) and `Settings` cog (`#/settings`),
in the top right of every screen.

## Sub-features

- Welcome screen ("Welcome to your chess Coach"): on a desktop with no phone paired, first the
  phone (`phone.md`), then ("Step 2 of 2") level, optional site username, Goals. Each level names
  the online band it stands for ("Online: rated under 1400.", "1400 to 1799", "1800 and above").
  "Where to begin" names the first Lesson for the level picked ("At your level, the first Lesson
  is Attack and defence." for a beginner, "Candidate moves and thinking ahead" for casual or club),
  from `suggestNext` in `packages/shared/src/content/course.ts`, which goes by the Player's band: a
  linked rating's band wins over the level picked.
- `Start with the Lessons` (opens the Lessons, `#/lessons`, at their top) or `Skip to the main menu`.
- An unknown username (or a site that is limiting requests) shows its error inside the group `Your
  online account (optional)`, under the `Username` box, which takes the focus with
  `aria-invalid="true"`; the error says the Player can set Site to None instead. Onboarding waits.
- Profile: the region `Level, account and Goals` with `Edit level, account and Goals`; while no
  account is linked, "Rating: not linked" and `Link an account`, which opens the form at `Site`.
  The form's group `Your online account` links, changes or removes (Site `None`) a Lichess or
  chess.com account in the same one update as the level and Goals: an unknown username, or one in a
  format no site allows ("Magnus Carlsen", an email address), shows its error under `Username`,
  which takes the focus with `aria-invalid="true"`, and nothing is saved; a linked account fills
  the game list's import by username, also after a reload on `#/games` (unless the Player has
  already picked a Site or typed a Username there). While the desktop asks the site, Save reads
  `Checking Lichess…` (or `Checking chess.com…`) and Save and Cancel are disabled: once asked,
  the desktop can't be called back. Other refusals show beside Save, such as "Not saved: your
  desktop can’t be reached right now. Save again once it’s back."; the desktop saves nothing
  from a connection that has closed, so a save the app gave up on never lands later.
- Profile: the region `Lesson progress` (only the Lessons started, then "N
  more Lessons to try" or "No Lessons started yet." with `Browse the Lessons`; "No Puzzles tried
  yet." until one is), the region `Move Grades by opening` (below 32rem wide its column headers
  show the Move Grade symbols ★ ✓ ?! ? ?? with a legend under the table, and keep the Move Grades'
  names as their accessible names, so every column fits a 320px phone), Coach notes with
  `Delete note: <text>`.
- Settings shows what came of a change ("Saved.", an error) in the card where it was made.
- Settings → the group `Coach quality`: radios `Thrifty`, `Balanced (recommended)` and `Best`, each
  with a line on what it costs in Claude limits. The choice is not stored: it is read from the
  per-job models, and when they match no preset a checked, disabled `Custom` radio shows. Choosing a
  preset writes every job's model. `Advanced` (a disclosure) holds one select per job, `Model for
  <Reviews | Why Questions | Lessons | Hints | Live Coaching>`, with options `Fastest, latest Haiku`,
  `Balanced, latest Sonnet` and `Strongest, latest Opus` (values `haiku`, `sonnet`, `opus`). A
  Review's overview has no select of its own: it runs on the model for Reviews in every preset.
- Settings → the region `Reviews`: the checkbox `Open each Review with the Coach’s overview of the
  whole game`, on by default (see `review.md`).

## Drive

Browser on an `empty` run: open `pairUrl`, `I’ll do it later` on the phone step, pick a level, type `CoachVerify` (Lichess), add a Goal,
`Start with the Lessons`. Then `$C db get profile`.

Coach quality, on a `default` run: `#/settings`, check `Best`, then `$C db get settings`; open
`Advanced`, change `Model for Hints`, and `Custom` is checked.

## Proof

- `profile` row: `onboarded: 1`, the chosen `level`, `rating: 1612` for Lichess `CoachVerify`
  (1488 for chess.com `coachverify`), and the Goals.
- After a Review, `grade_counts` has rows for the opening and `coach_notes` may have one note (the
  overview's, or with the overview off the last key moment's); at
  390px the Profile has no horizontal scroll.
- After `NoSuchPlayer`, the `profile` row still has `onboarded: 0`; with Site set to None, Skip
  reaches the main menu.
- From the Player Profile (`default` seed): linking Lichess `CoachVerify` writes `rating: 1612,
  rating_site: lichess, rating_username: CoachVerify`; changing it to chess.com `coachverify` writes
  `rating: 1488, rating_site: chesscom`; `NoSuchPlayer` and `Magnus Carlsen` write nothing; Site None
  writes `rating`, `rating_site` and `rating_username` back to null (`first-run.spec.ts`,
  `games.test.ts`). A double press of Save asks the site once (`first-run.spec.ts`, with the site's
  answer held back). A save whose connection closed, during the lookup or in the same read as the
  message (a desktop waking from sleep), writes nothing (`games.test.ts`).
- After `Best`, the `settings` row `models` is `{"review-moment":"opus","why":"opus","lesson-turn":
  "opus","hint":"haiku","live":"haiku"}` (Thrifty: all `haiku`; Balanced: `sonnet` for the first
  three). No `quality` row is ever written. `settings.get` returns `quality: "custom"` for any other
  mix (`packages/backend/test/settings.test.ts`, `first-run.spec.ts`).

## Gotchas

- Usernames answer from `packages/backend/recordings/sites.json`; `NoSuchPlayer` is the unknown one.
- The `default` seed is already onboarded, so the welcome screen never shows there.
