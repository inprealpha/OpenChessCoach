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

## Amendment: the Coach chooses the main point (#32)

A Review's key moment can be true in every sentence and still miss the point. In a friend's game, 7. Qe5+ left Black three ways to block the check, and 7... Be7 was the Blunder because the bishop on f8 was the only guard of g7. The brief said only that Be7 "brings the bishop out from its starting square" and "leaves Black's pawn on g7" to be taken, so the Coach wrote about development and a loose pawn and never said Black was in check or why g7 fell. The facts layer had decided what mattered, and the Coach could only repeat it.

So the facts still decide what is true, and the Coach now decides what matters:

- **The Coach picks the one main reason** a move got its Move Grade and builds the explanation around it, leaving out true facts that don't serve it. The facts come in no order of importance. It may say what anyone can see on the board without working anything out: whose move it is, that a side is in check, where a piece stands. Everything a move takes, attacks, allows, wins or loses still comes only from the facts or, with Think deeper (ADR 0010), the Engine's answers.
- **Two facts the layer lacked.** A move made in check `answers-check`: it blocks the check, moves the king out of it, or takes the checker, naming the checking piece; such a move is not called development, which points the wrong way. And when a move leaves one of its own pieces to be taken that the moved piece guarded before, the `leaves` fact says so (`unguarded`): "stops guarding Black's pawn on g7, leaving it where White's queen on e5 can take it". The cause used to be dropped whenever the result was already said.
- **One coach.** To the Player, the Coach and the Engine are one system, so the Coach says "the best move was Qe7", not "the Engine prefers Qe7". It names the Engine only when that is the honest reason: a disputed Move Grade, a best move a person would hardly find, a best move with no simple reason, or a move the brief doesn't cover.
- **A beginner gets one idea**: the main reason and the better move, without the other candidates' Move Grades or a tempting move that isn't the trap the moment is about.
- **Winning Chances in the brief are numbers only** ("68%", with the side they belong to). Given the screen's whole label, the Coach copied it into its sentence: "your winning chances went from Black's winning chances: 68% to …". The evaluations beside Winning Chances on every screen are now from White's point of view, as most chess sites show them, whichever side the Winning Chances are for.
