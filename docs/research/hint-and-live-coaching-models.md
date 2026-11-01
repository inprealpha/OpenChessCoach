# Haiku or Sonnet for Hints and Live Coaching (#34)

Balanced runs Reviews, Why Questions and Lessons on Sonnet, and Hints and Live Coaching on Haiku. ADR 0010 compared the models only on Why Questions. This measures the two short jobs, on the Coach prompt and defaults of #32 (Think deeper on, which these two jobs never use).

**Result: Haiku is good enough for both, so the split stays.** The two models made about as many false claims as each other, and the final judge preferred each about equally often. Haiku gave away fewer Hints. Sonnet was faster, and cost about nine times as much per reply.

## How it was measured

- **Positions** (`scripts/coach-model-positions.json`, made by `node scripts/coach-model-eval.ts --select`):
  - 15 Hints: 7 Lichess puzzle positions with a tactic to find (mate in one at 700 up to mate in two at 1900), 3 positions from real games with a threat to meet, 2 quiet positions, and 3 Lesson Hints carrying the Lesson's focus (Forks, King and pawn endgames, Italian Game).
  - 15 Live Coaching moments: 8 puzzle setup moves the Engine grades a Blunder, and 7 Mistakes and Blunders from real games, from the opening to the endgame.
- **Players.** Every position was asked at beginner, casual and club, with a rating of 900, 1300 and 1700. That is 90 Coach calls per model.
- **Same input for both.** The Engine's facts were built once at the desktop's depth (14). Hints got tempting moves from Maia-3, as an install with the model downloaded does. Both models got byte-identical briefs, through the app's own `CoachService` and `RealCoach`. The models were the `haiku` and `sonnet` aliases, which resolved to `claude-haiku-5-5` and `claude-sonnet-5-5`. Sonnet runs were allowed for this test only.
- **Judges.** Three Opus judges checked the answers against the Engine at depth 18. None of them knew which model wrote which answer.
  - **Round judges.** One per model's round. They listed every false chess claim, and marked whether the answer missed the main point, gave the Hint's move away, fitted the Player's level, and made sense as coaching from a high level (good, ok or poor).
  - **Final judge.** One judge over both rounds side by side, per position and level, applying one standard to both. It upheld or overturned each round judge's claim, added the ones they missed, and judged the giveaways again. It also picked which reply coaches better, and gave a verdict per job and level.
  - The judging guides are saved with this run's files (see the end).

## Results

The final judge's counts, over 45 answers per model and job:

| | Haiku Hints | Sonnet Hints | Haiku Live | Sonnet Live |
|---|---|---|---|---|
| False claims | 11 | 9 | 3 | 8 |
| Answers with a false claim | 10 | 9 | 3 | 7 |
| Hints that give the move away | 3 | 6 | n/a | n/a |
| Coaches better / worse / tie | 13 / 14 / 18 | 14 / 13 / 18 | 10 / 11 / 24 | 11 / 10 / 24 |
| Median time per reply | 7.0 s | 4.0 s | 6.1 s | 4.0 s |
| Slowest tenth from | 8.7 s | 5.0 s | 7.6 s | 7.3 s |
| Median output tokens | 1,033 | 209 | 931 | 280 |
| Median input tokens (about 4,100 cached) | 5,900 | 5,900 | 6,200 | 6,200 |
| Cost per 100 replies, at API prices | $0.13 | $1.07 | $0.12 | $1.23 |
| Over the 40-word budget | 8 | 11 | 0 | 2 |

None of the 180 calls failed. ADR 0010 found that the same answers judged twice moved by up to 3 in 20, so only Live Coaching's false claims (3 against 8) are a clear difference, and it favours Haiku.

By level, with Haiku's count first and Sonnet's second:

| Level | Hint false claims | Hint giveaways | Live false claims | Live better / worse / tie |
|---|---|---|---|---|
| Beginner | 4 / 3 | 2 / 2 | 2 / 2 | 3 / 3 / 9 |
| Casual | 4 / 3 | 1 / 2 | 1 / 3 | 4 / 3 / 8 |
| Club | 3 / 3 | 0 / 2 | 0 / 3 | 3 / 5 / 7 |

