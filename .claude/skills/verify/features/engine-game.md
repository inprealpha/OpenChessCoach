# Engine Game, with Hints and Live Coaching

A game against Stockfish at one of four levels (Beginner, Casual, Club, Strong). Every move the
Player makes gets its Move Grade in the move list, with Live Coaching on or off. Live Coaching
speaks up only on a Mistake or Blunder, before the Engine replies, and offers to take the move
back. A Hint first asks the Coach for the idea; a second press shows the Engine's move.

**Reached from:** Main menu → `Play a game` (`#/engine-game`).

## Sub-features

- The form `New Engine Game`: `Level`, side, the checkbox `Live Coaching in this game` (its
  default comes from Settings), `Start the Engine Game`.
- The status region `Game status` ("Your move", "The Engine is thinking…", the result).
- `Hint` then `Show the move` ("The Engine’s move: X." with a green arrow), said once per
  position: another click only brings the arrow back.
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
  each; on the shorter phones the board gives up room for it (312 px wide at 390×664). `Game status` holds the result ("The Engine won by resignation.")
  and one line: the moves played and the Move Grades that need a look, the worst first, counting
  the Player's Move Grades already shown in the move list ("11 moves · 1 Mistake, 1 Inaccuracy",
  "5 moves · 2 Blunders, 1 Mistake, 1 Inaccuracy", "2 moves · no Mistakes"; a move that never got
  one isn't counted). Under it, on the card but outside `Game status` so a screen reader doesn't
  read the card again when the link arrives: `Review this game` (or "Saved on this device…") and
  `New game`, which starts a fresh game (the `Game options` menu goes once the game is over).
- Focus never drops to the page: after `Yes, resign` or an agreed draw it is on `Review this game`
  (`New game` while the game waits on the device); after New game, on the form's checked colour.
- A game deleted from the game list still shows its card on the device that played it; its
  `Review this game` then says "That game is not in your game list." with `Back to the menu`.
- The game steps through its moves, during play and once it is over: the step buttons in the thumb
  bar (◀ ▶ on a phone, ⏮ ◀ ▶ ⏭ on a desktop), the keys ← → Home End ↑ ↓ (see
  `board-and-engine.md`) and the move list's buttons, with the Move Grade symbol following the
  step. During the Blunder pause the choice takes the steps' row, and the keys wait for it.
- Looking back during play changes nothing in the game: it stays at its latest position, where
  its next move is played. A bar at the top of the panel, the group `Away from the game`, says
  "Looking at move 8", on a desktop also "· The Engine has played 12… d5" once the Engine has
  replied meanwhile, and offers `Back to the game`. If the Engine moves while the Player looks
  back, the board stays where they are. The game's own next move played on the board steps to it.
  Away from the latest position the header line has no `Hint` or `Show threat`, and the board no
  Hint, Coach or threat arrows.
- Any other move on an earlier position during play starts the Player's own line (a variation,
  the list `Variation from …`); the game's moves and its saved record are unchanged, and the
  Engine's reply to the game still comes. The bar says "Your own line" ("from move 8" on a
  desktop) with `Analyze` and `Back to the game`. Until `Analyze` the line shows no Move Grades
  and no Winning Chances (the meter reads `Winning Chances bar: press Analyze to see them`), and
  the browser's Engine searches none of its positions, so the game's search never waits behind
  them. `Analyze` grades the line's moves (and those played on it afterwards), draws the
  Engine's best move in green (`Engine’s best: …`), brings the bar back, and asks the Coach one
  Why Question about the move shown, as a Review's variation does; then the button goes until the
  board shows another position of the line. Moving pieces never calls the Coach. `Back to the
  game` puts the Coach's answer away behind "Earlier".
- A finished game's board is free to explore: a move there starts a variation (see
  `explore.md`), a piece picked up during the game is dropped when it ends, and a declined draw is
  no longer reported once the game ends. While the game is on, a refused move says why ("It’s the
  Engine’s move.", "Take the move back or carry on first."). It shows no arrows (Hint, Coach
  or threat), the `Show threat` button goes, and so does the Coach panel: nothing the Coach said
  during play (a Live Coaching comment, a Hint, "Move taken back.") is left, and the thumb bar
  keeps the steps.
- The game list, the Review and the PGN name the Engine by its level: `Engine (Beginner)`. Games
  saved as `Engine (level 1)` before levels were named read the same way.
- Settings → Coach quality → Advanced chooses the Coach model per job; the chosen model is what the
  Coach receives. Two model changes made at once are both saved (`engine-game.spec.ts`).

## Drive

Browser: `#/engine-game`, `Start the Engine Game` as White, play `g2g4` (a Mistake) to see Live
Coaching, reload (the offer is still there), `Take the move back`, then `Game options` → `Resign` → `Yes, resign`. coachctl: `$C play --moves "e4 Nf3" --resign`.

Looking back: a few moves in, press ← a few times, play a move that isn't the game's, then
`Analyze`; `Back to the game` returns. To have the Engine reply while the Player looks back, the
journeys hold the browser's Engine (`holdBrowserEngine` in `engine-game.spec.ts`).

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
- During play, ← shows the position before the last move ("Looking at move 1") and End brings
  the game back, with its move list and saved moves unchanged. Looking back at move 1 while the
  Engine replies to 3. Bc4, the board stays there and the bar reads "Looking at move 1 · The
  Engine has played 3… Nf6"; on a 390×664 phone the bar's first words and `Back to the game` are
  fully on screen (`engine-game.spec.ts`).
- 2. d4 exd4 played on the position after 1… e5 shows `Variation move 2. d4` with no Move Grade,
  no grade symbol and the meter `Winning Chances bar: press Analyze to see them`; no search of
  those positions reached the browser's Engine, `coach_calls` is empty, and the saved game still
  holds its six moves. After `Analyze`: both moves graded, one `Engine’s best: …` arrow, the
  bar's percentage, and `coach_calls` holds exactly one `why` call; 3. Qxd4 afterwards is graded
  with no new call (`engine-game.spec.ts`).
- After resigning at move 11 the card reads "The Engine won by resignation." and "11 moves · 1
  Mistake, 1 Inaccuracy", with `Review this game` and `New game` fully on screen at 390×664,
  402×714, 440×790 and 390×844, also for "The Engine won by checkmate." and "Draw by threefold
  repetition.", in a wide font and with both lines wrapped; after a Live Coaching comment and a take-back, nothing the Coach
  said is left once the game ends, after a reload too (`engine-game.spec.ts`).
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
