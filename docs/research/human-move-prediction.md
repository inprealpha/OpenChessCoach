# Can Claude guess the move a human plays?

Research for a possible future Coach layer. The idea: the Coach guesses the move that would jump out at a human, the obvious move a player reaches for without calculating. The Engine then checks it. If the obvious move is bad, the Coach can explain why. If it is good, the Coach can say so (ADR 0002, ADR 0009). Before building this, we wanted to know three things:

1. Do Haiku, Sonnet and Opus suggest different moves?
2. At which Lichess rating band does each model's guessing work best, when it is not told the rating?
3. How much better are the more expensive models at guessing the instinctive move, above all when that move is a mistake?

This is a one-off measurement. It does not change the app. Both runs were made on 28 October 2026 with `data-prep/human-moves.ts`, on real Lichess games. Every model guessed every position in its own separate call, with no memory of other positions, at medium effort.

- **Part 1, quick moves.** This is the part that matters for the layer. It used 408 moves that the human made in 1 to 3 seconds, bullet games included. Half of them were moves the Engine grades as fine and half were Inaccuracies or worse. Each model was asked twice, with two different prompts: 2,448 calls.
- **Part 2, every kind of move.** This was the first run. It used 708 positions with no limit on thinking time and no bullet games: 2,124 calls.
- **Part 3, running Maia inside the app.** A prototype that converts Maia2 to run from Node, checks its moves against the original, and sketches the background download.

Both parts also compare against Maia2, a free model built only to predict human moves. It was added after Abir approved downloading it.

## Short answer

- **Maia-3's smallest model is the best guesser of all, and it is free.** Maia-3 is the successor to Maia2, from the same University of Toronto lab. It is a neural network trained only to predict human moves.
  - On the quick mistakes, the 5M model's first guess was the human's move 41% of the time, and its top three held it 69% of the time. Opus managed 25% and 54%.
  - On every quick move, it scored 54% / 78%, against Maia2's 49% / 78%. It beats Maia2 on the first guess (p = 0.001) and ties on the top three.
  - The 5M model is a 21 MB file, and it was as good as the 316 MB 79M model on our positions: 54% / 78% against 56% / 78%, a gap within chance. The paper behind Maia-3 finds the same: the 5M model reaches about 97% of the largest one's accuracy.
  - It reads the last 8 positions of the game, and it uses the player's rating. Without the game's history, its first guess on mistakes drops from 41% to 31%. With a flat 1500 instead of the real rating, it drops to 35%.
  - Its code is AGPL-3.0, and the weights have no stated licence (Part 3).
- **Maia2 also beats all three Claude models.** Maia2 learned from Lichess games played from 2018 to 2023, and its code is MIT-licensed.
  - On the quick mistakes, its first guess was the human's move 35% of the time, and its top three held the move 68% of the time. Opus managed 25% and 54%. Both gaps are unlikely to be chance (p = 0.006 and p < 0.001).
  - Over every kind of move (Part 2), Maia2 scored 51% / 80% against Opus's 43% / 69%.
  - Told a fixed rating of 1500 for everyone instead of the player's real rating, Maia2 scored almost the same.
- **Among the Claude models, Opus saw the quick mistake coming most often, about half the time.** Opus had the human's move among its three guesses 54% of the time. Sonnet had it 46% of the time and Haiku 42%. Opus's lead over both is unlikely to be chance (p = 0.02 against Sonnet, p = 0.004 against Haiku). Sonnet and Haiku are not clearly different from each other. The Engine's top three held the mistake only 19% of the time, as you'd expect, since it lists good moves.
- **On the single most likely guess, the models tie on mistakes.** Each model's first guess was the human's mistake about 25% of the time. Opus's advantage comes from what it puts in second and third place.
- **On quick moves that were fine, Opus is far ahead.** There, Opus's first guess was right 58% to 61% of the time. Sonnet managed 44% to 47% and Haiku 37% to 41%.
- **Asking for "the instinctive move" made no difference.** The new prompt says the player moved within a few seconds, on instinct, and asks which moves would jump out at a glance. It scored the same as the original prompt for every model. No difference was beyond chance; the biggest was Opus's top three, 3 points better (p = 0.07). The models already guess the instinctive move when asked for the likely move.
- **The three models often disagree.** With the instinct prompt, all three gave the same first move in only 31% of quick positions. In 27%, all three gave different first moves.
- **No model fits one rating band clearly better.** This held in both parts: no Claude model's hit rate differed across the bands by more than chance would explain. Maia2 was the one exception: in Part 1 it found the quick moves of 2000+ players harder to predict (68% in its top three, against 79% to 83% for the other bands; p = 0.03). Opus and Sonnet found the quick mistakes of 2000+ players the hardest to predict (Opus 43% to 45% in its top three, against 49% to 63% for the other bands).
- **Over every kind of move (Part 2), the order was the same.** First guess / top three: Opus 43% / 69%, Sonnet 34% / 55%, Haiku 30% / 49%. Always guessing the Engine's best moves gives 33% / 60%.
- **Together with the Engine, Maia catches three quarters of the tempting mistakes.** The Engine's top 5 alone held the human's quick mistake in 38% of cases. Adding Maia2's 3 guesses raised that to 74%, and Maia-3 5M's to 73%. Adding Opus's raised it to 63%, Sonnet's to 58% to 60% and Haiku's to 57% to 59%.

**Decision (28 October 2026).** Abir chose Maia-3's 5M model and accepted its AGPL licence. ADR 0010 records the decision. What follows is the reasoning, from before the decision.

**My opinion.** The layer is worth building, and a Maia model should do the guessing, not Claude. I recommend Maia-3's 5M model, if Abir accepts its licence. Otherwise use Maia2.

Maia-3 5M is the most accurate source we measured. It is the smallest file (21 MB), and it is the fastest in Node: 4 to 8 ms per position on the native runtime, 9 to 20 ms on WebAssembly. It needs the game's last 8 positions and the Player's rating to be at its best, and the app has the moves of every game it plays or reviews.

**Choosing Maia-3 means taking on an AGPL dependency.** Its code is AGPL-3.0, and its weights have no licence of their own; the model card points to the repository for both. The app's own TypeScript would not copy Maia-3's code, but the weights it runs probably come under the AGPL, and hosting the converted file means redistributing them. That choice is Abir's (Part 3 has the details).

