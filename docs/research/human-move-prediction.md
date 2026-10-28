# Can Claude guess the move a human plays?

Research for a possible future Coach layer. The idea: the Coach proposes the moves a human at the Player's level would think about, and the Engine checks each one (ADR 0002, ADR 0009). Before building it, we wanted to know two things:

1. Do Haiku, Sonnet and Opus suggest different moves?
2. At which Lichess rating band does each model's guessing work best, when it is not told the rating?

This is a one-off measurement. It does not change the app.

Run on 28 October 2026 with `data-prep/human-moves.ts`. The run covered 708 positions from real Lichess games. Each model guessed every position in its own separate call (2,124 calls), at medium effort. It took about 25 minutes.

## Short answer

- **Opus is the best guesser, and it is better than the Engine.** Opus's first guess was the move the human actually played 43% of the time. Its three guesses held the human's move 69% of the time. Stockfish's first choice matched the human only 33% of the time, and its top three 60% of the time. Sonnet (34% and 55%) and Haiku (30% and 49%) are clearly behind Opus. Sonnet's first guess is no better than Stockfish's first choice.
- **The three models often disagree.** All three gave the same first move in only 30% of positions. In 26% of positions, all three gave different first moves. Any two models gave the same first move 41% to 51% of the time.
- **No model fits one rating band clearly better than the others.** Opus guesses about equally well at every level, from under 1200 to 2000 and up (41% to 45% first-guess hits). Haiku leans toward weaker players: 34% under 1600 and 26% to 27% above 1600. That lean is weak evidence only (p = 0.07). So the models' unprompted guesses are not "the guesses of a 1200 player" or "the guesses of a 2000 player". They are about equally right at every level.
- **For widening the Coach's list of moves, the cheap model is as good as the expensive one.** Today the Coach sees the Engine's top 5 moves, and those held the human's move in 76% of positions. Adding a model's 3 guesses raised that to 83% with Opus, 84% with Haiku and 83% with Sonnet. Haiku's guesses look less like the Engine's, so they catch more of the moves the Engine would never list. Haiku costs about a twentieth of what Opus costs.

**My opinion.** The layer is worth building, and which model to use depends on what the layer is for.

- If the Coach should **name the move a Player at that level would most likely play** (for example, "most players here would play Bxb7"), use Opus. It is the only model that clearly beats the Engine at ranking human moves.
- If the Coach should **add a few human-tempting moves for the Engine to check**, so it can talk about the mistake the Player is likely to make, use Haiku. It adds as much as Opus at a fraction of the cost.

Either way, keep it next to the Engine's top 5, not in place of it. Check every proposed move, because 2% to 8% of them are illegal. Run it on demand, not on every move, because each call takes 7 to 9 seconds. Before building it, try Maia2 (see "What's still open"). Maia2 is a free model trained only to predict human moves, and it may beat all three.

## Results

In each cell, the first number is how often the source's first guess was the move the human played (top-1). The second is how often the human's move was among its first three guesses (top-3). Each band has 177 positions, so each per-band number is uncertain by about ±7 percentage points. The "All" column (708 positions) is uncertain by about ±3.5 points.

| Source | under 1200 | 1200–1599 | 1600–1999 | 2000 and up | All |
| --- | --- | --- | --- | --- | --- |
| Opus | 42% / 67% | 45% / 72% | 41% / 65% | 45% / 71% | **43% / 69%** |
| Sonnet | 33% / 56% | 36% / 59% | 32% / 51% | 34% / 51% | 34% / 55% |
| Haiku | 34% / 53% | 34% / 54% | 26% / 45% | 27% / 42% | 30% / 49% |
| Stockfish (depth 14) | 28% / 57% | 37% / 63% | 29% / 56% | 37% / 66% | 33% / 60% |
| "Obvious moves" rule | 25% / 41% | 21% / 38% | 16% / 33% | 19% / 34% | 20% / 37% |
| A random legal move | 8% / 23% | 7% / 19% | 5% / 16% | 6% / 16% | 7% / 18% |

### Is the difference real?

These comparisons use the same 708 positions for both sources. Each cell counts the positions where only the first source hit, then the positions where only the second hit. The p-value is the chance of a split at least that uneven if the two were really equal.

| Comparison | Top-1 | Top-3 |
| --- | --- | --- |
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
| Engine top 5 + Haiku's 3 | 81% | 86% | 85% | 84% | **84%** |
| Engine top 5 + Sonnet's 3 | 80% | 86% | 83% | 84% | 83% |

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

## Cost and speed

All calls ran on the owner's Claude Code login. Costs are what the same tokens would cost at API prices, as the Agent SDK reports them. On a subscription, they count against the usage limit instead.

| Model | Resolved to | Cost per position | Seconds per call | Output tokens per call |
| --- | --- | --- | --- | --- |
| Haiku | claude-haiku-5-5 | $0.0008 | 8.6 | ~1,160 |
| Sonnet | claude-sonnet-5-5 | $0.0074 | 7.1 | ~340 |
| Opus | claude-opus-5-5 | $0.0157 | 8.5 | ~390 |

Each prompt is about 1,500 tokens. At medium effort, Haiku writes about three times as many tokens as the others, which is why it is not faster.

The 708-position run cost about $17 at API prices: $0.57 for Haiku, $5.20 for Sonnet and $11.10 for Opus. Another $9 went on 76 early calls that were thrown away and redone, for the reason below.

