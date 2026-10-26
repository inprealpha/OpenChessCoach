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
```

## Proof

- The reply's `moves` and arrows are all in the desktop Engine's candidates; `stripped` counts the
  rest.
- `coach_calls` has one row per call with `job: why`, the brief (under 3,500 characters) and the model.
- In the browser, the scripted non-Engine arrow never appears on the board (`board.spec.ts`).
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
