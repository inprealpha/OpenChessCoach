# UI/UX playtest: three Players, desktop and phone

Three playtesters used the app on 1 November 2026, each as one kind of Player, at desktop size
(1280 by 800) and phone size (390 by 844). This round looked at layout, navigation and interaction,
not at what the Coach says: an earlier study covered the Coach's text. The findings feed the
interface guidelines in [`docs/design/interface-guidelines.md`](../design/interface-guidelines.md).

| Player | Who they are | What they did |
| --- | --- | --- |
| Absolute beginner | Barely knows how the pieces move, no online account, Goal "Stop blundering pieces" | First run, a beginner Lesson with right and wrong moves and a Hint, an Engine Game at the lowest strength with a deliberate blunder, its Review, a Puzzle, Player Profile, Settings |
| Casual improver, about 1000 | Plays on chess.com now and then, wants to know why they lose | Main menu, game list, import by chess.com username, the Review of a lost game as White and one as Black, a Why Question, the Board, an Engine Game |
| Club player, 1400 to 1800 | Plays regularly, knows some theory, expects a Lichess-style analysis board | The Board with Engine lines, Threat and a variation, an Engine Game as Black at the strongest level, the Review of a game played as Black |

## The short version

The board itself works well: drag and click moves, Move Grade symbols, the last-move highlight, the
Winning Chances bar and graph. What hurts is everything around it. The screens are long pages of
stacked cards, so the thing the Player wants next (the Coach's explanation, the box to ask a
question, the move list) is two to four screens away from the board, above all on a phone. And the
boards that show a position to learn from (Review, the end of a Lesson, a solved Puzzle) don't let
the Player move a piece to try their own idea.

Ranked by how many Players they hurt and how often:

1. **You can't move pieces to explore.** In a Review, at the end of a Lesson and after a Puzzle, a
   click or a drag does nothing and says nothing (`movable="none"`). There is no "open this position
   on the Board". The only free board is a small link under the main menu's cards. All three Players
   hit this.
2. **The question box is at the bottom of the page.** In a Review the Coach panel comes after the
   overview, every key moment card and the move list: at y=1769 of a 1833 px page on desktop, y=2790
   of 2871 on a phone. On a phone's first visit it isn't there at all until a move is picked. The
   answer lands at the bottom too.
3. **On a phone the board and the words are never on screen together.** In a Review, tapping a key
   moment scrolls to the board, and the moment's text is 950 to 1740 px below it. Asking a Why
   Question scrolls the board off entirely. The board is sticky on desktop but not on a phone. The
   same happens in Lessons and in the Engine Game's Blunder pause, where the Coach's reason is below
   the fold while the Player must choose "Take the move back" or "Carry on".
4. **Arrows have no legend and change meaning between screens.** A key moment draws up to four
   arrows in three colours (the move played, the best move, the second choice, the move many players
   would reach for), two of them red, often ending on the same square. Threat adds another red arrow.
   A Lesson uses orange and red; the Engine Game red and green.
5. **Two numbers for one idea, with a sign that flips.** Every percentage has a bare evaluation
   beside it ("48% -0.25"). On the Board the sign follows the side to move; in the Review it follows
   the Player's side, so for a Black Player "+0.33" means Black is better. Chess.com and Lichess
   readers take "+" as White better.
6. **The Review repeats itself.** A key moment card shows the same Before and After numbers three
   times: the bold lines, the "Better:" line and the Coach's paragraph. Cards are about 250 px tall on
   desktop and 400 px on a phone. One Coach sentence read "your winning chances went from Black's
   winning chances: 68% to Black's winning chances: 34%": the Coach brief's `winningChances` values
   are whole labels ("Black's winning chances: 59%"), and the prompt
   (`packages/backend/src/coach/prompts.ts`) asks the Coach to write "went from 48% to 35%", so the
   real Coach doubles the label.
