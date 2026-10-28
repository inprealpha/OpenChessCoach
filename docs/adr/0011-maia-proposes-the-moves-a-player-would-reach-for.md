# Maia-3 proposes the moves a Player would reach for; the Engine still judges them

A Player often goes wrong with the obvious move: the one that jumps out at a glance and that the Engine would never list among its best. To warn about it, the Coach first needs to know which moves a player at that level would reach for. The Engine can't tell it, because it ranks moves by strength, not by how tempting they look.

We measured this on real Lichess moves made in 1 to 3 seconds, with half of them graded Inaccuracy or worse (`docs/research/human-move-prediction.md`). Maia-3, a neural network trained only to predict human moves (CSSLab, University of Toronto), guessed them better than Haiku, Sonnet and Opus, and better than Maia2:

- When the human's quick move was a mistake, Maia-3's first guess was that move 41% of the time, and its top three held it 69% of the time. Opus managed 25% and 54%.
- Its smallest released model, 5M, was as good as its largest, 79M.

So Maia-3's 5M model proposes the moves a Player would reach for. The Engine grades each one before the Coach talks about it, so ADR 0002 is unchanged: the Engine judges, the Coach explains, and Maia only adds moves for the Engine to judge.

- The backend runs the model itself, converted to ONNX (21 MB), with onnxruntime-web. A position takes 9 to 20 ms on the desktop.
- Its input is the game's last 8 positions and the Player's rating, because both clearly improve its guesses.
- The model is downloaded in the background after install, from a release asset we host, pinned by URL, size and SHA-256, and stored in the data folder.
- Until the download is ready, or if it fails, Opus guesses instead.

## In the Coach

**Which jobs get tempting moves:**

| Job | Tempting moves | Why |
| --- | --- | --- |
| Why Question | Yes | The Coach has room to say why the natural move fails, or that it is fine. |
| Review moment | Yes | The Player's own move is often one many players reach for; the Coach can say so, and name another trap. |
| Hint | Only from Maia-3, and only those the Engine already lists | A Hint may warn of a trap without naming the move. It must stay quick: an Opus guess would add about 8 seconds, so while the model downloads, Hints get none; and a tempting move the Engine didn't list would cost a search of its own, so a Hint keeps only the tempting moves among the Engine's candidates. |
| Live Coaching | No | One or two short sentences right after the move leave no room. |
| Lesson turn | No | It already has how often players at the Player's level choose each move (ADR 0005). |

Tempting moves describe what players at the Player's level reach for, so a position where it isn't the Player's turn (when the Player's side is known) gets none.

**How they reach the brief:**

- The guess starts alongside the Engine's other searches. The desktop's Engine then grades each tempting move as it grades a move the Player asks about (`gradeAsked`): an Engine candidate as it is, any other with its score and the Engine's line after it.
- The brief marks the tempting moves among the candidates, and the move itself, with `tempting: true`. It lists the ones the Engine didn't list in `tempting`, graded against the Engine's best move and explained (`does`, `result`) like the candidates. When a brief is over its budget (ADR 0004), their lines and facts are trimmed first, and the list is dropped before the facts on the key moves.
- The move guard counts them as Engine output (ADR 0002): the Coach may show and draw a tempting move, and name the moves of its line but not draw them, as for an asked move.
- The Coach is told to call one "a move many players would reach for here", never a prediction of what this Player will do, and never to say how it was picked. For one graded Inaccuracy or worse, it says why it fails, from its line and facts.

**What Maia-3 reads:**

- **The game.** A Review gives the game's own moves. Otherwise the client's moves are replayed from the usual start position. If they lead to the position asked about, Maia-3 gets the last 8 positions; if not, as for a position set up by hand, it gets that position alone.
- **The rating.** Maia-3 learned Lichess blitz ratings. The Player Profile shows the rating of the first pool the Player has played on Lichess or chess.com, rapid first. The desktop also records which pool that is, and the Player's blitz rating on that site (the `rating_pools` table). Maia-3 gets, in this order:
  1. The blitz rating, when the Player has one: Lichess as it is, or chess.com converted.
  2. The Profile's rating when its pool converts soundly: Lichess rapid as it is (the nearest pool on the same site), or chess.com rapid converted.
  3. Otherwise 1500. That covers Lichess classical, bullet and correspondence, chess.com daily and bullet, and a rating linked before the desktop recorded its pool.

  The conversions use ChessGoals' rating comparison (July 2026, <https://chessgoals.com/rating-comparison/>), with straight lines between its rows: for example chess.com rapid 1500 → 1620, and chess.com blitz 1390 → 1681. The opponent's rating isn't known, so it is taken as the Player's.

