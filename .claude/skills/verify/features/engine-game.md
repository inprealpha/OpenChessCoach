# Engine Game, with Hints and Live Coaching

A game against Stockfish at one of four levels (Beginner, Casual, Club, Strong). Every move the
Player makes gets its Move Grade in the move list, with Live Coaching on or off. Live Coaching
speaks up only on a Mistake or Blunder, before the Engine replies, and offers to take the move
back. A Hint first asks the Coach for the idea; a second press shows the Engine's move. During
play the Player can look back at earlier positions while the game waits, and try a line of their
own there, which `Analyze` grades.

**Reached from:** Main menu → `Play a game` (`#/engine-game`).

## Sub-features

- The form `New Engine Game`: `Level`, side, the checkbox `Live Coaching in this game` (its
  default comes from Settings), `Start the Engine Game`.
- The status region `Game status` ("Your move", "The Engine is thinking…", the result).
- `Hint` then `Show the move` ("The Engine’s move: X." with a green arrow), said once per
  position: another click only brings the arrow back. The first Hint's words name no move: they
  arrive once the guard has checked them, and one that names a move becomes the general Hint (see
  `puzzles.md`).
- The list `Moves`: each of the Player's moves carries its Move Grade (`Move 1. g4, Mistake`),
  whether Live Coaching is on or off, the move that ends the game included (`Move 2… Qh4#, Best`).
- The Player's last graded move carries its Move Grade symbol on the square it landed on (an
  image named like `Mistake on g4`; none for Good), and keeps it through the Engine's reply
  unless the reply lands on that square. The symbol follows the browser's Move Grade.
- Live Coaching on a Mistake or Blunder: one Coach comment, and `Take the move back` or `Carry on`
  in `Game status`, right under the board, so a 390×844 phone shows them without scrolling. The
  offer is saved with the game: after a reload it is still showing and the Engine waits.
- The header line says "You play White · Engine strength: Casual". The header line's end
  holds `Hint`, `Show threat`, `Flip board` and the menu `Game options` (`⋯ Game`: `Offer a draw`,
  `Resign`, `New game`), which opens downwards. The Coach panel is docked at the foot of the panel (on a phone, at the bottom of
  the screen), so its comment shows with the board in view. While Live Coaching offers to take a
  Mistake back, a dashed red arrow shows the Engine's punishing reply. Until the Coach has said
  something it says what it is for ("The Coach speaks up when a move is a Mistake or Blunder. Press Hint for a nudge.").
- The meter `Winning Chances bar: …` beside the board (see `board-and-engine.md`), with the
  Player's side at the bottom, from the browser Engine's analysis of the position on the board.
- `Show threat` (off by default, remembered on the device): while it's the Player's move, a red dashed arrow
  shows the Engine's threat, from the browser's Engine (see `board-and-engine.md`).
- `Game options` → `Offer a draw`: the Engine agrees ("Draw agreed.") only when it is a piece or more behind or
  facing mate, or from move 20 when neither side is an Inaccuracy's worth of winning chances ahead;
  otherwise "The Engine declines the draw.", even after 1. e4 when the Player is a little better.
- `Game options` → `Resign` asks first: the alert dialog `Resign this game?` with `Keep playing` (focused; Escape
  does the same; focus goes back to `Game options`) and `Yes, resign`. `New game` in the middle of a game asks the same way: `Abandon
  this game?` with `Keep playing` and `Yes, start a new game` (never the browser's `confirm()`).
- The game ends by itself on checkmate, stalemate, insufficient material, the fifty-move rule and
  a position occurring a third time ("Draw by threefold repetition."). The move that draws is
  graded from the draw, in the game and in its Review: a queen up, the third repetition is a
  Blunder. A drawn game's Winning Chances bar reads 50%.
- The game survives a reload. A finished game is saved and offers the link `Review this game`,
  styled as the screen's main button, still after a reload (the device keeps where the game was
  saved; one saved only on the device is sent again once the desktop is back). A game over on the
  board but not saved as over (the app closed in between) ends when it is opened, with no page
  error.