Maia2 is the safe alternative. Its code is MIT. It is as good as Maia-3 at getting the human's move into the top three (68% of quick mistakes), and only its first guess is weaker. It is a 47 MB file and just as fast.

Either Maia model costs nothing per move and is hundreds of times faster than Opus (about 8 seconds and 1.5 cents), so it could run on every move during play.

Claude would then do what it is good at: explaining.

1. Maia proposes the moves a player would reach for.
2. The Engine grades each one.
3. The Coach explains why the obvious move fails, or says that it's fine.

This is the split the app already has: the Engine judges and the Coach explains (ADR 0002). Maia just gives the Coach one more source of moves to discuss. Until the model has downloaded, Opus guesses instead. It is the best of the Claude models, catching 54% of the quick mistakes, against 46% for Sonnet and 42% for Haiku.

Whatever proposes the moves, three rules still apply:

- Keep the Engine's top 5 next to it.
- Have the Engine grade every proposed move before the Coach talks about it.
- Present a guess as "a move many players would reach for here", not as a prediction of what this Player will do. Even the best Maia model misses about a third of the tempting mistakes.

## Part 1: quick moves

### The moves

The 408 positions are moves the human made in 1 to 3 seconds, with at least 10 seconds left on their clock. Of the games, 152 were bullet, 186 blitz, 69 rapid and 1 classical.

Each band has 102 positions. In 51 of them, the human's move was fine: graded Best or Good. In the other 51, it was an Inaccuracy or worse; across all bands, that's 87 Inaccuracies, 69 Mistakes and 48 Blunders. Real quick moves are mistakes less often than half the time; roughly 1 in 6 of the quick moves I graded was one. The groups were balanced on purpose, so that there are enough mistakes to measure. So the overall numbers are less important than the two groups taken separately.

In each cell, the first number is how often the source's first guess was the human's move, and the second is how often the human's move was among its first three guesses. With 51 positions per band and group, each per-band number is uncertain by about ±13 points. Each "All" number is uncertain by about ±7 points.

### When the quick move was a mistake: did the source see it coming?

| Source | under 1200 | 1200–1599 | 1600–1999 | 2000 and up | All (204) |
| --- | --- | --- | --- | --- | --- |
| Maia2, told the player's rating | 37% / 69% | 43% / 80% | 35% / 69% | 25% / 53% | **35% / 68%** |
| Maia2, told 1500 for everyone | 33% / 71% | 41% / 80% | 35% / 69% | 24% / 47% | 33% / 67% |
| Opus, instinct prompt | 33% / 59% | 22% / 63% | 25% / 49% | 22% / 45% | 25% / 54% |
| Opus, likely prompt | 22% / 51% | 33% / 63% | 29% / 51% | 22% / 43% | 26% / 52% |
| Sonnet, instinct prompt | 29% / 49% | 22% / 43% | 29% / 53% | 20% / 37% | 25% / 46% |
| Sonnet, likely prompt | 31% / 43% | 27% / 47% | 29% / 53% | 14% / 37% | 25% / 45% |
| Haiku, instinct prompt | 25% / 35% | 20% / 41% | 22% / 49% | 27% / 41% | 24% / 42% |
| Haiku, likely prompt | 16% / 39% | 16% / 33% | 27% / 43% | 14% / 49% | 18% / 41% |
| Stockfish | 0% / 20% | 2% / 20% | 0% / 20% | 2% / 18% | 1% / 19% |
| "Obvious moves" rule | 10% / 29% | 18% / 29% | 14% / 27% | 8% / 22% | 12% / 27% |
| A random legal move | 6% / 18% | 5% / 16% | 7% / 22% | 5% / 15% | 6% / 18% |

How severe the mistake was made little difference to Opus or Maia2. This table shows how often each source's top three held the human's move; the Claude models used the instinct prompt:

| Grade of the human's move | Positions | Maia2 | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- | --- | --- |
| Inaccuracy | 87 | 68% | 53% | 43% | 38% | 16% |
| Mistake | 69 | 68% | 55% | 52% | 45% | 28% |
| Blunder | 48 | 67% | 54% | 42% | 44% | 13% |

### When the quick move was fine

| Source | under 1200 | 1200–1599 | 1600–1999 | 2000 and up | All (204) |
| --- | --- | --- | --- | --- | --- |
| Maia2, told the player's rating | 69% / 94% | 67% / 86% | 57% / 90% | 55% / 82% | **62% / 88%** |
| Maia2, told 1500 for everyone | 71% / 90% | 69% / 86% | 55% / 82% | 51% / 82% | 61% / 85% |
| Opus, instinct prompt | 65% / 88% | 63% / 84% | 53% / 80% | 53% / 76% | 58% / 82% |
| Opus, likely prompt | 67% / 88% | 67% / 80% | 55% / 75% | 55% / 71% | 61% / 78% |
| Sonnet, instinct prompt | 45% / 71% | 43% / 67% | 51% / 76% | 49% / 65% | 47% / 70% |
| Sonnet, likely prompt | 49% / 73% | 41% / 65% | 43% / 71% | 43% / 63% | 44% / 68% |
| Haiku, instinct prompt | 45% / 63% | 37% / 59% | 37% / 67% | 29% / 59% | 37% / 62% |
| Haiku, likely prompt | 49% / 69% | 41% / 61% | 39% / 65% | 33% / 61% | 41% / 64% |
| Stockfish | 43% / 73% | 51% / 76% | 43% / 75% | 45% / 75% | 46% / 75% |
| "Obvious moves" rule | 43% / 57% | 33% / 53% | 16% / 33% | 25% / 41% | 29% / 46% |

### Is the difference real?

These comparisons use the instinct prompt for the Claude models and the same positions for both sources. Each cell counts the positions where only the first model hit, then the positions where only the second hit. The p-value is the chance of a split at least that uneven if the two models were really equal.

