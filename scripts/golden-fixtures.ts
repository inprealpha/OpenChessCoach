// Regenerates the golden fixtures: every move of the fixture games graded by Stockfish at verify
// mode's fixed depth. Run after changing the grader or the Engine build, then review the diff.
//   node scripts/golden-fixtures.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { gradeGame } from '../packages/shared/src/analysis.ts';
import { parsePgnGames } from '../packages/shared/src/pgn.ts';
import { createNodeEngine } from '../packages/backend/src/engine/node-engine.ts';
import { VERIFY_ENGINE } from '../packages/backend/src/verify/instance.ts';

const dir = new URL('../packages/shared/test/fixtures/', import.meta.url);
const games = parsePgnGames(readFileSync(new URL('lichess-games.pgn', dir), 'utf8'));
const engine = await createNodeEngine();
const out = [];
for (const game of games) {
  const graded = await gradeGame(engine, game.moves, { depth: VERIFY_ENGINE.depth, multiPv: VERIFY_ENGINE.multiPv }, game.startFen);
  out.push({ site: game.headers.Site, opening: game.headers.Opening, moves: graded });
  process.stderr.write(`${game.headers.Site}: ${graded.length} moves\n`);
}
writeFileSync(new URL('graded-games.json', dir), `${JSON.stringify({ engine: `Stockfish 18 lite, depth ${VERIFY_ENGINE.depth}, ${VERIFY_ENGINE.multiPv} lines`, games: out })}\n`);
// The Engine keeps the event loop alive; the fixtures are written, so stop here.
process.exit(0);
