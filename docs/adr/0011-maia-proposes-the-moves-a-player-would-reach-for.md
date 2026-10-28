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

## Licence

Maia-3's code is AGPL-3.0, and its weights have no licence of their own; the model card points to the repository for both. We treat the weights as AGPL-3.0. Abir accepted this on 28 October 2026.

- The app does not ship Maia-3's code. Its board encoding is our own TypeScript, and the authors' Python is used once, offline, to convert the weights.
- The weights bring in the AGPL's network clause: anyone who uses the app over a network, such as the owner's phone on the LAN or through the tunnel, must be offered its source. The repository is public, so the app links to it.
- Hosting the converted weights redistributes them, under the AGPL with its licence text. We should still ask the authors to confirm the weights' licence.

## Consequences

- New runtime dependency: onnxruntime-web (MIT), about 14 MB in the npm package (its Node build and one `.wasm` file, copied into `dist/ort/` by the build). The model needs a few hundred MB of memory once loaded.
- `THIRD_PARTY_NOTICES.md` lists the Maia-3 weights (AGPL-3.0) and onnxruntime-web (MIT).
- A position set up by hand has no history. Maia-3 then sees only that position and guesses less well.
- The Coach presents a guess as a move many players would reach for, never as a prediction of what this Player will do. Even Maia-3 misses about a third of the tempting mistakes.
- Verify mode stays deterministic (ADR 0006): it uses a fixed fake source of moves, never the network or Opus.
- Maia2 (MIT) is the fallback choice if the AGPL becomes a problem. It is almost as good, and its top three match Maia-3's.
- Building this changes the brief, the guard and the Coach's instructions, so it waits until the Think Deeper PR merges.