7. **The move list is far from the board and hard to scan.** It is a five-row box with its own
   scroll, at the bottom of the side column (about 900 px from the step buttons on desktop), drawn as
   wrapping chips instead of two columns. In the Engine Game its moves look like buttons but do
   nothing during play, and neither do the arrow keys.
8. **"Better" moves are text, not actions.** "Better: axb4 48% (-0.20), Ng5 44%…" can't be shown on
   the board or played out.
9. **The main menu leads with the wrong thing for a beginner.** The big first card is "Import your
   games"; Learn is last; nothing says "continue your next Lesson". The Board, the club player's main
   tool, is a small text link.
10. **Controls of different weight sit in one row.** The Engine Game's Hint, Offer a draw, Resign,
    New game and Threat look the same. On the Board, New board (which clears the game without asking)
    sits next to Flip board. Threat's "on" state is only a thin red outline and carries over to other
    screens.
11. **The Review has no Flip board and no Engine lines.** The board for a game played as Black is
    shown from Black's side, correctly (h-file on the left, rank 1 at the top), but there is no way to
    flip it, which makes it look wrong to someone used to White's side. Only the key moments show
    candidate moves; the other positions show none.
12. **Coordinates are hard to read.** About 9 px, low contrast, partly covered by pieces (the "g"
    under a king on g8), with no setting to make them bigger.

## The four reports we set out to check

| Report | Verdict | Evidence |
| --- | --- | --- |
| You scroll all the way down to ask a question in the Review | Confirmed | The Coach panel is the last element: desktop y=1769 of 1833 px, phone y=2790 of 2871. With no key moment open it is missing on a phone. |
| The board looks flipped, with the files reversed | Not a bug in the board, but a missing control | A game played as Black is drawn from Black's side with correct coordinates and pieces, as in the Engine Game. The Review has no Flip board button (the Board screen has one), and nothing says whose side the board shows. |
| "Black's winning chances" said twice in the 16… b5 text | Confirmed, cause found | The brief's `winningChances.before` and `.after` are full labels; the prompt's example wants bare percentages. A fix belongs in the brief or the prompt, not in this round's layout work. |
| Pieces can't be moved freely in the Review | Confirmed | Clicks and drags leave the position unchanged on desktop and phone; the Review board is `movable="none"`. The same holds at a Lesson's end and after a Puzzle. |

## By screen

### Review

| Finding | Size | Severity |
| --- | --- | --- |
| Pieces can't be moved; nothing links to the Board with the position | Both | High |
| The Why Question box and its answer are at the bottom; key moment cards have no Ask of their own | Both | High |
| The board and the open key moment are never on screen together; the board isn't sticky | Phone | High |
| Order on a phone: board, bar, step buttons, graph, overview, then key moments at y=1076 of 844; the first screen has no words | Phone | Medium |
| Up to four arrows with no legend; two reds; the played move can hide under another arrow | Both | Medium |
| The same Before and After numbers three times per card | Both | Medium |
| "Better" moves are plain text | Both | Medium |
| No Flip board, no Engine lines outside key moments | Both | Medium |
| A free-text question is tied to the position on the board, but the box never says which move it asks about (a question about a lost queen, asked on move 1, was answered about 1. e4) | Both | Medium |
| The move list is a small inner-scroll box far below the step buttons | Both | Low |
| The header never says which side the Player had or that they lost | Both | Low |
| Desktop opens on the first key moment, a phone on the start position | Both | Low |
| The graph has no axis or legend and takes 180 px above the overview on a phone | Phone | Low |

### Lesson

| Finding | Size | Severity |
| --- | --- | --- |
| After a Why Question the board is off screen; after Continue the next decision opens part-scrolled with the top ranks cut off | Phone | Medium |
| A wrong move draws orange and red arrows with no legend; a red arrowhead covers the ?? badge | Both | Medium |
| The Hint is text only, nothing on the board, then "Show the move" | Both | Medium |
| The Lesson ends with no free board to try the idea | Both | Medium |
| "How moves are written" is collapsed at the bottom of the page, after the Player needed it | Both | Low |
| The Coach log keeps every earlier part, and each reply opens "What are your options here?" | Both | Low |

