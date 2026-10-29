# Learn course outline

This is the plan for the Learn screens (ADR 0012): a Course of 64 Lessons in four Tracks, from a complete beginner to the end of intermediate level. Advanced level is future work, listed at the end.

- **Beginner** is for a Player who knows how the pieces move, up to about 1400 on Lichess or chess.com. Its first Lessons also suit a Player who is still learning the moves: they start with capturing and with check.
- **Intermediate** goes from about 1400 to about 1800.

The rules of the game are taught where they are used: check and mate in the Themes, castling in the opening principles, promotion, en passant and the draw rules in the endgames.

## How the Lessons fit together

Every Lesson has a learning goal (what the Player can do afterwards) and its prior knowledge (the Lessons to know first). Every part of a Lesson has a key idea, written in its source file. Nothing is locked. The app suggests the Lesson the Player started and has not finished, or else the first Lesson in the Course order below whose prior knowledge the Player has finished. A Player above beginner level is not sent through the beginner Lessons first, unless their linked Lichess or chess.com rating is under 1400.

The Course order mixes the four Tracks, so a Player never does two Lessons of the same kind in a row for long, and each Lesson comes after the ones it builds on. `data-prep/course.ts` holds this order. The Learn screen shows the Lessons by Track and level, in the same order.

Positions come from Lichess's open data (the puzzle database, the games database and the chess-openings list) or from famous games as Wikipedia or Wikibooks give them. Every explanation is written fresh. The books in the owner's private folder decided the topics and their order only (ADR 0012).

"Rewritten" Lessons existed before this course: their text is rewritten in the new style, and any part kept from Wikibooks or Wikipedia keeps its credit. "New" Lessons are written for this course. "Puzzles" names the Lichess puzzle tags (Lichess calls them themes), or for openings the opening, that the Lesson's practice Puzzles come from.

## Track 1: Themes

Patterns that win material, give mate or save a game.

| # | Lesson | Level | Learning goal | Prior knowledge | Status | Puzzles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Attack and defence (`attack-and-defend`) | Beginner | You can see which pieces each side attacks, take a piece that is left undefended, and save an attacked piece by moving it, guarding it, blocking the attack or taking the attacker. | none | New | hangingPiece |
| 2 | Getting out of check (`check`) | Beginner | You can tell when a king is in check and find every way out: move the king, block the check, or take the checking piece. | Attack and defence | New | none |
| 3 | Mate in one (`mate-in-one`) | Beginner | You can tell checkmate from check, and find a mate in one move when there is one. | Getting out of check | New | mateIn1 |
| 4 | Double attacks (`double-attack`) | Beginner | You can find a move that attacks two things at once, often with the queen, so the opponent cannot save both. | Attack and defence, What the pieces are worth | New | none |
| 5 | Forks (`forks`) | Beginner | You can spot a fork by a knight, a bishop or a pawn, see why a fork that gives check wins the other piece, and use a check to set one up. | Double attacks | Rewritten | fork |
| 6 | Pins (`pins`) | Beginner | You can pin a piece to a more valuable one behind it, and win the pinned piece by attacking it again. | What the pieces are worth | Rewritten | pin |
| 7 | Back-rank mate (`back-rank-mate`) | Beginner | You can mate a king trapped behind its own pawns on the back rank, and give your own king an escape square in time. | Mate in one | Rewritten | backRankMate |
| 8 | Skewers (`skewers`) | Beginner | You can attack a valuable piece so that, when it moves away, you win the piece behind it. | Pins | Rewritten | skewer |
| 9 | Discovered attacks (`discovered-attacks`) | Beginner | You can move one piece out of the way so that the piece behind it attacks, and use the moving piece to attack something else too. | Double attacks | Rewritten | discoveredAttack |
| 10 | Removing the defender (`removing-the-defender`) | Beginner | You can win a piece by taking or chasing away its only defender, or by giving that defender two jobs at once. | Forks | Rewritten | capturingDefender |
| 11 | Discovered check and double check (`discovered-check`) | Beginner | You can move one piece out of the way so the piece behind it gives check while the moved piece attacks something else. You can also use a double check, which the king can only answer by moving. | Discovered attacks | New | discoveredCheck, doubleCheck |
| 12 | Mate in two (`mate-in-two`) | Beginner | You can find a mate in two moves by first taking away the king's escape squares or forcing it where you want it. | Mate in one, Checks, captures and threats | New | mateIn2 |
| 13 | Using a pin (`pinned-pieces`) | Intermediate | You can attack a pinned piece with a pawn, add attackers to it, and take advantage of a pinned piece that can no longer defend. | Pins | New | none |
| 14 | Deflection (`deflection`) | Intermediate | You can force a defending piece away from the square or piece it guards, often with a sacrifice, and then win what it guarded. | Removing the defender | New | deflection |
| 15 | Decoy (`decoy`) | Intermediate | You can lure a king or queen onto a square where a fork, a pin or a mate is waiting. | Deflection | New | attraction |
| 16 | Mating patterns (`mating-patterns`) | Intermediate | You can recognise the smothered mate and other common mating patterns, and play the moves that lead to them. | Mate in two, Back-rank mate | New | smotheredMate, anastasiaMate, arabianMate, bodenMate, hookMate, doubleBishopMate, dovetailMate |
| 17 | In-between moves (`zwischenzug`) | Intermediate | Before you recapture or answer a threat, you can look for a stronger move to play first, such as a check or a bigger threat. | Candidate moves and thinking ahead | New | intermezzo |
| 18 | Trapping a piece (`trapped-pieces`) | Intermediate | You can win a piece that has no safe square left, and keep your own pieces from walking into a trap. | Blunder check | New | trappedPiece |
| 19 | Clearing and blocking lines (`clearance-and-interference`) | Intermediate | You can move a piece off a square or line so another piece can use it, and put a piece between an enemy piece and what it defends. | Discovered attacks, Deflection | New | clearance, interference |
| 20 | Quiet moves (`quiet-moves`) | Intermediate | You can find a winning move that is not a check or a capture, such as one that cuts off the king or makes a threat that cannot be met. | Mating patterns | New | quietMove |
| 21 | Perpetual check (`perpetual-check`) | Intermediate | When you are losing, you can see when checks that never stop will save the game with a draw. | Checks, captures and threats, Stalemate and other draws | New | none |
| 22 | Combining Themes (`combinations`) | Intermediate | You can see when one forcing move, such as a decoy or a clearing sacrifice, sets up a second Theme that wins. | Decoy, Clearing and blocking lines | New | sacrifice |