- A finished game ends on one card right under the board, all of it in the first screen on a phone
  at 390×664 (an iPhone 13 in Safari), 402×714, 440×790 and 390×844, in a wider font too
  (DejaVu Sans, as on a Linux runner) and with the result and the summary wrapped onto two lines
  each; on the shorter phones the board gives up room for it (312 px wide at 390×664). A finished
  game reopened (a reload, Back and Forward, or the main menu's `Play a game`) shows the whole card
  the same way: at its final position the panel stays on the card, and only a step back or a
  variation scrolls the move list to its move. `Game status` holds the result ("The Engine won by
  resignation.") and one line: the moves played and the Move Grades that need a look, the worst
  first, counting the Player's Move Grades already shown in the move list ("11 moves · 1 Mistake, 1 Inaccuracy",
  "5 moves · 2 Blunders, 1 Mistake, 1 Inaccuracy", "2 moves · no Mistakes"; a move that never got
  one isn't counted). Under it, on the card but outside `Game status` so a screen reader doesn't
  read the card again when the link arrives: `Review this game` (or, while the game waits on the
  device with the desktop away, the note "Saved on this device." in its place, beside `New game`,
  so the card is no taller and fits the same first screen) and `New game`, which starts a fresh
  game (the `Game options` menu goes once the game is over).
- Focus never drops to the page: after `Yes, resign` or an agreed draw it is on `Review this game`
  (`New game` while the game waits on the device); after New game, on the form's checked colour.
- A game deleted from the game list still shows its card on the device that played it; its
  `Review this game` then says "That game is not in your game list." with `Back to the menu`.
- The game steps through its moves, during play and once it is over: the step buttons in the thumb
  bar (◀ ▶ on a phone, ⏮ ◀ ▶ ⏭ on a desktop), the keys ← → Home End ↑ ↓ (see
  `board-and-engine.md`) and the move list's buttons, with the Move Grade symbol following the
  step. The keys leave the board alone while the `Game options` menu (or a dialog) is open. During
  the Blunder pause the choice takes the steps' row, and the keys and the move list do nothing
  until the Player chooses; a look back taken while the move was graded ends, so the board shows the
  move the choice is about and the choice is at the top of the panel, in a phone's first screen.
  `Take the move back` also ends any look back.
- Looking back during play changes nothing in the game: it stays at its latest position, where
  its next move is played. A bar at the top of the panel, the group `Away from the game`, names
  the position by the move that reached it, as the move list writes it ("Looking at 8. Bb3",
  "Looking at 1… e5", "Looking at the start"), on a desktop also "· The Engine has played 12… d5"
  once the Engine has replied meanwhile (on a phone the bar keeps to one row and leaves that out),
  and offers `Back to the game`. The button goes with the bar: after it the game's status card is
  back at the panel's top and the focus is on the board, where the next move is played. If
  the Engine moves while the Player looks back, the board stays where they are, except when that
  move ends the game: then the board shows the final position the end-of-game card is about. The
  game's own next move played on the board steps to it.
  Away from the latest position the header line has no `Hint` or `Show threat`, the board no
  Hint, Coach or threat arrows, the panel no `Live Coaching in this game` checkbox, and the Coach
  panel no longer says "Press Hint for a nudge".
- Any other move on an earlier position during play starts the Player's own line (a variation,
  the list `Variation from …`); the game's moves and its saved record are unchanged, and the
  Engine's reply to the game still comes. The bar says "Your own line", on a desktop with where it
  branched ("Your own line after 1… e5", "Your own line from the start"), with `Analyze` and
  `Back to the game`. Until `Analyze` the line shows no Move Grades and no Winning Chances (the meter reads `Winning Chances bar: press Analyze to see them`), and
  the browser's Engine searches none of its positions, so the game's search never waits behind
  them. `Analyze` grades the line's moves (and those played on it afterwards), draws the
  Engine's best move in green (`Engine’s best: …`), brings the bar back, and asks the Coach one
  Why Question about the move shown ("Why exd4?" in the Coach conversation), as a Review's
  variation does; then the button goes until the board shows another position of the line. With
  the desktop away, `Analyze` grades and draws the arrow and makes no Coach call. Moving pieces
  never calls the Coach. The line has a Coach thread of its own, shown in the Coach panel while
  the board is on it: `Back to the game` (or a pick in the game's move list) drops it, an answer
  still on its way included, and nothing said about the line reaches a brief about the game
  (ADR 0009).
- At the game's latest position during play, a refused move says why ("It’s the Engine’s move.",
  "Take the move back or carry on first.").
- A finished game's board is free to explore: a move there starts a variation (see
  `explore.md`), graded at once as before, a piece picked up during the game is dropped when it
  ends, and a declined draw is no longer reported once the game ends. A look back or a line of the
  Player's own ends with the game. The board shows no arrows (Hint, Coach or threat), the
  `Show threat` button goes, and so does the Coach panel: nothing the Coach said during play (a
  Live Coaching comment, a Hint, "Move taken back.") is left, after a reload too, and the thumb
  bar keeps the steps.
