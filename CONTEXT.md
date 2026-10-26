# OpenChessCoach

A chess learning app where Claude teaches a player chess, with a chess engine supplying the facts that Claude explains.

## Language

### People and roles

**Player**:
The person learning chess in the app.
_Avoid_: User, student, learner

**Coach**:
Claude in its teaching role: it explains in plain language why the Engine's verdicts hold (what a move does, what the alternatives were, why they are worse) and never judges a position on its own.
_Avoid_: AI, tutor, bot, assistant

**Engine**:
The chess engine that is the sole judge of evaluations and good or bad moves.
_Avoid_: Computer, AI, bot

### Games

**Engine Game**:
A game the Player plays against the Engine inside the app.
_Avoid_: Bot game, computer game, live game

**Imported Game**:
A finished game the Player played elsewhere (Lichess, chess.com, or pasted PGN) and brought into the app.
_Avoid_: External game, online game

### Judging moves

**Move Grade**:
The Engine's verdict on a single move, based on how much it gives away compared with the best move, not on its rank among the Engine's choices.
_Avoid_: Accuracy, rating, score

### Teaching

**Review**:
The Coach's walk-through of the key moments of a finished game.
_Avoid_: Analysis, post-mortem, game report

**Why Question**:
The Player asking the Coach why a move or position is good or bad.
_Avoid_: Explain request, query

**Live Coaching**:
The Coach commenting on the Player's moves while an Engine Game is in progress. Optional.
_Avoid_: Real-time analysis, commentary

**Hint**:
A nudge from the Coach towards a good move, offered only in Engine Games and Lessons.
_Avoid_: Tip, suggestion, assist

**Lesson**:
An interactive session where the Coach teaches a topic, such as an opening, a Theme or a basic endgame, by asking the Player to choose moves and explaining the consequences of their choice.
_Avoid_: Tutorial, course, drill

**Theme**:
A recurring pattern that wins material or gives mate, such as a fork, a pin or a back-rank mate, taught in a Lesson and practised in Puzzles.
_Avoid_: Tactic, motif

**Puzzle**:
A position from a real game where the Player must find the strongest continuation, used as practice after a Lesson.
_Avoid_: Exercise, tactic, problem

**Player Profile**:
A structured, terse record of the Player's current level, strengths, weaknesses, Goals and Lesson progress, which the Coach consults only as far as the task needs.
_Avoid_: Memory, weakness profile, player model

**Goal**:
Something the Player has said they want to achieve, such as learning a particular opening.
_Avoid_: Objective, target