## Track 2: Endgames

Positions with few pieces left: how to mate, promote a pawn, and win or save the endgames that come up most.

| # | Lesson | Level | Learning goal | Prior knowledge | Status | Puzzles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Mate with king and queen (`queen-mate`) | Beginner | You can mate a lone king with king and queen, pushing it to the edge without giving stalemate. | Mate in one | Rewritten | none |
| 2 | Mate with two rooks (`two-rook-mate`) | Beginner | You can mate a lone king with two rooks, taking turns to push it rank by rank to the edge. | Mate with king and queen | New | none |
| 3 | Mate with king and rook (`rook-mate`) | Beginner | You can mate a lone king with king and rook, using your king to help and a waiting move when you need one. | Mate with two rooks | Rewritten | none |
| 4 | Pawns: promotion and en passant (`pawn-promotion`) | Beginner | You can promote a pawn, tell with the square of the pawn whether a king can catch it, and capture en passant. | none | New | promotion |
| 5 | Stalemate and other draws (`draws`) | Beginner | You can avoid stalemate when you are winning, aim for it when you are losing, and know the other draws: repetition and too few pieces left to mate. | Mate with king and queen | New | none |
| 6 | The king in the endgame (`active-king`) | Beginner | Once the queens have been traded, you can bring your king into the game to attack pawns and support your own. | Pawns: promotion and en passant | New | none |
| 7 | King and pawn endgames (`king-and-pawn`) | Intermediate | You can tell whether king and pawn win against a lone king, using the opposition and the key squares in front of the pawn. | The king in the endgame | Rewritten | pawnEndgame |
| 8 | Zugzwang (`zugzwang`) | Intermediate | You can win a position where the opponent would be fine if they could pass, by making the move that leaves them only bad moves. | King and pawn endgames | New | zugzwang |
| 9 | Passed pawns (`passed-pawns`) | Intermediate | You can make a passed pawn from a pawn majority, use an outside passed pawn to pull the enemy king away, and stop an enemy passed pawn. | King and pawn endgames | New | advancedPawn |
| 10 | Breakthroughs and pawn races (`pawn-races`) | Intermediate | You can break through a pawn wall with a pawn sacrifice, and count who promotes first in a race. | Passed pawns | New | none |
| 11 | Rook endgame basics (`rook-endgame-basics`) | Intermediate | You can keep your rook active, put it behind a passed pawn, and cut the enemy king off from the pawn. | Mate with king and rook, Passed pawns | New | none |
| 12 | Rook endgames: Lucena and Philidor (`rook-endgames`) | Intermediate | You can win the Lucena position by building a bridge, and draw the Philidor position with the defending rook on the third rank. | Rook endgame basics | Rewritten | rookEndgame |
| 13 | Bishop and knight endgames (`minor-piece-endgames`) | Intermediate | You can tell when a bishop beats a knight and when the reverse is true, and know two draws: bishops of opposite colours, and the wrong bishop with a rook pawn. | Good and bad pieces | New | bishopEndgame, knightEndgame |