**What it costs:**

- With Maia-3: a few milliseconds per call, and nothing from the owner's Claude limits.
- While the model downloads, or if Maia-3 fails: one more Opus call per Why Question and Review moment, about 8 seconds and 1.5 cents at API prices. It runs alongside the Engine's searches. It has a 15-second deadline, after which the Coach answers without tempting moves, and an output ceiling of 2,000 tokens, as the Coach's own calls have one.
- Each call's tempting moves are logged with it, in the `coach_tempting` table: where they came from, the moves, how long the guess took, and what an Opus guess cost.

## Measured

Before merging, the real Coach (Sonnet, as in the Balanced preset) answered 18 fixed positions with tempting moves off and on, from the same Engine facts, with Maia-3 guessing (`scripts/tempting-moves-eval.ts`, positions in `scripts/tempting-moves-positions.json`).

- 12 positions are real players' quick mistakes from the research (3 per rating band, past the opening), asked "What should I play here, and why?" with the game's moves and the player's rating.
- 6 are from the Think deeper set (ADR 0010): Why Questions about a blunder, a missed move and "Why not X?", and Review moments.

Two Opus judges, who didn't know which mode wrote which answer, checked every claim against the Engine at depth 18, as for ADR 0009 and 0010.

| Off → on | Result |
| --- | --- |
| Quick mistakes where the answer names the move the player actually made | 4 → 7 of 12 (Maia-3 had it in its three in those 7) |
| **Coach errors: false claims that contradict the brief** | **2 → 2** (in 2 answers each) |
| Claims the brief's depth-14 search makes and a depth-18 search contradicts | 23 → 21 |
| All false claims, of all claims | 25 of 142 → 23 of 158 |
| Answers with a false claim of either kind | 11 → 10 of 18 |
| Answers missing the main reason | 4 → 4 of 18 |
| Answers that present a move as a prediction about this Player | 0 → 0 |
| Median time per answer | 6.9 → 6.7 s |
| Median brief size | 1,231 → 1,350 characters |

Each false claim was split in two:

- **A Coach error:** the claim contradicts the brief. These were "Bxb5 wins your knight" where the brief's line trades bishop for knight, "the free pawn" where the line recaptures, "you lose material", and "a threat on the queen's line" where there is no queen.
- **A depth difference:** the Coach repeats the brief faithfully, as ADR 0002 asks, and a deeper search sees it differently. For example "Nc6 is an Inaccuracy", where depth 18 says Blunder.

So the Coach warns of the move players actually reach for more often, with no more errors of its own. It stated every tempting move's Move Grade as the brief gives it. When it names a tempting move, it sometimes gives only its Move Grade ("g5 is a Blunder") without the reason, which the brief has.

## Licence

Maia-3's code is AGPL-3.0, and its weights have no licence of their own; the model card points to the repository for both. We treat the weights as AGPL-3.0. Abir accepted this on 28 October 2026.

- The app does not ship Maia-3's code. Its board encoding is our own TypeScript, and the authors' Python is used once, offline, to convert the weights.
- The weights bring in the AGPL's network clause: anyone who uses the app over a network, such as the owner's phone on the LAN or through the tunnel, must be offered its source. The repository is public, so the app links to it.
- Hosting the converted weights redistributes them, under the AGPL with its licence text.

## Consequences

- New runtime dependency: onnxruntime-web (MIT), about 14 MB in the npm package (its Node build and one `.wasm` file, copied into `dist/ort/` by the build). The model needs a few hundred MB of memory once loaded.
- `THIRD_PARTY_NOTICES.md` lists the Maia-3 weights (AGPL-3.0) and onnxruntime-web (MIT).
- A position set up by hand has no history. Maia-3 then sees only that position and guesses less well.
- The Coach presents a guess as a move many players would reach for, never as a prediction of what this Player will do. Even Maia-3 misses about a third of the tempting mistakes.
- Verify mode stays deterministic (ADR 0006): it uses a fixed fake source of moves, never the network or Opus.
- Maia2 (MIT) is the fallback choice if the AGPL becomes a problem. It is almost as good, and its top three match Maia-3's.
- Building this changes the brief, the guard and the Coach's instructions, so it waits until the Think Deeper PR merges.