| Comparison | Mistakes, first guess | Mistakes, top three | Fine moves, first guess | Fine moves, top three |
| --- | --- | --- | --- | --- |
| Opus vs Sonnet | 21 / 20 (no difference) | 34 / 17 (p = 0.02) | 40 / 17 (p = 0.003) | 36 / 10 (p < 0.001) |
| Opus vs Haiku | 27 / 23 (no difference) | 47 / 22 (p = 0.004) | 52 / 9 (p < 0.001) | 50 / 8 (p < 0.001) |
| Sonnet vs Haiku | 26 / 23 (no difference) | 33 / 25 (p = 0.36) | 41 / 21 (p = 0.02) | 40 / 24 (p = 0.06) |
| Maia2 vs Opus | 34 / 14 (p = 0.006) | 37 / 9 (p < 0.001) | 32 / 25 (no difference) | 19 / 7 (p = 0.03) |
| Maia2, real rating vs 1500 | 7 / 3 (no difference) | 6 / 4 (no difference) | 6 / 5 (no difference) | 7 / 1 (p = 0.07) |

The instinct prompt and the likely prompt are not clearly different for any model. Over all 408 positions, the instinct prompt's split against the likely prompt was:

| Model | First guess | Top three |
| --- | --- | --- |
| Opus | 20 / 27 (p = 0.38) | 25 / 13 (p = 0.07) |
| Sonnet | 37 / 32 (p = 0.63) | 32 / 27 (p = 0.60) |
| Haiku | 43 / 39 (p = 0.74) | 50 / 53 (p = 0.84) |

### Together with the Engine's top 5

How often the human's quick move was in the list:

| List | All quick moves | Quick mistakes only |
| --- | --- | --- |
| Engine top 5 alone | 62% | 38% |
| Engine top 5 + Maia2's 3 | 83% | **74%** |
| Engine top 5 + Opus's 3 (instinct prompt) | 78% | 63% |
| Engine top 5 + Sonnet's 3 (instinct prompt) | 76% | 58% |
| Engine top 5 + Haiku's 3 (instinct prompt) | 75% | 59% |

### Bullet against slower games

Bullet moves are harder to predict for every source. They are also closer to pure instinct. This table uses the instinct prompt for the Claude models, first guess / top three:

| Games | Positions | Maia2 | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- | --- | --- |
| Bullet | 152 | 41% / 71% | 38% / 62% | 32% / 52% | 26% / 46% | 24% / 44% |
| Blitz and slower | 256 | 53% / 82% | 44% / 72% | 39% / 61% | 33% / 55% | 23% / 48% |

### Some quick mistakes

Quick mistakes that at least one model saw coming. The models' moves are from the instinct prompt, first guess first:

