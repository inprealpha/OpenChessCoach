# The Coach gets facts read off the Engine's lines, not only the lines

A raw Engine line shows best play from both sides and hides the why: what a move takes or attacks, what it leaves to be taken, what the reply wins. Given only lines, the Coach has to work the chess out itself, which language models do badly, and it then teaches whatever it guessed (ADR 0002). So before each Coach call an explainability layer (`packages/shared/src/coach/explain.ts`) reads facts off the board and the Engine lines the desktop already has, and the brief carries them beside each move: `does`, what the move does on the board (what it takes, attacks two at once, leaves to be taken, stops guarding, and the like), and `result`, what the forcing moves right after it lead to, in material or a mate. The Coach is told to build on these and never to work out captures, attacks or material itself.

A wrong fact is worse than none, because the Coach repeats it with confidence. Every fact is the board as it stands or what happens in an Engine line, and three rules keep them true:

- A board fact that could be beside the point (a piece that can be taken, an attack, a double attack, a skewer) is stated only when the Engine's line after the move soon takes that piece.
- Material is counted only over the forcing sequence right after the move (captures, checks, answers to a check), never deep in a line, where the Engine's moves are a guess. It is stated only when it is at least a piece's worth, the Engine's score leans the same way, and counting a little further into the line doesn't undo it.
- A mate is stated with its moves, so it is plain which move the count starts from.

## Consequences

- The layer adds no Engine searches: it reads the lines the brief already has, in a few milliseconds. Live Coaching and Hints, which must stay short, get facts only on the move, the Engine's best move and its best reply.
- A Why Question that names a move the Engine didn't list ("Why not Nxe5?") is the one place the desktop searches for the layer: it grades that move, at most two of them, so the brief has its line and facts beside the candidates, marked `asked`.
- Each fact is typed and names its pieces and squares, so it can later be drawn on the board as well as said.
- Facts are tested on real positions: the Lichess puzzles' own solutions and the golden games (`packages/shared/test/explain.test.ts`), including a check that quiet, sound moves in real games get no tactical claim at all, and every failure the adversarial reviews found.
- The layer was tuned on a fixed set of 20 positions, the Coach's answers judged claim by claim against the Engine, and checked once on 5 positions held out from the tuning. A threat search after each key move and a list of pieces that can be taken were tried and dropped: they were never the main reason and needed the most rules to keep true.