- The game list, the Review and the PGN name the Engine by its level: `Engine (Beginner)`. Games
  saved as `Engine (level 1)` before levels were named read the same way.
- Settings → Coach quality → Advanced chooses the Coach model per job; the chosen model is what the
  Coach receives. Two model changes made at once are both saved (`engine-game.spec.ts`).

## Drive

Browser: `#/engine-game`, `Start the Engine Game` as White, play `g2g4` (a Mistake) to see Live
Coaching, reload (the offer is still there), `Take the move back`, then `Game options` → `Resign` → `Yes, resign`. coachctl: `$C play --moves "e4 Nf3" --resign`.

Looking back: a few moves in, press ← a few times (the bar reads "Looking at …"), play a move that
isn't the game's ("Your own line"), then `Analyze`; `Back to the game` returns to the latest
position. To have the Engine reply while the Player looks back, the journeys hold the browser's Engine (`holdBrowserEngine` in `engine-game.spec.ts`).

## Proof

- After 1.g4 the move list reads `Move 1. g4, Mistake`, with Live Coaching on or off, and the
  `Engine Game board` shows the image `Mistake on g4`; after taking it back and playing 1.e4 it
  shows `Best on e4` once the Engine has replied.
- After 1.g4 with Live Coaching on, the Coach panel shows one comment and `coach_calls` has exactly one `live` call; after
  1.e4 (Best) there is none.
- After `Game options` → `Resign` → `Yes, resign`: "The Engine won by resignation." and a `games` row with `source: engine`.
- `Review this game` opens the Review of that game ("You had White · Lost 0-1 · vs Engine (Beginner)"), and is still there after a reload.
- After 1. e4 at Casual, `Offer a draw` reads "The Engine declines the draw."; with the Engine a
  queen down it reads "Draw agreed." and the `games` row is `1/2-1/2`. Both knights out and back
  twice end the game "Draw by threefold repetition." (`engine-game.spec.ts`). A queen up after
  3. Qxg5, the knight shuffle's 7. Ng1 reads `Move 7. Ng1, Blunder` and the bar
  `White’s winning chances: 50%`; `$C review` of that game lists 7. Ng1 as a key moment.