## What the judges saw

**Hints.** The two models erred in different ways.

- **Sonnet.** Its errors were small misreads of the board: a piece "about to be" attacked that already is, or a king "hemmed in by its own pieces". Its weakness was giveaways. It named the square together with the check ("capturing on e5 … with check"), the loose rook, or the piece the pin wins.
- **Haiku.** It sometimes made up a material reason that teaches a wrong lesson:
  - a bishop-for-knight trade that "wins material";
  - a check that "loses material";
  - "a queen ahead" when the Player is a rook down for a move.

  It also stated the opposition backwards in the King and pawn Lesson, and described a diagonal that isn't on the board. The final judge called Haiku's Hints good enough for casual and club Players and less safe for beginners, because three of these false reasons reach a beginner. Beginners still got about as many false claims from each model (4 against 3).

**Live Coaching.** Both models were strong on tactical blunders at every level. Sonnet miscounted the material in a fork at all three levels, and twice called a king move forced when another was legal. Haiku was the more accurate. At club level it often gave the beginner's text again, where Sonnet gave the concrete line, so Sonnet won 5 to 3 there.

**Both models were weak in the same places, in quiet positions.** "Be6 allows Nh4" never said Nh4 attacks the queen, and an endgame Mistake was blamed on a pawn that falls anyway. The brief has no `does` for those replies, so the Coach has nothing to say. That is a gap in the facts, not in the model.

**Haiku is slower, not faster.** It wrote about a thousand output tokens for a 30-word reply, against Sonnet's 200 to 300, and took 6 to 7 seconds where Sonnet took 4. The extra tokens are most likely its own thinking: the app sets no thinking options, so each model uses its default. This is a guess that wasn't measured apart.

## Decision and follow-ups

The split stays. Haiku is as accurate as Sonnet in Hints and more accurate in Live Coaching, gives away fewer Hints, and costs about a ninth as much. Moving Hints alone to Sonnet would buy fewer bad reasons for beginners at the price of twice the giveaways. The counts don't show enough of a gain for that.

Worth doing separately, each with its own measurement:

- **Give quiet-position briefs what the best reply does.** A reply that attacks a piece has no `does` today. This would help both models.
- **Make Hints faster on Haiku**, for example with thinking off for the two short jobs. Check that the false claims don't rise.
- **Stop Hints naming the best move's square.** The script's `namesBestSquare` flag catches the commonest giveaway; a guard or a prompt rule could use it.
- **Club-level Live Coaching should give the line**, not the beginner's sentence again.

## Running it again

```
node scripts/coach-model-eval.ts --select                       # only to change the positions
MAIA_MODEL=<maia3-5m.onnx> node scripts/coach-model-eval.ts --facts asks.json
node scripts/coach-model-eval.ts --answer asks.json --model haiku --out haiku.json
node scripts/coach-model-eval.ts --answer asks.json --model sonnet --out sonnet.json
node scripts/coach-model-eval.ts --packet sonnet.json --round R1 --out packet-R1.json   # rounds in either order
node scripts/coach-model-eval.ts --packet haiku.json --round R2 --out packet-R2.json
node scripts/coach-model-eval.ts --pairs packet-R1.json packet-R2.json --out pairs.json
node scripts/coach-model-eval.ts --summary --round R1 sonnet.json r1-verdicts.json final.json
```

- **Cost.** `--answer` spends the owner's Claude limits: 90 short calls per model.
- **Judging.** Each judge gets only its own folder, so it can't see which model is which.
- **Guides.** The round judge's guide asks for the five checks above per answer. The final judge's guide asks it to double-check every claim, judge the giveaways, pick the better reply per pair, and give a verdict per round, job and level.
- **This run's files.** The answers, the verdicts and the judges' summaries are in the project's shared files, under `evidence/coach-model-eval/`.
