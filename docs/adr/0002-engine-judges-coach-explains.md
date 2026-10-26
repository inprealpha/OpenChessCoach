# The Engine judges, the Coach explains

The Engine is the only judge of evaluations and Move Grades. The Coach never assesses a position on its own. Its job is to explain in plain language why the Engine's verdicts hold: what a move does, what the alternatives were, and why they are worse. Any move the Coach shows must be legal and must come from the Engine's output. Language models play chess unreliably, so a Coach that judged positions itself would confidently teach wrong chess.

## Consequences

- A Move Grade measures how much winning chance a move gives up compared with the best move, the way Lichess does. It does not depend on the move's rank, so a sound fourth-best move is graded as good.
- The Engine looks at several candidate moves at once, so the Coach can discuss reasonable alternatives as well as the single best move.
- One floor on top of the Lichess formula (added 2026-10-13, the owner's call): a move that gives up 300 centipawns or more against the best move is at least a Mistake. In a decided game the winning chance barely moves, so the formula alone graded hanging a piece a queen down, or walking into mate, as Good. A Player learning should be told. In an undecided position a loss that big is already a Mistake or Blunder by the formula, so the floor changes nothing there.
- The floor steps aside for a mate (added 2026-10-25, the owner's call): when the Engine still reports a forced mate for the mover after the move, the move is left to the formula, however much later the mate comes. A slower mate gives nothing away. It depends on the Engine seeing the mate at its depth: a mate beyond the horizon reads as a big centipawn score, and the floor still applies.