### Engine Game

| Finding | Size | Severity |
| --- | --- | --- |
| The Blunder pause's reason is below the fold while the Player must choose | Phone | High |
| The Blunder pause draws no arrow for the move that wins the piece | Both | High |
| Hint and Live Coaching replies land below the fold; only the Hint button's label changes | Phone | Medium |
| The move list's chips are inert during play; arrow keys do nothing; step buttons only after the game | Both | Medium |
| Strength defaults to Casual although the Player Profile says Beginner; strengths have no description | Both | Medium |
| Hint, Offer a draw, Resign, New game and Threat in one row, one style | Both | Low |
| Hint is greyed out with no reason while "Take the move back?" waits | Both | Low |
| Every move carries a Good or Best pill, so Mistakes are lost in a sea of green | Both | Low |

### Board

| Finding | Size | Severity |
| --- | --- | --- |
| A new move after stepping back deletes the rest of the line without asking | Both | High |
| The evaluation's sign follows the side to move; the lines' heading switches side every move | Both | Medium |
| Engine lines can't be clicked or previewed and have no move numbers | Both | Medium |
| The first Engine line starts at y=838 of 844 on a phone | Phone | Medium |
| New board, which clears the game without asking, sits next to Flip board | Both | Low |

### Main menu, game list and import

| Finding | Size | Severity |
| --- | --- | --- |
| "Import your games" is the hero card; Learn is last; no "continue" | Both | High (beginner) |
| The Board is a small inline link | Both | Low |
| The game list sits under two import forms (first game at y≈1340 on a phone); no filter by result; a loss looks like a win | Both | Medium |
| Newly imported games sort to the end behind "Show more", with no highlight | Both | Medium |

### First run, Puzzles, Player Profile, Settings

| Finding | Size | Severity |
| --- | --- | --- |
| "Start with the Lessons" is below the fold under an optional account section | Both | Medium |
| Puzzles default to "Mixed: every Lesson", including untaught topics; no Hint, only "Show the solution" | Both | Medium |
| Puzzles show an internal id ("nCEuI · rated 901") | Both | Low |
| A phone opens Settings on a large pairing QR code; no board display options | Phone | Low |

## What works and should be kept

- The board: drag and click moves, the last-move highlight, Move Grade symbols on the landing square
  and in the move list (★ ✓ ?! ? ??, with a word and one colour per grade everywhere).
- The Winning Chances bar with the percentage at both ends, flipping with the board.
- The Winning Chances graph's Mistake and Blunder dots, which jump to the move. The best navigation in
  the Review.
- The sticky board column on desktop, which stays in view while reading.
- Step buttons right under the board, with Lichess's keys (← → Home End) on the Board and Review.
- The overview's move links, which jump the board to that position.
- The Engine Game's Blunder pause, with "Take the move back" as the main button.
- In a Lesson, "Try another move" and "Continue with the Lesson's move" after a weak move, and "You
  play Black in this part." when the board turns.
- The Hint escalating to "Show the move" in the same place.
- The Board's Engine lines, with the percentage large and the evaluation small, and Set up a position
  taking a FEN or a whole PGN.

## How this was tested

Each playtester ran its own disposable copy of the app in verify mode (`npm run verify`, seeds
`empty`, `many-games` and `default`) from `main` at 99a0ea7, with the fake Coach, and drove it with
Playwright by accessible name at 1280 by 800 and at 390 by 844 with touch. No real model was called.
The club player imported a game played as Black and reviewed it. About 230 screenshots are in the
project's files under `evidence/ui-ux-playtest/` (`beginner/`, `casual/`, `club/`).

Not covered: a real phone paired by QR code, offline mode, the real Coach's waiting times (the
earlier study measured them: 7 to 63 seconds), and Lessons beyond the first of each track.
