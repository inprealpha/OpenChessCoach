# Structured sources for opening Lessons

Researched 2026-10-12 for the AI Chess Coach. The question: can Lichess lessons, or any other structured, reusable source, supply Lesson content, so the Coach teaches from data instead of inventing lines?

## Recommendation

No single source gives ready-made beginner opening Lessons under a license we can reuse. Combine four open sources, each doing one job:

| Job in a Lesson | Source | License |
|---|---|---|
| Which openings exist, their names and main move paths (the Lesson catalogue and Goal names) | Lichess `chess-openings` | CC0 |
| "What are your options here?" (the candidate moves and how often players at the Player's level choose them) | Stats precomputed from the Lichess games database, or the live Lichess Opening Explorer when the Player signs in with Lichess | CC0 data; the Explorer API needs a token |
| Why a move is good (ideas, plans, named replies, traps) | Wikibooks *Chess Opening Theory* | CC BY-SA 4.0 |
| Follow-up practice in the same opening | Lichess puzzle database, filtered by `OpeningTags` and rating | CC0 |

The Engine stays the judge of every move; these sources supply the menu of moves and the vocabulary for explaining them. Lichess's own Learn, Practice and community studies are not reusable as content (details below).

## Comparison

| Source | What it holds | Format and size | License or terms | Fit |
|---|---|---|---|---|
| **Lichess `chess-openings`** ([repo](https://github.com/lichess-org/chess-openings)) | Every named opening and variation, with ECO code and move sequence | TSV files `a.tsv`–`e.tsv` (columns `eco`, `name`, `pgn`); build adds `uci`, `epd`. About 3,700 rows. Also on Hugging Face as Parquet | CC0 ("as a collection of facts, this data set is in the public domain") | **High.** The Lesson catalogue: a tree of named positions, a Lesson per node, and terse Player Profile entries like `italian_game: completed`. Same names as the Lichess puzzle `OpeningTags`, so they join cleanly |
| **Lichess Opening Explorer API** (`explorer.lichess.org`, endpoints `/lichess`, `/masters`, `/player`) | Per-position move stats: games, white/draw/black counts, average rating; filterable by rating band (0, 1000, 1200 … 2500) and speed | JSON over HTTP | API usage, not a data license. **Since about March 2026 every request needs a Lichess token** (no scope needed; OAuth PKCE "Login with Lichess" works for public clients). Rate limited, one request at a time | **Medium.** Great for "what do players at your level play here", but the token requirement means each Player must sign in with Lichess, or the app ships a shared token, which is fragile. Better as an optional live layer |
| **Lichess games database** ([database.lichess.org](https://database.lichess.org/)) | 8.2 billion rated games, monthly PGN dumps with player ratings | PGN in `.zst`, tens of GB per month | CC0 ("research, commercial purpose, publication, anything you like") | **High, offline.** Precompute rating-band move stats for just the positions in our Lesson trees (a few thousand positions) into a small JSON shipped with the app. Removes the Explorer token problem for curated Lessons |
| **Lichess evaluations database** (same site) | 416 million positions with Stockfish evals and principal variations | JSON lines | CC0 | **Low–medium.** Could pre-cache Engine verdicts for Lesson positions, but running Stockfish locally is simpler and already in the design |
| **Lichess puzzle database** (same site, also on Hugging Face) | 6.1 million rated puzzles with `Themes` and `OpeningTags` (set for puzzles starting before move 20) | CSV: `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate` | CC0 | **High** for practice after a Lesson: "three Italian Game puzzles rated under 1200". Puzzles are tactics arising from the opening, not opening-move drills |
| **Wikibooks *Chess Opening Theory*** ([book](https://en.wikibooks.org/wiki/Chess_Opening_Theory)) | About 2,600 pages, one per position, keyed by move path (`.../1._e4/1...e5/2._Nf3/2...Nc6/3._Bc4`). Each page has FEN, ECO, parent, list of responses, prose on ideas and plans, and a theory table | MediaWiki pages; readable through the MediaWiki API (`action=parse` or `prop=extracts`) or the enwikibooks dumps | CC BY-SA 4.0: attribution required; any adapted text we ship must stay CC BY-SA (the app's code is unaffected) | **High** for the "why". The Italian Game page, for example, explains Bc4's pressure on f7, the c3/d4 plan, and contrasts 3...Nf6 (sharp, Fried Liver) with 3...Bc5 (quiet). Coverage is thinner off the main lines, and quality varies by page |
| **Wikipedia opening articles** | History and overview per opening | MediaWiki | CC BY-SA 4.0 | **Low.** Overlaps Wikibooks with less move-by-move detail |
| **`eco.json`** ([JeffML/eco.json](https://github.com/JeffML/eco.json), npm `@chess-openings/eco.json`) | 12,500+ names keyed by FEN, plus a from/to transition graph between named positions | JSON | Repo says MIT, but the data merges Lichess, SCID, Wikipedia, Wikibooks and ChessTempo names, so provenance is mixed | **Medium.** Handy FEN lookup and transitions. Names are facts, but Lichess's CC0 set is the cleaner base; this adds little we need |
| **Public-domain classics** (Capablanca *Chess Fundamentals* 1921 on Project Gutenberg; Lasker *Common Sense in Chess* 1896) | General opening principles: develop, control the centre, castle, don't move a piece twice | Plain text | Public domain in the US | **Low–medium.** A source for a short, fixed list of principles the Coach can cite. Not structured by position |
| **Lichess Learn** (`lichess.org/learn`, code in `lila/ui/learn/src/stage`) | Rules lessons: how pieces move, capture, check, castling, en passant, stalemate | TypeScript in the Lichess server repo | AGPL-3.0 (code and its embedded text). Reusing it would put our package under AGPL | **Low.** Teaches the rules, not openings |
| **Lichess Practice** (`lichess.org/practice`) | Checkmates, tactics (pin, fork, skewer …), pawn and rook endgames | Lichess studies | No public license; studies are Lichess-hosted content | **None for openings.** Practice has no opening section |
| **Lichess community studies** (`/api/study/{id}.pgn`) | Thousands of opening studies, many beginner-oriented ("44 Opening Lines You Must Know") | Annotated PGN, exportable via API | Authors keep their rights and grant only Lichess a license; no reuse right for us without each author's permission | **Not reusable** without asking authors. Fine as inspiration or as links out |
| **chessdb.cn** cloud database | Engine-scored moves per position | JSON API | No license stated | **Skip.** Duplicates the Engine's role |
| **chess.com, Chessable, ChessTempo, ChessKid lessons** | Courses and drills | Proprietary | All rights reserved | **Skip** |

## How the pieces fit one Lesson

Taking the Italian Game as the example:

1. **Catalogue.** `chess-openings` gives the node `C50 Italian Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4` and its children (Giuoco Piano, Two Knights, Evans Gambit …). The Player Profile records progress per node.
2. **"What are your options?"** At each Player-to-move position, the Lesson offers the moves that rating-band stats (precomputed from the games database) show are commonly played, and the Engine marks which are sound.
3. **Why.** A terse notes file per node, written once offline from the Wikibooks page (ideas, plan, common replies, one trap), so the Coach reads a few lines instead of a whole page. Because it is adapted from Wikibooks, that file is CC BY-SA 4.0 with attribution; the app credits Wikibooks where the Coach uses it.
4. **Practice.** Puzzles where `OpeningTags` contains `Italian_Game` and `Rating < 1300`.

## Open points for the owner

- **Explorer token.** Live rating-band stats need each Player to sign in with Lichess. Precomputing stats for the curated Lessons avoids that; the live Explorer could then be an optional extra for positions off the Lesson tree.
- **Share-alike text.** If the app's distributed package includes Wikibooks-derived notes, those notes (only) must carry CC BY-SA 4.0. Fetching Wikibooks at runtime and letting the Coach summarise avoids shipping it, at the cost of network calls and less control.