## Track 3: Openings

How to start a game, then openings for White and for Black. Each opening Lesson teaches the plan behind the moves and shows what players at the Player's level choose.

| # | Lesson | Level | Learning goal | Prior knowledge | Status | Puzzles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Opening principles (`opening-principles`) | Beginner | In the first moves of any game, you can claim the centre with pawns, bring out knights and bishops, castle early, and avoid moving one piece again and again. | none | New | none |
| 2 | Stopping the early queen attack (`scholars-mate-defence`) | Beginner | As Black, you can stop Scholar's Mate and other early queen attacks, and gain time by developing while you attack the queen. | Opening principles, Spot the threat | New | Scholar's Mate (opening tags) |
| 3 | Italian Game (`italian-game`) | Beginner | As White, you can play the Italian Game: aim the bishop at f7, put pawns on c3 and d4 to build a centre, and castle. | Opening principles | Rewritten | Italian Game |
| 4 | London System (`london-system`) | Beginner | As White, you can set up the London System: the bishop out to f4 before the e-pawn moves to e3, pawns on d4, e3 and c3, and knights on f3 and d2. | Opening principles | Rewritten | London System |
| 5 | Two Knights Defence (`two-knights-defence`) | Beginner | As Black against the Italian Game, you can play the Two Knights Defence and know how to meet the attack on f7. | Italian Game | Rewritten | Two Knights Defence |
| 6 | Queen's Gambit (`queens-gambit`) | Beginner | As White, you can offer the c-pawn with the Queen's Gambit, and win it back while you develop when Black takes it. | Opening principles | Rewritten | Queen's Gambit Accepted |
| 7 | Caro-Kann Defence (`caro-kann`) | Beginner | As Black against 1.e4, you can play the Caro-Kann: support d5 with the c-pawn on c6, bring out the bishop on c8 early, and keep a solid position. | Opening principles | Rewritten | Caro-Kann |
| 8 | Queen's Gambit Declined (`queens-gambit-declined`) | Beginner | As Black against the Queen's Gambit, you can hold the centre with the e-pawn on e6, develop, castle, and know which pieces still need to come out. | Queen's Gambit | Rewritten | Queen's Gambit Declined |
| 9 | Ruy Lopez (`ruy-lopez`) | Intermediate | As White, you can play the main line of the Ruy Lopez, and know why the bishop attacks the knight that guards e5. | Italian Game | Rewritten | Ruy Lopez |
| 10 | Scotch Game (`scotch-game`) | Intermediate | As White, you can open the centre at once with the Scotch Game, and develop quickly when Black takes on d4. | Italian Game | New | Scotch Game |
| 11 | Opening traps (`opening-traps`) | Intermediate | You can spot common opening traps, such as attacks on f2 and f7, and avoid falling into them. | Stopping the early queen attack, Italian Game | New | none |
| 12 | Sicilian Defence (`sicilian-defence`) | Intermediate | As Black against 1.e4, you can play the Sicilian Defence: trade your c-pawn for White's d-pawn, then build the Dragon set-up with ...g6, ...Bg7, castling and ...Nc6. | Opening principles | New | Sicilian Defence |
| 13 | French Defence (`french-defence`) | Intermediate | As Black against 1.e4, you can play the French Defence and know the plan against White's pawn chain: attack its base with ...c5 and its front with ...f6. | Pawn chains and breaks | New | French Defence |
| 14 | Gambits (`gambits`) | Intermediate | You can judge when a pawn offered in the opening is worth taking, and when to give one back to finish developing. | Opening traps | New | none |

## Track 4: How to think during a game

What to check before every move, and how to make a plan. The beginner Lessons build a habit; the intermediate Lessons add the ideas behind a plan.

