# Imported Game

The Player brings in their own games: a pasted PGN, or their finished games from Lichess or
chess.com by username: the whole history the first time, then only games newer than the last import.

**Reached from:** Main menu → `Review your games` (`#/games`); with no games, the main menu's
`Import your games` prompt, and with games, `Import more` inside Review your games (both
`#/games/import`, which focuses the `Username` box).

## Sub-features

- The form `Import a PGN`: textarea `PGN`, `Import PGN`. The Player's side comes from the names in
  the PGN: the Player Profile's username or any username their games were fetched for
  (`site_imports`). When neither name matches, or both do (a friend's games fetched too), the
  group `Which side did you play?` appears (a question, not an error: no alert), with neither
  radio checked and `Import PGN` disabled until the Player picks one.
  The same game twice says "You already imported that game."; a broken PGN shows an error.
  Pasting a game the Player deleted brings it back. An illegal move is named, whether it is a real move that can't be played ("Move 2. Ke3 is not
  legal in that position.") or a word that can't be a move ("Move 2. Ke9 is not a legal move."),
  and that error comes before any complaint about the game's result.
- Moves pasted without a result (or with `*`) import when the last position ends the game:
  checkmate gives `1-0` or `0-1`, stalemate or too little material to mate (bare kings, a lone
  knight or bishop) `1/2-1/2`. A draw by the fifty-move rule or by repetition has to be claimed,
  so it needs its result. Any other game with no result is refused with "That game has no result.
  Add it after the last move (1-0, 0-1 or 1/2-1/2), then import it again. …". A PGN with no
  `White`/`Black` names (PGN's `?`) names the sides `White` and `Black`. Movetext as other sites
  and books write it reads too: `1… e5`, `exf6e.p.`, `½-½`, and the novelty mark `N` after a move
  (`4.Ba4N`, `3.Bb5!N`, `4. Ba4 N`). An `N` before a square (`2. N f3`) is refused as "Move 2. N is
  not a legal move.", never read as the pawn move `f3`.
- The form `Import by username`: `Site` (Lichess or chess.com), `Username`, `Fetch finished
  games`. Only finished games are imported; games in progress are skipped and counted. While it
  runs, "Fetching games… N so far." counts the games received. The first import of a username
  reads every chess.com monthly archive, or the whole Lichess export oldest first; `site_imports`
  then records how far it got (`imported_through`, in ms), and the next import asks only for games
  from there on (Lichess `since`, chess.com archives from that month). If a site fails part way,
  the games already fetched stay, the error says how many, and the next import carries on.
  A Lichess game still being played is noted in `site_import_playing`, and the import point moves
  past it; the next import asks for it again by id (`/api/games/export/_ids`) and imports it once
  it has ended. On chess.com the import point stops just before such a game instead.
  Games that never started (Lichess `aborted`, `noStart`) are left out; games whose moves can't be
  read are counted ("… that couldn’t be read"). A game the Player deleted is noted in
  `deleted_games` and never imported again, though a site hands some games over again (the
  newest, or a chess.com month with a daily game still being played); it counts as neither
  imported nor already in the list. One import per site runs at a time: a second one,
  or a rating lookup on that site during its import, says to wait for it to finish.
- The table `Game list` with a `Review: <opponent>, <date>` (or `Open Review: …`) link per game,
  newest first, a page of 50 at a time (`GAMES_PAGE_SIZE`): "Showing 50 of 61 games." and a
  `Show more` button that appends the next page; once every game is shown it says "Showing all
  61 games." and the button is gone. A refresh (after an import, or a reconnect) rereads as many
  games as are shown, plus the one a pasted PGN added. `games.list` takes `offset` and `limit`
  (at most 500) and returns that page and `total`. The device keeps only the games shown.
  A pasted PGN with no `Date` or `UTCDate` header (or `????.??.??`, or a day that doesn't exist
  such as `2020.02.30`) shows the date `Unknown` and the link `Review: <opponent>, date unknown`;
  `games.date_known` is 0 for it.
  The Result column gives the Player's result and side: `Won with White`, `Lost with Black`,
  `Drew with White`. Below 600px wide the Date and Opening columns fold under the opponent's name,
  so the list never scrolls sideways (320px and up).
  Back from a Review, the list shows as many games as before, scrolled where it was; opened by
  `Import more` instead, it starts at the username, however the Review was left.
- Each row's `More: <opponent>, <date>` button (desktop reachable only) opens `I played <other
  side>` (Imported Games; an Engine Game's side can't change) and `Delete game`; with no room
  below it, as on a phone's last row, the menu opens upwards. A side change on an unreviewed game
  happens at once; on a reviewed one the alert dialog `Did you play <side> against <opponent>?`
  asks first (`Cancel` focused), because the Review goes and its Move Grades leave the Player
  Profile. A list loaded before another device made the Review asks too: the desktop refuses the
  change with `needs-confirm` until `dropReview` says the Player agreed. `Delete game` always
  asks: `Delete the game against <opponent>?` with `Keep the game` (focused; Escape does the
  same) and `Yes, delete it`. Protocol: `games.setSide` and `games.delete`, both refused while
  that game's Review is being made; a refused change says why under its row. A game another
  device already deleted leaves the list when the Player changes or deletes it. Coach notes have
  no link to the Review that wrote them, so a side change or a delete keeps them.
- The message from the last import (what was imported, or the error) clears as soon as the Player
  changes the PGN, the site or the username, so an emptied box with its button disabled shows
  none; so does the side question, which a changed PGN asks again.

## Drive

```bash
$C import-pgn --file game.pgn --side white
$C db get games --where source=pgn
```

Browser: `Site` Lichess, `Username` CoachVerify, `Fetch finished games`.

Pages: `npm run verify -- --seed many-games` (the default seed plus 60 newer games, 61 in all),
then `$C snapshot --route "#/games"` and, in the browser, `Show more`.

## Proof

- "Imported 3 finished games, 0 already in your list, 1 still in progress and skipped" the first
  time; "Imported 0 finished games, 3 already in your list, …" the second.
- `games` rows with `source: lichess` and `source_id` `iinnkv77`, `wab4h6cl`, `wvkkfh56`, and none
  for `livegame1`.
- A `site_imports` row `lichess`, `coachverify`, `imported_through` 1357004146000 (when
  `livegame1`, the newest game, started), and a `site_import_playing` row for `livegame1`.
- `BusyPlayer` (HTTP 429) and `NoSuchPlayer` (404) show clear errors and save nothing.
- `$C import-pgn --pgn "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#" --side white` gives a game with
  `result: 1-0`, `white: White`, `black: Black`; `--pgn "1. e4 e5 2. Nf3"` is refused with "That
  game has no result. …" and saves nothing.
- With `many-games`: 50 rows, the newest 2014-03-01, "Showing 50 of 61 games."; after `Show
  more` 61 rows ending with `Review: ikatsca, 2013-01-05`, "Showing all 61 games." and no
  `Show more`.
- Seed `default`: game 1 reads `Lost with White`; `More` → `I played Black` makes it `Won with
  Black` (`games.player_side` `black`); after a Review, the same change drops the `reviews` and
  `graded_moves` rows and the game's `grade_counts`. `Delete game` → `Yes, delete it` leaves no
  `games` row.
- Seed `empty`: fetch chess.com `coachverify`, delete the newest game, fetch again: it stays
  gone, with a `deleted_games` row `chesscom`, `00000000-0000-4000-8000-000000000002`.

## Gotchas

- Sites answer from `packages/backend/recordings/sites.json` in verify mode; the recordings were
  built by `data-prep/build-site-recordings.py` in the documented API formats.
- A username import brings in finished games straight away rather than offering a list to choose from.
