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
- The Coach panel comes before the move list. Until the Coach has said something it says what it
  is for ("The Coach speaks up when a move is a Mistake or Blunder. Press Hint for a nudge.").
- The meter `Winning Chances bar: …` beside the board (see `board-and-engine.md`), with the
  Player's side at the bottom, from the browser Engine's analysis of the position on the board.
- `Threat` (off by default, remembered on the device): while it's the Player's move, a red arrow
  shows the Engine's threat, from the browser's Engine (see `board-and-engine.md`).
- `Offer a draw`: the Engine agrees ("Draw agreed.") only when it is a piece or more behind or
  facing mate, or from move 20 when neither side is an Inaccuracy's worth of winning chances ahead;
  otherwise "The Engine declines the draw.", even after 1. e4 when the Player is a little better.
- `Resign` asks first: the alert dialog `Resign this game?` with `Keep playing` (focused; Escape
  does the same) and `Yes, resign`. `New game` in the middle of a game asks the same way: `Abandon
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
- A finished game ends on one card right under the board (a 390×844 phone shows all of it).
  `Game status` holds the result ("The Engine won by resignation."), "N moves · You played White ·
  Engine: Beginner" and the list `Your Move Grades in this game`, counting the Player's Move Grades
  already shown in the move list (`★ 3 Best`, `✓ 4 Good`, `?! 0 Inaccuracies`, `? 0 Mistakes`,
  `?? 0 Blunders`; the symbols are hidden from screen readers, zero counts are in the muted text
  colour and still meet WCAG AA, and a move that never got one isn't counted). Under it, on the
  card but outside `Game status` so a screen reader doesn't read the card again when the link
  arrives: `Review this game` (or "Saved on this device…") and `New game`, which starts a fresh
  game (the toolbar's New game goes once the game is over).
- Focus never drops to the page: after `Yes, resign` or an agreed draw it is on `Review this game`
  (`New game` while the game waits on the device); after New game, on the form's checked colour.
- A game deleted from the game list still shows its card on the device that played it; its
  `Review this game` then says "That game is not in your game list." with `Back to the menu`.
- A finished game steps through its moves: the step buttons, the keys ← → Home End ↑ ↓ (see
  `board-and-engine.md`) and the move list's buttons, with the Move Grade symbol following the
  step. While the game is on there are no step buttons and the keys do nothing: the board always
  shows the position to play from (`engine-game.spec.ts`, "a finished game steps through …").
- A finished game's board is read-only: clicks on it do nothing (no "That move isn’t legal."),
  and a declined draw is no longer reported once the game ends. It shows no arrows (Hint, Coach
  or threat), the `Threat` button goes, and the Coach panel stays only if the Coach said something.
- The game list, the Review and the PGN name the Engine by its level: `Engine (Beginner)`. Games
  saved as `Engine (level 1)` before levels were named read the same way.
- Settings → Coach quality → Advanced chooses the Coach model per job; the chosen model is what the
  Coach receives. Two model changes made at once are both saved (`engine-game.spec.ts`).

## Drive

Browser: `#/engine-game`, `Start the Engine Game` as White, play `g2g4` (a Mistake) to see Live
Coaching, reload (the offer is still there), `Take the move back`, then `Resign` → `Yes, resign`. coachctl: `$C play --moves "e4 Nf3" --resign`.

## Proof

- After 1.g4 the move list reads `Move 1. g4, Mistake`, with Live Coaching on or off, and the
  `Engine Game board` shows the image `Mistake on g4`; after taking it back and playing 1.e4 it
  shows `Best on e4` once the Engine has replied.
- After 1.g4 with Live Coaching on, the Coach panel shows one comment and `coach_calls` has exactly one `live` call; after
  1.e4 (Best) there is none.
- After `Resign` → `Yes, resign`: "The Engine won by resignation." and a `games` row with `source: engine`.
- `Review this game` opens the Review of that game, and is still there after a reload.
- After 1. e4 at Casual, `Offer a draw` reads "The Engine declines the draw."; with the Engine a
  queen down it reads "Draw agreed." and the `games` row is `1/2-1/2`. Both knights out and back
  twice end the game "Draw by threefold repetition." (`engine-game.spec.ts`). A queen up after
  3. Qxg5, the knight shuffle's 7. Ng1 reads `Move 7. Ng1, Blunder` and the bar
  `White’s winning chances: 50%`; `$C review` of that game lists 7. Ng1 as a key moment.
- The Winning Chances bar reads `White’s winning chances: 53%` at the start as White, then the
  desktop Engine's verdict on the position after 1. e4 and the Engine's reply; as Black it names
  Black and Black fills it from the bottom (`engine-game.spec.ts`, "the Winning Chances bar
  follows an Engine Game …").
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
