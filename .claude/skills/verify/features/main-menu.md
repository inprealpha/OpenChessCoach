# Main menu and navigation

The main menu is a clear starting point: three big choices, `Review your games` (the game
list, `#/games`), `Play a game` (an Engine Game, `#/engine-game`) and `Learn` (`#/learn`, which
offers Lessons and Puzzles), with the Board as a small link under them. While the Player has no
games, a prompt to import them sits above the choices; once they have games it goes away and
`Import more` sits inside Review your games. Settings and the Player Profile are icons in the top
right of every screen.

**Reached from:** the root (`#/`) once first run is done (or `#/menu`, also on an `empty` run whose
first run isn't done); `OpenChessCoach` in the header from any screen.

## Sub-features

- The navigation `Main menu`: with no games, the region `Import your games` (link `Import your
  games`, to `#/games/import`); the list of three choices, each a link with a heading
  (`Review your games`, `Play a game`, `Learn`); the link `Board`. Nothing else.
- With no games, the import prompt also has the button `Try a sample Review`: it imports the
  sample game (`packages/shared/src/sample-game.ts`, a Lichess database game, CC0; the same game
  verify mode seeds) with `games.importSample`, as source `sample` with the Player as White, and
  opens its Review, which says "A sample game: it doesn’t count towards your Player Profile."
  Its Review adds no Move Grade counts and no Coach note. The game list names it `(sample)`.
  A second try (another device) finds the same game and opens it: no duplicate. Disabled offline.
  The sample is not the Player's game: with only the sample in the list, the import prompt stays,
  without `Try a sample Review`, and there is no `Import more`.
- With games of their own: no import prompt; `Import more` inside Review your games, to
  `#/games/import`, which opens the game list with the `Username` box focused.
- An Engine Game in progress on this device (kept under `engineGame` in its store, no result yet):
  `Play a game` shows the link `Continue your game` (to `#/engine-game`) and "Move N, you play
  White|Black". Gone once the game is over. The saved moves are replayed first: a game whose
  moves can't all be played, whose side isn't White or Black, or that is already over on the board
  (the app closed before its result was saved) is not offered.
- Whether the Player has games: `games.list` with `limit: 1` from the desktop, else the list this
  device kept from the Games screen; while neither is known, neither the prompt nor `Import more`
  shows.
- Offline: the note "Your desktop can’t be reached…", and each choice says `Works without your
  desktop` (Play a game, Learn) or `Needs your desktop` (Review your games, the import prompt);
  `Import your games` and `Import more` are greyed out (`aria-disabled`, no `href`).
- Each screen names itself in the page title (`Board · OpenChessCoach`, `Review · OpenChessCoach`;
  the menu, and any address that names no screen, is just `OpenChessCoach`), set in `App.svelte`
  (`menu.spec.ts`). A Lesson, a set of Puzzles and a Review say which: `Lesson: Italian Game`,
  `Puzzles: Forks`, `Review: bijean vs ikatsca` (a Review once its game loads, through `titleFrom`
  in `lib/page-title.svelte.ts`).
- The header (banner), on every screen once paired: links `Player Profile` (`#/profile`) and
  `Settings` (`#/settings`), icons with `aria-current="page"` on their own screen. Below 400px wide
  the `Connection` status shows its dot only; its words stay for screen readers.
- The Learn screen: the navigation `Learn` with `Lessons` and `Puzzles`, then "Suggested next
  Lesson: <name>", a link to the Lesson the catalogue suggests (`lesson.md`).
- First run's `Start with the Lessons` opens the Lessons (`#/lessons`).

## Drive

```bash
npm run verify -- --seed empty            # no games: open #/menu
npm run verify -- --seed default          # one Imported Game: open #/
C="npm run -s coachctl --"
$C snapshot --route "#/menu"              # the accessibility tree of the menu
$C screenshot --route "#/" --width 390 --height 844 --full-page   # phone size
```

`menu.spec.ts` drives every sub-feature; `offline.spec.ts` checks the offline labels.

## Proof

- `empty`: the snapshot shows the region `Import your games` and exactly five links in `Main menu`.
- `empty`: `Try a sample Review` opens `#/review/<id>` for bijean vs ikatsca, whose Review has
  four key moments; `coachctl db get games` then has exactly one row (`source: sample`,
  `player_side: white`), however many times it is tried, and `grade_counts` stays empty. Back on
  `#/menu`, the region `Import your games` still shows, without `Try a sample Review`.
- `default`: no `Import your games` region; `Import more` inside Review your games.
- After 1. e4 d5 2. exd5 and the Engine's reply in an Engine Game (Beginner), the menu's `Play a game` shows `Continue your game` and
  "Move 3, you play White"; after `Resign` it is gone.
- From any screen, the banner's `Settings` and `Player Profile` open those screens.