**A problem found along the way.** In 76 of the first 612 calls (12%), the owner's claude.ai account connectors (Notion and others) were loaded into the call. Each of those calls carried about 88,000 extra tokens of tool definitions, about $0.70 per Opus call. This happened even though the call sets `mcpServers: {}`, because that setting does not cover account connectors. Setting `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the call's environment stopped it: none of the 1,600 calls after that had the extra tokens. The script now sets it, and those 76 calls were redone. **The app's real Coach (`packages/backend/src/coach/real.ts`) uses the same options without this setting, so it probably has the same extra cost.**

**Cost for the layer itself:** about 1.6 cents and 8 seconds per position with Opus, or 0.08 cents with Haiku.

## Method

**Ground truth: real games from the Lichess database.** I used the first 120 MB (compressed) of the September 2026 file from database.lichess.org, about 370,000 games. Every game in it lists both players' ratings. I chose this over the opening explorer's rating filters because the explorer only helps in positions that many people have reached, which means openings only. A position from a real game works the same way in every phase of the game. These games are also newer than the models' training data, so the models cannot have seen them.

**Which games and positions.**

- Rated games only, at blitz speed or slower. A game counts if its base time plus 40 times the increment is at least 3 minutes. Bullet moves are mostly reflexes. Of the 708 positions, 505 come from blitz, 199 from rapid and 4 from classical games.
- The game ended normally or on time.
- Both players are in the same rating band and at most 150 points apart, so the band describes the whole game.
- Bands: under 1200, 1200–1599, 1600–1999, 2000 and up. The ratings ran from 617 to 2610.
- One random position per game, after move 3 and before the last move.
- The player to move had at least 30 seconds left, so the move was not a time scramble.
- The player had at least two legal moves.
- Each band has 59 opening positions (the first 10 moves), 59 middlegame and 59 endgame positions. An endgame here means at most 13 points of pieces, not counting pawns, are left on the board.
- The random seed is fixed, so the same file always gives the same positions. A bigger `--per-band` keeps the smaller run's positions and adds to them. That is how the first 204 positions grew to 708.

**The guessing prompt.** Each model got the FEN, whose turn it is and the last six moves, and nothing else. The prompt says the game is "a rated online game between two human players". It asks for the three moves "the human playing White" (or Black) is most likely to play, ranked. It asks the model to "predict what this person will actually play, not necessarily the best move".

It gives no rating and no hint of level. Each position goes to each model in its own fresh call. The call has no memory of other positions, no tools, no MCP servers, no settings from disk and no account connectors, the same setup as the app's real Coach. The answer comes back in a fixed JSON format. Each move is read as SAN, or as UCI if SAN fails, then checked for legality.

**Baselines.**

- **Stockfish**: the app's own Engine build (`createNodeEngine`) at the desktop's settings: depth 14, 5 lines.
- **"Obvious moves"**: a fixed rule with no search. It ranks recaptures first, then other captures (big pieces taken by small ones first, undefended targets first), promotions, checks, moves that attack an undefended piece, and castling.
- **Random**: the expected score of three random legal moves.

**Scoring.** Top-1 counts a hit when the first guess is the move the human played. Top-3 counts a hit when the human's move is among the first three guesses. Paired comparisons use an exact sign test (McNemar's test) on the positions where one source hit and the other missed. The band test is a chi-square test across the four bands.

## Limits

- **One move is a noisy target.** A human in a given position might reasonably play several moves, so even a perfect predictor would miss often. Published human-move models get about half of their first guesses right. Read the numbers as a comparison between sources, not as a ceiling.
- **One month, one site, mostly blitz.** The games come from the first hours of September 2026 on Lichess. Lichess ratings are not FIDE or Chess.com ratings.
- **One prompt, one effort level.** Different wording, more of the game in the prompt, or higher effort could change the results, most likely for Sonnet and Haiku.
- **Stockfish ran multi-threaded**, so its lines vary slightly between runs. That moves the Stockfish row by a point or two, not the conclusions.
- **Per-phase numbers per band are thin** (59 positions). That is why the phase table pools all bands.

## What's still open

- **Maia2.** I installed Maia2, a model trained on Lichess games to predict the move a human of a given rating plays (from CSSLab at the University of Toronto). Running it was blocked by Claude Code's safety check. Maia2 downloads its weights from the authors' Google Drive and loads them with PyTorch, and loading a file that way can run code. The script is ready as `data-prep/human-moves-maia.py`. If Abir approves, it takes about a minute. If Maia2 matches or beats Opus, the layer could use it instead: it is free, it takes milliseconds, and it is built to be told the Player's rating. But it would add Python and PyTorch, or a ported model, to the app.
- **Telling the model the rating.** This run hid the rating on purpose. The next test is the same prompt with a line like "the player is rated about 1100". It would show whether Opus or Haiku can shift its guesses toward a level, which Maia does by design.
- **Lower effort for Haiku.** At medium effort, Haiku spends about 1,160 output tokens and 8.6 seconds per call. Low effort might be as accurate and faster.
- **The connector tokens in the app's real Coach.** These are worth fixing as a separate change.

## Re-running

Keep the downloaded games and the results outside the repo.

```bash
mkdir -p ~/human-moves/download ~/human-moves/run
curl -r 0-120000000 https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst -o ~/human-moves/download/part.zst
zstd -dc ~/human-moves/download/part.zst > ~/human-moves/download/games.pgn   # ends with a harmless "truncated" error
node data-prep/human-moves.ts sample ~/human-moves/download/games.pgn ~/human-moves/run --per-band=176
node data-prep/human-moves.ts guess ~/human-moves/run --models=haiku,sonnet,opus --effort=medium --concurrency=32
node data-prep/human-moves.ts engine ~/human-moves/run
node data-prep/human-moves.ts report ~/human-moves/run
```

Every step can be resumed. Re-running `guess` makes only the calls that are missing, for example after a usage limit stops it.
