# Why Question

The Player asks the Coach why a move is good or bad. The client sends only the position and the
move; the desktop's Engine works out the facts for a compact brief (ADR 0007); the Coach
explains; any move the Coach shows that the Engine never suggested is stripped (ADR 0002,
ADR 0004).

**Reached from:** the region `Coach` beside the Board, a Review, a Lesson or a Puzzle. Select a
move, then `Ask the Coach why`, or type a question.

## Drive

```bash
$C ask-why --fen "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2" --move Nf3
$C coach script --reply '{"text":"Try this.","moves":["a2a4"],"arrows":[{"uci":"a2a4","brush":"green"}]}'
$C ask-why --fen "<same fen>" --move Nf3      # the scripted move is stripped: "stripped": 2
$C db get coach_calls                          # the brief, the raw reply and what was stripped
# A question naming a move the Engine didn't list: 4. Nxe5 after 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4
$C ask-why --fen "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4" --move O-O --question "Why not Nxe5?"
```

## Proof

- The reply's `moves` and arrows are all in the desktop Engine's candidates; `stripped` counts the
  rest.
- `coach_calls` has one row per call with `job: why`, the brief (under 3,500 characters) and the model.
- In the browser, the scripted non-Engine arrow never appears on the board (`board.spec.ts`).
- The brief's `winningChances` are the numbers the Winning Chances bar shows either side of the
  move, and the fake Coach repeats them ("Before it, White’s winning chances: 54%. After it, …").
  On the Board they are the Engine's best line in each position: 54% and 54% around 3. Bc4
  (`board.spec.ts`). From a Review the request carries `gameId`, and the desktop scores both
  positions from the Review's graded moves, as its bar and key moments do: 35% and 19% around
  12. Bg5 (`imported-game.spec.ts`, `coach.test.ts`). A mate counts as the bar counts it, from the
  position after the move: "White mates in 1" after 17. Qd6+ (`coach.test.ts`). Where the screen
  hides the bar, in a Lesson or a Puzzle, the request says so (`hideWinningChances`) and the brief
  carries none; a Hint never does.
- A move the question names in SAN ("Why not Nxe5?"), legal in the position and not the move
  itself, is in the brief with `asked: true`: marked among the candidates when the Engine listed it,
  and otherwise graded on the desktop's Engine (one more search each, at most two moves, Why
  Questions only) and added after them with its Move Grade, line, `does` and `result`. The guard
  lets the Coach show it, and name the moves of its line (each where the line plays it) but not draw them, and the fake Coach says "You asked about Nxe5: it is graded Inaccuracy. It
  takes Black's pawn on e5…" with a blue arrow f3 to e5 (`board.spec.ts`). A move that isn't legal,
  or one named only in words, changes nothing (`coach.test.ts`).
- A question is at most 300 characters (`MAX_QUESTION_LENGTH`): the input stops there and shows how
  many characters are left from 50 before it (`board.spec.ts`); the desktop refuses a longer one with
  "A question can be at most 300 characters." (`coach.test.ts`). If a longer one is forced past the
  box, the panel shows that error, keeps the question in the box to shorten, and shows no "You: …"
  line for it (`board.spec.ts`); a Lesson's typed explanation is refused the same way
  (`lesson.spec.ts`). Any failed call takes the Player's words back out of the conversation.

## Gotchas

- Engine facts a client adds to `coach.ask` are ignored: the brief in `coach_calls` always has the
  desktop Engine's own (`coach.test.ts`).
- When the Coach is unavailable (`$C coach status --unavailable "Claude Code is logged out"`), the
  panel says why and `Ask the Coach why` is disabled; the board keeps working.
- `$C coach script --limit` makes the next call fail as if the Claude limit were used up.
- Changing Coach code needs the real-Coach check from the desktop as well: see
  `.claude/skills/real-coach-check/SKILL.md`.