- The Winning Chances bar reads `White’s winning chances: 53%` at the start as White, then the
  desktop Engine's verdict on the position after 1. e4 and the Engine's reply; as Black it names
  Black and Black fills it from the bottom (`engine-game.spec.ts`, "the Winning Chances bar
  follows an Engine Game …").
- During play, ← shows the position before the last move ("Looking at 1. e4"), `First position`
  the start ("Looking at the start"), the game's own 1. e4 played there steps forward rather than
  branching, and End brings the game back, with its move list and saved moves unchanged ("an
  Engine Game steps through its moves during play and once it is over, with the buttons or the
  arrow keys"). With `Game options` open, ←, Home and ↑ leave the board where it is ("the arrow
  keys leave the board alone while the Game options menu is open").
- Looking back at 1… e5 while the Engine replies to 3. Bc4, the board stays there and the bar reads
  "Looking at 1… e5 · The Engine has played 3… Nf6", with no `Hint`, `Show threat` or arrows and no
  "Press Hint for a nudge"; at 390×664 the bar's first words and `Back to the game` are fully on
  screen and "The Engine has played" is hidden; `Back to the game` shows the latest position and
  the threat arrow again ("if the Engine moves while the Player looks back, the board stays put and
  the bar says what it played"). `Back to the game` pressed with Enter leaves the focus on the
  `Engine Game board` ("Back to the game leaves the focus on the board, …"). When the Engine's
  reply mates instead, the board shows the final position and the bar is gone ("when the Engine’s
  reply ends the game while the Player looks back, the board shows how it ended").
- 2. d4 exd4 played on the position after 1… e5 shows "Your own line after 1… e5",
  `Variation move 2. d4` with no Move Grade, no grade symbol and the meter
  `Winning Chances bar: press Analyze to see them`; no search of those positions reached the
  browser's Engine, `coach_calls` is empty, and the saved game still holds its six moves ("a move
  on an earlier position during play starts the Player’s own line: …"). After `Analyze`: both
  moves graded, one `Engine’s best: …` arrow, the bar's percentage, "Why exd4?" in the Coach
  conversation, and `coach_calls` holds exactly one `why` call; the button goes, and 3. Qxd4
  afterwards is graded with no new call ("Analyze on the Player’s own line shows its Move Grades,
  …").
- An `Analyze` answer still on its way when the Player presses `Back to the game` never shows in
  the game's Coach panel ("an Analyze answer still on its way …"), and a Hint after an answered
  `Analyze` has no `summary` in its brief ("what the Coach said about the Player’s own line stays
  out of the next brief about the game").
- At 390×664, a look back taken while Ba6 (a Blunder) is graded ends when the choice appears: the
  board shows the move, and a tap on `Move 1. e4` or a move on the board doesn't look back, with
  `Take the move back` and `Carry on` fully on screen ("Live Coaching › during the choice to take a
  Mistake back, the board stays on the move it is about and the choice stays in view").
- After resigning at move 11 the card reads "The Engine won by resignation." and "11 moves · 2
  Blunders, 2 Mistakes, 2 Inaccuracies", with `Review this game` and `New game` fully on screen at
  390×664, 402×714, 440×790 and 390×844; so do "The Engine won by checkmate." and "Draw by
  threefold repetition.", in the app's font, in DejaVu Sans and with both lines wrapped ("on a
  phone at 390×664 in …, the end-of-game card sits under the board, all of it in the first
  screen"). The whole card is on screen again after a reload, after Back and from the main menu
  ("on a phone at …, a finished game reopened shows its whole end-of-game card"), and with the
  desktop stopped "Saved on this device." and `New game` fit too ("on a phone at … with the desktop
  away, the end-of-game card and its note fit the first screen"). After a Live Coaching comment
  and a take-back, nothing the Coach said is left once the game ends, after a reload too ("Live
  Coaching › once the game ends, nothing the Coach said during play is left in the panel").
- With Threat on, 1.e4 (the Engine answers 1...d5) shows `Threat: Black threatens dxe4 (d5 to e4)`,
  and 2.exd5 Nf6 shows `Threat: Black threatens Nxd5 (f6 to d5)` (`engine-game.spec.ts`).

## Gotchas

- The Engine's replies and the Move Grades shown during the game come from the browser's Engine,
  so an Engine Game works with the desktop away. `Show the move` asks the desktop's Engine first,
  like the facts behind the first Hint, and the browser's only when the desktop can't be reached. Live Coaching is
  triggered by the browser's Move Grade, but the facts in every Coach brief (Live Coaching, Hint)
  come from the desktop's Engine (ADR 0007).
- A Review regrades the whole game on the desktop, so its Move Grades can differ slightly from the
  ones shown during the game; the Review's are the record that counts.
- Verify mode plays the Engine at full skill at the level's depth, so its replies are repeatable.
- Live Coaching makes one Coach call per Mistake or Blunder, never per move. A reload while the
  takeback offer shows makes no new call: the saved comment is shown again.