| # | Lesson | Level | Learning goal | Prior knowledge | Status | Puzzles |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | What the pieces are worth (`piece-values`) | Beginner | You can count material with the usual values (pawn 1, knight and bishop 3, rook 5, queen 9), and tell a good trade from a bad one. | Attack and defence | New | none |
| 2 | Spot the threat (`threats`) | Beginner | After each of your opponent's moves, you can ask what it threatens, and find a move that deals with the threat. | What the pieces are worth | New | defensiveMove |
| 3 | Blunder check (`blunder-check`) | Beginner | Before you play a move, you can look at what your opponent could take, check or attack after it, and pick a safer move when the answer is bad. | Spot the threat | New | none |
| 4 | Checks, captures and threats (`checks-captures-threats`) | Beginner | You can list every check, capture and threat for both sides before choosing a move, and find the forcing move that wins. | Blunder check | New | none |
| 5 | Active pieces and the centre (`centre-and-activity`) | Beginner | When nothing can be won at once, you can improve a piece by putting it on a square where it controls more, especially in the centre. | Opening principles | New | none |
| 6 | Candidate moves and thinking ahead (`candidate-moves`) | Intermediate | You can list two or three candidate moves, look a few moves ahead in each, and choose with the opponent's best reply in mind. | Checks, captures and threats | New | none |
| 7 | Simple plans (`simple-plans`) | Intermediate | You can make a small plan from the position: improve your worst piece, attack a weak pawn, or bring a rook to an open file. | Candidate moves and thinking ahead, Active pieces and the centre | New | none |
| 8 | Weak pawns (`weak-pawns`) | Intermediate | You can recognise isolated, doubled and backward pawns, attack them in your opponent's position, and avoid them in yours. | Simple plans | New | none |
| 9 | Pawn chains and breaks (`pawn-structure`) | Intermediate | You can read a pawn chain, attack it at its base with a pawn break, and tell open positions from closed ones. | Weak pawns | New | none |
| 10 | Weak squares and outposts (`weak-squares`) | Intermediate | You can find a square that no enemy pawn can attack, and put a knight or another piece there. | Pawn chains and breaks | New | none |
| 11 | Open files and the seventh rank (`open-files`) | Intermediate | You can put a rook on an open file, put your second rook on the same file, and use a rook on the seventh rank to attack pawns and trap the king. | Weak squares and outposts | New | none |
| 12 | Good and bad pieces (`good-and-bad-pieces`) | Intermediate | You can tell a good bishop from a bad one blocked by its own pawns, use the two bishops, and decide when a knight is better than a bishop. | Pawn chains and breaks | New | none |
| 13 | When to trade pieces (`when-to-trade`) | Intermediate | Before a trade, you can look at king safety, material and the pieces it would remove, and decide whether to trade or to keep the pieces on. | What the pieces are worth, Good and bad pieces | New | none |
| 14 | Attacking the king (`attacking-the-king`) | Intermediate | You can attack a king with more pieces than defend it, open lines towards it, and punish a king left in the centre. | Mating patterns, Open files and the seventh rank | New | kingsideAttack, exposedKing |
| 15 | Defending (`defending`) | Intermediate | When your king is under attack, you can name the threat and stop it, look for a forcing move of your own, trade off the strongest attacker, or give back material to break the attack. | Attacking the king | New | none |

## Course order

The order the app suggests the Lessons in, beginner Lessons first:

1. Attack and defence
2. Getting out of check
3. Mate in one
4. What the pieces are worth
5. Opening principles
6. Mate with king and queen
7. Spot the threat
8. Double attacks
9. Forks
10. Stopping the early queen attack
11. Mate with two rooks
12. Pins
13. Blunder check
14. Italian Game
15. Mate with king and rook
16. Back-rank mate
17. Skewers
18. Pawns: promotion and en passant
19. Checks, captures and threats
20. London System
21. Discovered attacks
22. Stalemate and other draws
23. Two Knights Defence
24. Removing the defender
25. Discovered check and double check
26. The king in the endgame
27. Queen's Gambit
28. Active pieces and the centre
29. Mate in two
30. Caro-Kann Defence
31. Queen's Gambit Declined
32. Candidate moves and thinking ahead
33. King and pawn endgames
34. Using a pin
35. Deflection
36. Ruy Lopez
37. Decoy
38. Zugzwang
39. Simple plans
40. Mating patterns
41. Scotch Game
42. Passed pawns
43. Weak pawns
44. In-between moves
45. Opening traps
46. Trapping a piece
47. Breakthroughs and pawn races
48. Pawn chains and breaks
49. Clearing and blocking lines
50. Sicilian Defence
51. Rook endgame basics
52. Weak squares and outposts
53. Quiet moves
54. French Defence
55. Rook endgames: Lucena and Philidor
56. Open files and the seventh rank
57. Perpetual check
58. Gambits
59. Good and bad pieces
60. Bishop and knight endgames
61. Combining Themes
62. When to trade pieces
63. Attacking the king
64. Defending

## Future work: advanced level

Not in this course:

- Deeper Themes: the windmill, the desperado, x-ray defence, and long combinations.
- Advanced endgames: queen against a pawn, rook against a pawn, triangulation, fortresses, deep rook endgame theory, and mate with bishop and knight.
- Deep opening theory: the main lines of the Sicilian, the King's Indian, the Nimzo-Indian and the Grünfeld.
- Advanced strategy: prophylaxis, the minority attack, colour complexes, and long-term sacrifices.