| Position (mover's rating) | Human played | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- | --- |
| After 4. Bc4 Bd7 5. Qf3 Be7 (1406) | Qxb7 (Mistake) | **Qxb7**, Qh5+, Ne2 | Nc3, Qg3, Bxe6 | **Qxb7**, Bxe6, Ne2 | Qh5+, Qe2, Nc3 |
| After 15. Ne5 Nxe5 16. Bxe5 f6 17. Bf4 (1427) | g5 (Blunder) | O-O-O, **g5**, Kf7 | **g5**, Bd6, O-O-O | **g5**, Bg4, Qd6 | Rc8, Kf7, f5 |
| After 13. cxb5 axb5 14. axb5 (1770) | Bxb5 (Blunder) | Qxb5, **Bxb5**, Qa1+ | **Bxb5**, O-O, Qxb5 | O-O, **Bxb5**, Qxb5 | Qa3+, Nxe4, Qa1+ |
| After 10. Be2 Bg6 11. Qd2 (1848) | e5 (Blunder) | e6, **e5** (+1 illegal) | e6, Qd7 (+1 illegal) | d4, Qb6, Ne4 | a6, e6, Qd6 |
| After 26. Bf1 Rxc1 27. Qxc1 (2298) | Qc7 (Inaccuracy) | **Qc7**, Ng5 (+1 illegal) | Nhf6, Kh8, Ng5 | g6, Ng5 (+1 illegal) | a6, Nhf6, Nef6 |

And some that no model saw coming. Several of these are quiet developing moves that happen to be slightly inaccurate, such as Nc3 or Qe7 in the opening. Others are moves that make sense only in the player's own plan, such as Bxg6 or Rd1.

| Position (mover's rating) | Human played | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- | --- |
| After 3. d3 Bg4 4. Bf4 Nd7 (1050) | Nc3 (Inaccuracy) | Nbd2, Be2, h3 | Nbd2, h3, Be2 | Nbd2, h3, Be2 | exd5, Nbd2, Be2 |
| After 5. Bd3 Nc6 6. e5 a6 (1428) | Bxg6 (Mistake) | Nf3, h4, f4 | Ne2, Nf3, Qh5 | Nf3, Ne2, c4 | f4, Qe2, Nh3 |
| After 9. Bg5 Rxe1+ 10. Qxe1 Nbd7 (1891) | Rd1 (Blunder) | Nb5, Qd2, Qe2 | Qe3, Bxf6, Qe2 | Bxf6, Nxd5, Qe4 | Nxd5, Qe3, Nb5 |
| After 21. a5 a6 (960) | Kd2 (Blunder) | exf6, Nxe6, O-O | Bxb5 (+2 illegal) | Nxe6, Nxc6, O-O | f4, O-O, Nb3 |

## Part 2: every kind of move (the first run)

The first run asked only the "likely" prompt. It used positions with no limit on how long the human thought, from games of 3 minutes and up.

In each cell, the first number is how often the source's first guess was the move the human played (top-1). The second is how often the human's move was among its first three guesses (top-3). Each band has 177 positions, so each per-band number is uncertain by about ±7 percentage points. The "All" column (708 positions) is uncertain by about ±3.5 points.

| Source | under 1200 | 1200–1599 | 1600–1999 | 2000 and up | All |
| --- | --- | --- | --- | --- | --- |
| Maia2, told the player's rating | 51% / 76% | 54% / 80% | 47% / 82% | 51% / 82% | **51% / 80%** |
| Maia2, told 1500 for everyone | 52% / 75% | 55% / 81% | 50% / 82% | 51% / 79% | 52% / 79% |
| Opus | 42% / 67% | 45% / 72% | 41% / 65% | 45% / 71% | 43% / 69% |
| Sonnet | 33% / 56% | 36% / 59% | 32% / 51% | 34% / 51% | 34% / 55% |
| Haiku | 34% / 53% | 34% / 54% | 26% / 45% | 27% / 42% | 30% / 49% |
| Stockfish (depth 14) | 28% / 57% | 37% / 63% | 29% / 56% | 37% / 66% | 33% / 60% |
| "Obvious moves" rule | 25% / 41% | 21% / 38% | 16% / 33% | 19% / 34% | 20% / 37% |
| A random legal move | 8% / 23% | 7% / 19% | 5% / 16% | 6% / 16% | 7% / 18% |

### Is the difference real?

These comparisons use the same 708 positions for both sources. Each cell counts the positions where only the first source hit, then the positions where only the second hit. The p-value is the chance of a split at least that uneven if the two were really equal.

| Comparison | Top-1 | Top-3 |
| --- | --- | --- |
| Maia2 vs Opus | 122 / 67 (p < 0.001) | 105 / 26 (p < 0.001) |
| Opus vs Stockfish | 150 / 77 (p < 0.001) | 121 / 61 (p < 0.001) |
| Opus vs Sonnet | 116 / 48 (p < 0.001) | 147 / 45 (p < 0.001) |
| Opus vs Haiku | 144 / 53 (p < 0.001) | 190 / 46 (p < 0.001) |
| Sonnet vs Stockfish | 114 / 109 (no difference) | 105 / 147 (p = 0.01, Stockfish better) |
| Sonnet vs Haiku | 87 / 64 (p = 0.07) | 125 / 83 (p = 0.004) |
| Haiku vs Stockfish | 103 / 121 (no clear difference) | 99 / 183 (p < 0.001, Stockfish better) |
| Haiku vs "obvious moves" | 128 / 57 (p < 0.001) | 158 / 73 (p < 0.001) |

### Does a model fit one band better? (question 2)

This test checks whether a source's hit rate differs between the four bands more than chance would explain. A small p means it fits some bands better than others.

| Source | Top-1 p | Top-3 p | Reading |
| --- | --- | --- | --- |
| Opus | 0.84 | 0.41 | The same at every level |
| Sonnet | 0.89 | 0.37 | The same at every level |
| Haiku | 0.18 | 0.07 | Weak lean toward players under 1600 |
| Stockfish | 0.14 | 0.18 | No clear difference |
| Maia2 | 0.65 | 0.50 | The same at every level |

This answer differs from the one I gave after the first 204 positions. There, Haiku seemed to fit players under 1200 much better. With 3.5 times the data, that difference shrank to a weak lean. Opus's first-guess rate also stays almost level across the bands (41% to 45%). Stockfish's first choice, by contrast, matches stronger players a little more often. The models were never told a rating, and their guesses do not match any one level. To aim the guesses at a level, the prompt would probably need to state the rating (see "What's still open").

### By phase of the game (all bands, 236 positions each)

| Source | Opening (first 10 moves) | Middlegame | Endgame |
| --- | --- | --- | --- |
| Opus | 41% / 66% | 42% / 65% | 46% / 76% |
| Sonnet | 33% / 53% | 31% / 50% | 36% / 60% |
| Haiku | 31% / 50% | 28% / 40% | 33% / 56% |
| Stockfish | 33% / 58% | 31% / 58% | 34% / 65% |
| "Obvious moves" rule | 12% / 24% | 26% / 39% | 23% / 47% |

Opus does as well in the middlegame and endgame as in the opening. So the models are not only recalling opening theory.

### What the guesses add to the Engine's top 5

This table shows how often the human's move was in the list.

| List | under 1200 | 1200–1599 | 1600–1999 | 2000 and up | All |
| --- | --- | --- | --- | --- | --- |
| Engine top 5 alone (what the Coach sees today) | 71% | 78% | 76% | 78% | 76% |
| Engine top 5 + Opus's 3 | 79% | 86% | 85% | 84% | 83% |
| Engine top 5 + Haiku's 3 | 81% | 86% | 85% | 84% | 84% |
| Engine top 5 + Sonnet's 3 | 80% | 86% | 83% | 84% | 83% |
| Engine top 5 + Maia2's 3 | 84% | 88% | 90% | 91% | **88%** |

In 172 of the 708 positions, the human played a move outside the Engine's top 5. A model's three guesses held that move 61 times for Haiku, 55 for Opus and 52 for Sonnet. In 79% of positions, at least one of the three models had the human's move among its three guesses.

### Illegal moves

Each model was asked for three moves. Every move was checked against the position, and illegal ones were dropped before scoring.

| Model | Moves returned | Illegal | Share illegal |
| --- | --- | --- | --- |
| Opus | 2,115 | 47 | 2% |
| Haiku | 2,113 | 149 | 7% |
| Sonnet | 2,109 | 171 | 8% |

No call failed. A typical illegal move is a piece passing through another piece, for example a queen sliding past a pawn. Any layer built on this needs the move guard, as the Coach already has.

### Where the three models disagree

This table shows how often two sources chose the same first move, and how many moves their top-3 lists shared on average:

| | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- |
| Opus | – | 51% / 1.6 | 41% / 1.4 | 35% / 1.5 |
| Sonnet | 51% / 1.6 | – | 41% / 1.3 | 30% / 1.2 |
| Haiku | 41% / 1.4 | 41% / 1.3 | – | 25% / 1.1 |

The models agree with each other more than they agree with the Engine. Opus is the closest to the Engine. Haiku is the furthest from it, which is why its guesses add the most new moves to the Engine's list.

Some positions where all three chose different first moves:

| Position (mover's rating) | Human played | Opus | Sonnet | Haiku | Stockfish |
| --- | --- | --- | --- | --- | --- |
| After 10. O-O b6 11. Nd2 Bb7 12. Bf3 Qd7 (1898) | Bxb7 | **Bxb7**, Nc4, Re1 | Re1, Nb3 (+1 illegal) | Ne4, Nc4, d4 | a4, Be4, Re1 |
| After 13. Nc3 h6 14. Bh4 g5 15. Bg3 Bg7 (1841) | Bd6 | **Bd6**, Qe2, Be5 | Qd2, Re3, Re2 | Nb5, Nxd5, Qd2 | **Bd6**, Bb8, Na4 |
| After 6. Nf3 Bg4 7. Be2 Qc5 8. Ne4 Qd5 (1610) | c4 | **c4**, O-O, Nc3 | O-O, Nc3, c4 | Nc3, O-O, Ng3 | h3, Ng3, b4 |
| After 14. c4 Qd4 15. Qxd4 exd4 16. b4 Nd7 (1769) | c5 | **c5**, f4, Rac1 | Rac1, Nb2, Nc5 | Nc5, b5, Rab1 | f4, g3, a3 |
| After 3. Nc3 Nf6 4. Bc4 d6 5. Ng5 (1053) | d5 | Be6, d5, h6 | Be7, h6, Nxe4 | h6, Be7, Qe7 | **d5**, Be6, Qe7 |
| After 18. Bxd4 cxd4 19. Nf3 (2104) | Bxh3 | e4, Bf5, Bxh3 | Nf6, Be6, Qe6 | Qd7, e4, Rd8 | **Bxh3**, Qg7, e4 |

The pattern in these examples: Opus usually picks the natural move a club player would reach for first, such as trading off an active bishop or gaining space. Stockfish picks quiet best moves that humans rarely find. Haiku and Sonnet more often pick moves that look plausible but are not what the player chose.

### How often a first guess is the Engine's first choice

| Source | under 1200 | 1200–1599 | 1600–1999 | 2000 and up |
| --- | --- | --- | --- | --- |
| Opus | 41% | 36% | 28% | 36% |
| Sonnet | 32% | 37% | 26% | 27% |
| Haiku | 29% | 27% | 21% | 23% |
| The humans themselves | 28% | 37% | 29% | 37% |

The models are not just copying the Engine. Opus's first guess is the Engine's first choice about a third of the time, about as often as the humans themselves play it.

## Part 3: running Maia inside the app (prototype)

Abir decided that the licence is not a blocker: Maia2's repository and README release it under MIT, which works with this project's GPL-3.0-or-later. He also decided how the model gets to the Player: it is downloaded in the background after the app is installed. Until the download finishes, or if it fails, Opus does the guessing instead.

Nothing in the app changed. The prototype is these scripts:

- `data-prep/maia2-onnx-export.py` and `data-prep/maia3-onnx-export.py` convert each model to ONNX, a standard file format for neural networks that many runtimes can load. They also record Python's top three for every position, to check against.
- `data-prep/maia2-node.ts` and `data-prep/maia3-node.ts` run the converted models from Node. They encode the board in TypeScript on the repo's chessops helpers, then compare their moves with Python's.
- `data-prep/human-moves-maia3.py` scores the Maia-3 models on the eval's positions.
- `node data-prep/human-moves.ts history` adds each position's moves from the start of its game, which Maia-3 needs.

### Maia-3 against Maia2

The Maia2 README now recommends Maia-3 for new projects (github.com/CSSLab/maia3; models on Hugging Face under UofTCSSLab). Abir approved installing it.

I ran all three released sizes on the same 408 quick moves, using the authors' own encoding functions and the real move history of each game. This table shows first guess / top three:

| | Maia3-5M | Maia3-23M | Maia3-79M | Maia2 (blitz) | Opus (instinct prompt) |
| --- | --- | --- | --- | --- | --- |
| All 408 quick moves | **54% / 78%** | 53% / 77% | 56% / 78% | 49% / 78% | 42% / 68% |
| The 204 quick mistakes | **41% / 69%** | 40% / 67% | 42% / 68% | 35% / 68% | 25% / 54% |
| The 204 fine quick moves | **68% / 87%** | 67% / 88% | 69% / 88% | 62% / 88% | 58% / 82% |
| Download as published | 21 MB | 92 MB | 316 MB | 280 MB | – |
| As ONNX | 21 MB | not converted | not converted | 47 MB (float16 weights) | – |
| PyTorch, per position (4 threads) | 7 ms | 14 ms | 41 ms | about 7 ms | about 8 s |
| Paper, first guess on 2022 blitz games (Table 1) | 55.4% | 56.6% | 57.1% | 52.0% | – |

What the paired tests say, on the same positions:

- **5M against 79M:** no difference that chance can't explain. Over all moves, the 5M model's first guess hit where the 79M's missed 9 times, and the other way round 14 times (p = 0.41). For the top three it was 12 against 11. They gave the same first move in 369 of 408 positions. So the 21 MB model is effectively as good as the 316 MB one here, well above Abir's bar of 80%.
- **5M against Maia2:** Maia-3 is better on the first guess, both overall (38 against 14, p = 0.001) and on the mistakes (20 against 8, p = 0.04). The two tie on the top three (17 against 17).
- **5M against Opus:** Maia-3 is far ahead (first guess 78 against 27, p < 0.001; on the mistakes 42 against 10).
- **Every Maia model finds 2000+ players harder.** The quick moves of 2000+ players are the hardest for every Maia model to predict. For the 5M model, its top three held 67% of them, against 80% to 83% in the other bands (chi-square p = 0.02). The paper reports that model size matters most at high ratings. We didn't see that here: the 79M model was no better at 2000+.

The two inputs that matter, for the 5M model:

| Input | All quick moves | Quick mistakes |
| --- | --- | --- |
| The game's last 8 positions and the player's real rating | 54% / 78% | 41% / 69% |
| A flat 1500 for both players | 51% / 78% | 35% / 69% |
| The current position only (as for a position set up by hand) | 48% / 76% | 31% / 64% |

The rating changes the first guess on mistakes the most: 12 mistakes hit only with the real rating, none only with 1500 (p < 0.001). So the app should pass the Player's rating when it knows it.

**What the paper says.** The paper is "Chessformer: A Unified Architecture for Chess Modeling", ICLR 2026 (arXiv 2605.19091). A subagent read it.

- It reports only first-guess accuracy, on 884,049 positions from 2022 Lichess blitz games. It leaves out the first 10 moves of each game and moves made with under 30 seconds on the clock.
- The 5M model reaches 55.4%, about 97% of the 79M model's 57.1%. Maia2 reaches 52.0%.
- Size matters most for strong players, and the move history helps most for weak ones.
- The models were trained on Lichess blitz games from January 2023 to July 2025.
- The paper does not look at mistakes specifically.

Our numbers sit a little lower because our positions include the opening, bullet games and moves made in 1 to 3 seconds.

**A correction.** I wrote earlier that Maia-3 takes the time a player spends thinking as an input. It doesn't. The code removes that column before the model reads its input. The time is something the model learned to predict, not something we can set, so we can't ask Maia-3 directly for "the move made in 2 seconds".

**Licence.** Maia-3's code is AGPL-3.0. The model cards give no separate licence for the weights; the 5M card says to see the repository for the code and weights licence. So the weights most likely come under the AGPL too. What that means for this project, as I read it (this is not legal advice):

- The app would not ship Maia-3's code. The encoding in `data-prep/maia3-node.ts` is written in TypeScript on chessops from reading theirs, and the authors' Python is used once, to convert the weights to ONNX.
- The weights themselves are the AGPL part. GPL-3.0 and AGPL-3.0 explicitly allow combining (section 13 of each). But the AGPL's network clause would then apply: people who use the app over a network, such as the owner's phone over the LAN or the tunnel, must be offered its source. OpenChessCoach is already public, so in practice that is a source link, but it is a real obligation.
- Hosting the converted file ourselves means redistributing the weights. The AGPL allows that, with the licence and a source link. With no licence at all, it would not be allowed. It's worth asking the authors to confirm the weights' licence.

Taking on an AGPL dependency was Abir's call. He accepted it on 28 October 2026 (ADR 0010).

**Running it in Node.** Maia-3's attention code and its RMS normalisation don't export to ONNX as they are. The export script swaps in a plain RMS normalisation layer that computes the same result. Python's moves with the swapped layer matched the original in all 408 positions. The 23M and 79M models were not converted.

### A bug in the Maia2 package

Maia2's own one-position function, `inference_each`, has a bug. It mixes the position's index into its list of legal moves, so its top three sometimes includes "a1h8" (or "a8h1" for Black), which is not a legal move. This happened in 22 of the 816 quick-move guesses and 35 of the 1,416 Part 2 guesses.

`data-prep/human-moves-maia.py` now ranks the legal moves by the model's scores itself, and every Maia2 guess was redone. None of the hit rates in Parts 1 and 2 changed: the fake move was never the human's move, and it mostly filled third place. Ranked this way, Maia2 can't propose an illegal move.

### Does the converted model give the same moves?

All 408 quick-move positions, compared with Python's top three from the same weights. The first three rows are Maia2:

| Model file | Size | Same first move | Same top three, any order | Hit rate: all / quick mistakes |
| --- | --- | --- | --- | --- |
| float32 | 93 MB | 407 of 408 | 408 of 408 | 49% / 78%, 35% / 68% |
| **float16 weights, float32 inputs** | **47 MB** | **408 of 408** | **408 of 408** | 49% / 78%, 36% / 68% |
| int8 (matrix layers only) | 41 MB | 390 of 408 | 364 of 408 | 48% / 79%, 34% / 69% |
| **Maia-3 5M, float32** | **21 MB** | **408 of 408** | **408 of 408 (and the same order)** | 54% / 78%, 41% / 69% |

The one float32 difference is a near-tie between two moves. The int8 file ranks differently in about 1 position in 10, but it scores the same against the human moves.

Two other attempts failed:

- A pure float16 file failed under Node 26. onnxruntime's native binding still expects a `Uint16Array` where Node 26 now hands it a `Float16Array`.
- Int8 on the convolution layers failed too, because onnxruntime's CPU build has no int8 convolution (`ConvInteger`).

### Speed, load time and memory on this desktop

Measured on this desktop's 12-core CPU, one position at a time:

| Model and runtime | Load time | Per position, 1 thread | Per position, 4 threads | Memory (whole process) |
| --- | --- | --- | --- | --- |
| Maia-3 5M, onnxruntime-node | ~0.14 s | 7.6 ms | 4.0 ms | ~170 MB |
| Maia-3 5M, onnxruntime-web | ~0.3 s | 20.1 ms | 8.7 ms | ~425 MB |
| Maia2 (float16 weights), onnxruntime-node | ~0.1 s | 8.2 ms | 4.0 ms | ~355 MB |
| Maia2 (float16 weights), onnxruntime-web | ~0.2–0.25 s | 29.6 ms | 8.6–12.5 ms (two runs) | ~600 MB |

The two runtimes differ in what they add to the app:

- **onnxruntime-node** is a native module. Its npm package is 246 MB, because it carries builds for every platform (19 to 65 MB each).
- **onnxruntime-web** is WebAssembly. It is one 12 MB `.wasm` file plus about 1 MB of JavaScript, the same on every platform, and it runs in Node too.

Python with PyTorch takes about 7 ms per position. Opus takes about 8 seconds.

I recommend onnxruntime-web. Even at 9 to 30 ms it is hundreds of times faster than Opus, which is more than fast enough to run on every move. It is one small file for every platform, so `npx openchesscoach` doesn't grow by 246 MB, and there's no native module that can fail to install.

Maia-3 5M also needs the least memory, about 425 MB on WebAssembly. For Maia2, if memory matters, the int8 file brings it down from about 600 MB to about 340 MB, at the cost of the small ranking differences above.

### Download design

The pieces:

- **What is downloaded:** the converted Maia-3 5M ONNX file, 21 MB (ADR 0010). Its move list is simple enough to compute in code. Maia2, the fallback choice, would be 47 MB plus a 15 KB move list.
- **Where from:**
  - Not the authors' Google Drive link: it can't be pinned to a version, has no checksum and is rate-limited.
  - Maia-3's weights are on Hugging Face with pinned versions and SHA-256 checksums, but as PyTorch files the app can't read. So the converted ONNX file has to come from somewhere we control too.
  - We host the converted file ourselves, as a release asset on `inprealpha/OpenChessCoach` (for example a `maia3-5m-v1` release), with its licence in `THIRD_PARTY_NOTICES.md`. For Maia2, the MIT licence allows this. For Maia-3, it depends on the weights' licence (see above).
  - The app's source pins the exact URL, the size in bytes and the SHA-256. A Hugging Face repository owned by Abir would work the same way.
- **Where it is stored:** in the app's data folder (`defaultDataDir()`, which already holds the SQLite file, ADR 0003), under `models/<model>-<first 8 characters of the SHA-256>.onnx`, for example `models/maia3-5m-1a2b3c4d.onnx`. A new model version gets a new name, and the old file is deleted only after the new one passes its check.
- **When:**
  - The download starts in the background a short while after the backend starts, never during `npm install`, because `npx` gives no reliable install step.
  - It runs one at a time, with a lock file in the models folder, so two running copies of the app don't download twice.
- **Resume:**
  - The file is written to `<name>.part`.
  - After an interruption, the next try sends an HTTP `Range` request from the `.part` file's current size. If the server ignores the range, the download starts again from zero.
- **Check:**
  - When the size matches, the app computes the SHA-256.
  - If it matches, the app renames `.part` to the final name in one step, so a half-written file is never loaded.
  - If it doesn't match, the app deletes the file and counts a failed attempt.
- **Retry:**
  - After a failure, wait 1 minute, then 5, then 30.
  - After three failures in one run, stop until the next start.
  - The app never retries in a tight loop and never blocks start-up.
  - `coachctl doctor` reports the state: not downloaded, downloading at some percentage, ready, or failed with the reason.
- **Switching from Opus to the local model:**
  - The backend gets a small port, like `CoachPort`, with one job: "the moves a player would reach for here".
  - It has two implementations. The local one runs Maia through onnxruntime-web. The fallback asks Opus with the instinct prompt from Part 1.
  - It takes the game's moves and the Player's rating, not only the position, because Maia-3 is clearly better with both. A position set up by hand has no history, so Maia-3 sees only that position.
  - Each request checks whether the verified model file exists. If it does, the local model is loaded on first use and kept in memory.
  - So the switch happens on the next request after the download finishes, with no restart.
  - If loading or running the local model throws, that request falls back to Opus, the error is logged, and the local model stays switched off until the next start.
  - Either way, the Engine grades every proposed move before the Coach talks about it, as today.
- **Verify mode and tests:** verify mode must stay deterministic (ADR 0006). It should use a fixed fake source of moves, or the local model from a fixture path, never the network or Opus.

The choice of model is decided (ADR 0010). The rest of this design is a sketch. It changes the brief, the guard and the Coach's instructions, so building it waits until the Think Deeper PR merges.

## Cost and speed

All calls ran on the owner's Claude Code login. Costs are what the same tokens would cost at API prices, as the Agent SDK reports them. On a subscription, they count against the usage limit instead.

| Model | Resolved to | Cost per position | Seconds per call | Output tokens per call |
| --- | --- | --- | --- | --- |
| Haiku | claude-haiku-5-5 | $0.0008 | 8.6 | ~1,160 |
| Sonnet | claude-sonnet-5-5 | $0.0074 | 7.1 | ~340 |
| Opus | claude-opus-5-5 | $0.0157 | 8.5 | ~390 |

Each prompt is about 1,500 tokens. At medium effort, Haiku writes about three times as many tokens as the others, which is why it is not faster.

The quick-move run (Part 1, 2,448 calls) cost about $19 at API prices. The 708-position run (Part 2, 2,124 calls) cost about $17: $0.57 for Haiku, $5.20 for Sonnet and $11.10 for Opus. Another $9 went on 76 early calls in Part 2 that were thrown away and redone, for the reason below. The quick-move run's costs and speeds per call match the table above to within a few percent.

**A problem found along the way.** In 76 of the first 612 calls (12%), the owner's claude.ai account connectors (Notion and others) were loaded into the call. Each of those calls carried about 88,000 extra tokens of tool definitions, about $0.70 per Opus call. This happened even though the call sets `mcpServers: {}`, because that setting does not cover account connectors. Setting `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the call's environment stopped it: none of the more than 4,000 calls after that had the extra tokens. The script now sets it, and those 76 calls were redone. **The app's real Coach (`packages/backend/src/coach/real.ts`) uses the same options without this setting, so it probably has the same extra cost.**

Maia2 ran on this desktop's CPU. Both parts together, 1,116 positions guessed twice each, took about a minute, most of it loading the model.

**Cost for the layer itself:** about 1.5 cents and 8 seconds per position with Opus, or 0.08 cents with Haiku. Maia2 is free and takes well under a tenth of a second.

## Method

**Ground truth: real games from the Lichess database.** I used the first 120 MB (compressed) of the September 2026 file from database.lichess.org, about 370,000 games. Every game in it lists both players' ratings. I chose this over the opening explorer's rating filters because the explorer only helps in positions that many people have reached, which means openings only. A position from a real game works the same way in every phase of the game. These games are also newer than the models' training data, so the models cannot have seen them.

**Which games and positions, in both parts.**

- Rated games only, which ended normally or on time.
- Both players are in the same rating band and at most 150 points apart, so the band describes the whole game.
- Bands: under 1200, 1200–1599, 1600–1999, 2000 and up. The ratings ran from 617 to 2610.
- One random position per game, after move 3 and before the last move. The player to move had at least two legal moves.
- Each band has equal numbers of opening (the first 10 moves), middlegame and endgame positions. An endgame here means at most 13 points of pieces, not counting pawns, are left on the board.
- The random seed is fixed, so the same file always gives the same positions.

**Part 1 only (`sample --quick`).**

- Games of 1 minute and up, so bullet is included. A game's length is its base time plus 40 times the increment; ultrabullet (under 1 minute) is left out.
- Only moves the human made in 1 to 3 seconds. The time comes from the clock Lichess records after each move, in whole seconds, plus the increment. Moves recorded as taking no time at all are left out: they are mostly premoves, chosen before the opponent's move was on the board.
- The player had at least 10 seconds left, so the move was not a pure time scramble.
- The Engine graded each move the way the app does (the Lichess formula, ADR 0002), at depth 12 to keep the sampling quick. Each band and phase got 17 moves graded Best or Good and 17 graded Inaccuracy or worse.

**Part 2 only (the default `sample`).**

- Games of 3 minutes and up, so no bullet. Of the 708 positions, 505 come from blitz, 199 from rapid and 4 from classical games.
- The player to move had at least 30 seconds left. There was no limit on how long they thought.
- A bigger `--per-band` keeps a smaller run's positions and adds to them. That is how the first 204 positions grew to 708.

**The guessing prompts.** Each model got the FEN, whose turn it is and the last six moves, and nothing else. Both prompts say the game is "a rated online game between two human players", and neither gives a rating or any hint of level.

- **Likely** (Parts 1 and 2): asks for the three moves "the human playing White" (or Black) is most likely to play, ranked, and to "predict what this person will actually play, not necessarily the best move".
- **Instinct** (Part 1 only): says "the human playing White moved here within a few seconds, on instinct, without calculating". It asks which three moves "would jump out at them first, the ones a player reaches for at a glance", ranked, and to "predict the instinctive move, not necessarily the best move".

 Each position goes to each model in its own fresh call. The call has no memory of other positions, no tools, no MCP servers, no settings from disk and no account connectors, the same setup as the app's real Coach. The answer comes back in a fixed JSON format. Each move is read as SAN, or as UCI if SAN fails, then checked for legality.

**Baselines.**

- **Stockfish**: the app's own Engine build (`createNodeEngine`) at the desktop's settings: depth 14, 5 lines. Its guesses are just its best moves, in order. Stockfish does not try to predict humans. Its "Skill Level" setting makes it play worse by sometimes choosing weaker moves, but that is not modelled on human play, so it was not used here.
- **"Obvious moves"**: a fixed rule with no search. It ranks recaptures first, then other captures (big pieces taken by small ones first, undefended targets first), promotions, checks, moves that attack an undefended piece, and castling.
- **Maia2** (CSSLab, University of Toronto; run by `data-prep/human-moves-maia.py`): its blitz model, given the board and both players' ratings, and a second time with 1500 for both. Its guesses are the three moves it gives the highest chance. It was trained on Lichess games from May 2018 to November 2023, so it has not seen these games either.
- **Random**: the expected score of three random legal moves.

**Scoring.** Top-1 counts a hit when the first guess is the move the human played. Top-3 counts a hit when the human's move is among the first three guesses. Paired comparisons use an exact sign test (McNemar's test) on the positions where one source hit and the other missed. The band test is a chi-square test across the four bands.

## Limits

- **One move is a noisy target.** A human in a given position might reasonably play several moves, so even a perfect predictor would miss often. Published human-move models get about half of their first guesses right. Read the numbers as a comparison between sources, not as a ceiling.
- **One month, one site, mostly blitz.** The games come from the first hours of September 2026 on Lichess. Lichess ratings are not FIDE or Chess.com ratings.
- **Two prompts, one effort level.** The two wordings scored the same, but other wording, more of the game in the prompt, or higher effort could still change the results, most likely for Sonnet and Haiku.
- **"Mistake" in Part 1 includes Inaccuracies**, which are often small. Mistakes and Blunders alone are 117 of the 204, so the severity table has only 48 to 87 positions per row.
- **Part 1's balance is artificial.** Half the positions are mistakes, far more than in real quick play. The overall Part 1 numbers depend on that mix, so read the two groups separately.
- **Clocks are in whole seconds**, so "1 to 3 seconds" really means anything up to about four seconds.
- **The Engine graded moves at depth 12** in Part 1 sampling, shallower than the desktop's depth 14. A few borderline moves might grade one step differently at depth 14.
- **Stockfish ran multi-threaded**, so its lines vary slightly between runs. That moves the Stockfish row by a point or two, not the conclusions.
- **Per-phase numbers per band are thin** (59 positions). That is why the phase table pools all bands.

## What's still open

- **The licence of Maia-3's weights.** Ask the CSSLab authors whether the weights are AGPL-3.0 and whether we may host a converted copy.
- **The Player's rating.** Maia-3 is clearly better when it knows the player's rating. The app needs a rating for the Player, for example from their imported Lichess games.
- **Telling the model the rating.** This run hid the rating on purpose. The next test is the same prompt with a line like "the player is rated about 1100". It would show whether Opus or Haiku can shift its guesses toward a level, which Maia does by design.
- **Lower effort for Haiku.** At medium effort, Haiku spends about 1,160 output tokens and 8.6 seconds per call. Low effort might be as accurate and faster.
- **Grading the models' guesses.** Part 1 checks whether a model's list held the human's mistake. It does not yet check how often a model's list holds a bad move at all, which is what the Coach would warn about. That needs the Engine to grade every guessed move, about 3,700 searches.
- **The connector tokens in the app's real Coach.** A separate session is fixing these.

## Re-running

Keep the downloaded games and the results outside the repo.

```bash
mkdir -p ~/human-moves/download ~/human-moves/quick ~/human-moves/run
curl -r 0-120000000 https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst -o ~/human-moves/download/part.zst
zstd -dc ~/human-moves/download/part.zst > ~/human-moves/download/games.pgn   # ends with a harmless "truncated" error

# Part 1: quick moves, both prompts
node data-prep/human-moves.ts sample ~/human-moves/download/games.pgn ~/human-moves/quick --quick --per-band=100
node data-prep/human-moves.ts guess ~/human-moves/quick --prompts=likely,instinct --concurrency=32
node data-prep/human-moves.ts engine ~/human-moves/quick
node data-prep/human-moves.ts report ~/human-moves/quick

# Part 2: every kind of move
node data-prep/human-moves.ts sample ~/human-moves/download/games.pgn ~/human-moves/run --per-band=176
node data-prep/human-moves.ts guess ~/human-moves/run --models=haiku,sonnet,opus --effort=medium --concurrency=32
node data-prep/human-moves.ts engine ~/human-moves/run
node data-prep/human-moves.ts report ~/human-moves/run
```

Part 3's prototype, from the Maia2 venv and a folder with onnxruntime installed (both outside the repo):

```bash
.venv/bin/python -I data-prep/maia2-onnx-export.py ~/human-moves/quick <weights dir> ~/human-moves/onnx
npm install --prefix ~/human-moves/ort onnxruntime-node@1.23.0 onnxruntime-web@1.23.0
node data-prep/maia2-node.ts ~/human-moves/quick ~/human-moves/onnx --ort=$HOME/human-moves/ort --runtime=web --threads=4
```

For Maia-3, from a venv with its code installed (see `data-prep/human-moves-maia3.py`):

```bash
node data-prep/human-moves.ts history ~/human-moves/download/games.pgn ~/human-moves/quick
.venv/bin/python -I data-prep/human-moves-maia3.py ~/human-moves/quick --models=5m,23m,79m
.venv/bin/python -I data-prep/maia3-onnx-export.py ~/human-moves/quick ~/human-moves/onnx --model=5m
node data-prep/maia3-node.ts ~/human-moves/quick ~/human-moves/onnx --ort=$HOME/human-moves/ort --runtime=web --threads=4
```

The Maia2 float16-weights and int8 files are made from the float32 export with `onnxconverter-common` (`float16.convert_float_to_float16(model, keep_io_types=True)`) and `onnxruntime.quantization.quantize_dynamic` (with `op_types_to_quantize=['MatMul', 'Gemm']`).

Every step can be resumed. Re-running `guess` makes only the calls that are missing, for example after a usage limit stops it.
