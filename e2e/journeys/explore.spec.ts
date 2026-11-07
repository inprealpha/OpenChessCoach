// Feature map: exploring a position (docs/design/interface-guidelines.md, "Exploring a position").
// Every board that shows a position to learn from takes moves: the Review, a Lesson once it is
// complete, a Puzzle once it is finished and an Engine Game once it is over. A move there starts a
// variation, the move list shows it under the move it branches from, the browser's Engine grades
// its moves, and Back to the game drops it and puts the board back where the Player left the game.
// A board that refuses a move says why.
import { readFileSync } from 'node:fs';
import { INITIAL_FEN, legalMoves, moveLabel, playLine, playUci, turnOf } from '../../packages/shared/src/chess.ts';
import { decisions, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import type { PuzzleFile } from '../../packages/shared/src/content/puzzles.ts';
import { coachIdle, coachPanel, expect, fenOf, play, resign, square, test } from '../fixtures/app.ts';

const REVIEW = 'Review board';

/** A legal move in `fen` other than `not`: a move of the Player's own, away from the game's line. */
function anotherMove(fen: string, not?: string): string {
  const move = legalMoves(fen).find((m) => m !== not);
  if (!move) throw new Error(`No other move in ${fen}`);
  return move;
}

test.describe('the Review board', () => {
  test('takes moves as a variation, grades them, and Back to the game returns to the open key moment', async ({ paired, app }) => {
    const [game] = await app.rows<{ moves: string }>('games');
    const moves = playLine(INITIAL_FEN, (game?.moves ?? '').split(' '));
    // 11. Bxf7+ (ply 21), the first key moment: the Review opens on it, on the position before the move.
    const bxf7 = moves[20]!;
    expect(bxf7.san).toBe('Bxf7+');

    await paired.goto(`${app.url}/#/review/1`);
    await paired.getByRole('button', { name: 'Start the Review' }).click();
    const moment = paired.getByRole('button', { name: 'Show moment: move 11. Bxf7+, Mistake' });
    await expect(moment).toHaveAttribute('aria-pressed', 'true', { timeout: 90_000 });
    const board = paired.getByRole('group', { name: REVIEW });
    await expect(board).toHaveAttribute('data-fen', bxf7.fenBefore);
    const back = paired.getByRole('button', { name: 'Back to the game' });
    await expect(back).toHaveCount(0);

    // The Engine's better move, axb4, played on the board: a variation from 10… dxe4, graded by the browser's Engine.
    await play(paired, 'a3b4', REVIEW);
    const axb4 = playUci(bxf7.fenBefore, 'a3b4')!;
    await expect(board).toHaveAttribute('data-fen', axb4.fenAfter);
    await expect(back).toBeVisible();
    const variation = paired.getByRole('list', { name: 'Variation from move 10… dxe4' });
    await expect(variation.getByRole('button', { name: /^Variation move 11\. axb4, (Best|Good)$/ })).toBeVisible({ timeout: 30_000 });
    // The game's own moves are still all there.
    await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button', { name: /^Move / })).toHaveCount(moves.length);

    // A reply for Black carries the variation on; the step buttons walk it.
    const reply = anotherMove(axb4.fenAfter);
    await play(paired, reply, REVIEW);
    await expect(variation.getByRole('button')).toHaveCount(2);
    await paired.getByRole('button', { name: 'Previous move' }).click();
    await expect(board).toHaveAttribute('data-fen', axb4.fenAfter);
    await paired.getByRole('button', { name: 'First position' }).click();
    await expect(board).toHaveAttribute('data-fen', bxf7.fenBefore);
    await expect(variation.getByRole('button')).toHaveCount(2);

    // A Why Question about the variation's move: only the moves go, and the desktop's Engine works out the facts.
    await variation.getByRole('button', { name: /^Variation move 11\. axb4/ }).click();
    await expect(board).toHaveAttribute('data-fen', axb4.fenAfter);
    const callsBefore = (await app.rows('coach_calls')).length;
    await coachPanel(paired).getByRole('button', { name: 'Ask the Coach why' }).click();
    await coachIdle(paired);
    await expect(coachPanel(paired)).toContainText(/You:\s*Why (is axb4 graded (Best|Good)|axb4)\?/);
    const calls = await app.rows<{ job: string; brief: string }>('coach_calls');
    expect(calls).toHaveLength(callsBefore + 1);
    expect(calls.at(-1)?.job).toBe('why');
    expect(calls.at(-1)?.brief).toContain('axb4');

    // Back to the game: the variation goes, and the board is on the open key moment again.
    await back.click();
    await expect(back).toHaveCount(0);
    await expect(variation).toHaveCount(0);
    await expect(board).toHaveAttribute('data-fen', bxf7.fenBefore);
    await expect(moment).toHaveAttribute('aria-pressed', 'true');

    // The game's own move steps the game, as on Lichess: no variation.
    await play(paired, bxf7.uci, REVIEW);
    await expect(board).toHaveAttribute('data-fen', bxf7.fenAfter);
    await expect(back).toHaveCount(0);
    await expect(board.getByRole('img', { name: 'Mistake on f7' })).toBeVisible();

    // A move picked in the game's move list leaves a variation for the game.
    await play(paired, anotherMove(bxf7.fenAfter, moves[21]?.uci), REVIEW);
    await expect(back).toBeVisible();
    await paired.getByRole('button', { name: 'Move 12. Bg5, Mistake', exact: true }).click();
    await expect(back).toHaveCount(0);
    await expect(board).toHaveAttribute('data-fen', moves[22]!.fenAfter);
  });

  test('takes moves before the Review is started too', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/review/1`);
    await expect(paired.getByRole('button', { name: 'Start the Review' })).toBeVisible();
    const board = paired.getByRole('group', { name: REVIEW });
    await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
    await play(paired, 'd2d4', REVIEW);
    await expect(board).toHaveAttribute('data-fen', playUci(INITIAL_FEN, 'd2d4')!.fenAfter);
    await expect(paired.getByRole('list', { name: 'Variation from the start' })).toBeVisible();
    await paired.getByRole('button', { name: 'Back to the game' }).click();
    await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
  });
});

test('a complete Lesson’s final board takes moves; during the Lesson a refused move says why', async ({ paired, app }) => {
  const lesson = JSON.parse(readFileSync(new URL('../../data/lessons/skewers.json', import.meta.url), 'utf8')) as LessonData;
  const steps = decisions(lesson);
  const last = steps.length - 1;
  app.app.db
    .prepare('INSERT INTO lesson_progress (lesson_id, step, completed, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(lesson_id) DO UPDATE SET step = excluded.step')
    .run('skewers', last, '2026-10-01T10:00:00.000Z');
  const BOARD = `${lesson.name} Lesson board`;
  await paired.goto(`${app.url}/#/lesson/skewers`);
  await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
  const node = steps[last]!.node;
  await play(paired, node.main, BOARD);
  await coachIdle(paired);

  // Waiting on Continue, the board takes no move and says why.
  const board = paired.getByRole('group', { name: BOARD });
  const piece = (await board.getByRole('button', { name: /, (white|black) / }).first().getAttribute('data-square')) ?? '';
  await square(paired, piece, BOARD).click();
  const said = board.locator('..').getByRole('status');
  await expect(said).toHaveText('Press Continue for the Lesson’s next move.');

  await paired.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(paired.getByRole('region', { name: 'Lesson complete' })).toBeVisible();
  // The reason went with the state that caused it.
  await expect(said).toHaveText('');
  const final = await fenOf(paired, BOARD);
  // The Ask box names the move a Why Question asks about: none on the final position, then the variation's move.
  const ask = paired.getByLabel('Your Why Question');
  await expect(ask).toHaveAttribute('placeholder', 'Ask about this position');
  const move = anotherMove(final);
  await play(paired, move, BOARD);
  await expect(board).toHaveAttribute('data-fen', playUci(final, move)!.fenAfter);
  const tried = playUci(final, move)!;
  await expect(ask).toHaveAttribute('placeholder', `Ask why about ${moveLabel(tried.fenBefore, tried.san)}`);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const why = (await app.rows<{ job: string; brief: string }>('coach_calls')).filter((c) => c.job === 'why').at(-1);
  expect((JSON.parse(why!.brief) as { move?: { uci: string } }).move?.uci).toBe(tried.uci);
  const back = paired.getByRole('button', { name: 'Back to the Lesson' });
  await expect(back).toBeVisible();
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(board).toHaveAttribute('data-fen', final);
  await expect(ask).toHaveAttribute('placeholder', 'Ask about this position');
  await back.click();
  await expect(back).toHaveCount(0);
  await expect(board).toHaveAttribute('data-fen', final);
});

test('a finished Puzzle’s board takes moves as a variation, and its solution’s own move steps the solution', async ({ paired, app }) => {
  const load = (file: string) => (JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8')) as PuzzleFile).puzzles;
  const puzzles = [...load('puzzles.json'), ...load('theme-puzzles.json')];
  const BOARD = 'Puzzle board';
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const region = paired.getByRole('region', { name: 'Puzzle', exact: true });
  await expect(region).toHaveAttribute('data-puzzle-id', /.+/);
  const id = await region.getAttribute('data-puzzle-id');
  const data = puzzles.find((p) => p.id === id);
  if (!data) throw new Error(`Puzzle ${id} is not in the data file`);
  const line = playLine(data.fen, data.moves);
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board).toHaveAttribute('data-fen', line[0]!.fenAfter);

  // A Hint first, then the same button shows the solution.
  await paired.getByRole('button', { name: 'Hint', exact: true }).click();
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
  await paired.getByRole('button', { name: 'First position' }).click();
  const set = line[0]!.fenAfter;
  await expect(board).toHaveAttribute('data-fen', set);

  // A move that isn't the solution's: a variation.
  const move = anotherMove(set, line[1]!.uci);
  await play(paired, move, BOARD);
  await expect(board).toHaveAttribute('data-fen', playUci(set, move)!.fenAfter);
  await expect(region.getByLabel('Your variation').getByRole('button')).toHaveCount(1);
  const back = paired.getByRole('button', { name: 'Back to the Puzzle' });
  await back.click();
  await expect(board).toHaveAttribute('data-fen', set);
  await expect(region.getByLabel('Your variation')).toHaveCount(0);

  // The solution's own move steps the solution.
  await play(paired, line[1]!.uci, BOARD);
  await expect(board).toHaveAttribute('data-fen', line[1]!.fenAfter);
  await expect(back).toHaveCount(0);
});

test('an Engine Game’s board takes moves once the game is over', async ({ paired, app }) => {
  const BOARD = 'Engine Game board';
  await paired.goto(`${app.url}/#/engine-game`);
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('radio', { name: 'Beginner' }).check();
  await paired.getByRole('button', { name: 'Start the Engine Game' }).click();
  await play(paired, 'e2e4', BOARD);
  const moves = paired.getByRole('list', { name: 'Moves' });
  await expect(moves.getByRole('button')).toHaveCount(2);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');

  const final = await fenOf(paired, BOARD);
  expect(turnOf(final)).toBe('white');
  const move = anotherMove(final);
  await play(paired, move, BOARD);
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board).toHaveAttribute('data-fen', playUci(final, move)!.fenAfter);
  await expect(moves.getByRole('list', { name: /^Variation from move 1… / }).getByRole('button')).toHaveCount(1);
  await paired.getByRole('button', { name: 'Back to the game' }).click();
  await expect(board).toHaveAttribute('data-fen', final);

  // From an earlier position, the game's own move steps the game rather than starting a variation.
  await paired.getByRole('button', { name: 'Previous move' }).click();
  const afterE4 = playUci(INITIAL_FEN, 'e2e4')!.fenAfter;
  await expect(board).toHaveAttribute('data-fen', afterE4);
  const engineReply = legalMoves(afterE4).find((m) => playUci(afterE4, m)?.fenAfter === final)!;
  await play(paired, engineReply, BOARD);
  await expect(board).toHaveAttribute('data-fen', final);
  await expect(paired.getByRole('button', { name: 'Back to the game' })).toHaveCount(0);
});

test('on the Board, a move played after stepping back starts a variation and keeps the rest of the line', async ({ paired, app }) => {
  const BOARD = 'Chess board';
  await paired.goto(`${app.url}/#/board`);
  for (const uci of ['e2e4', 'e7e5', 'g1f3']) await play(paired, uci, BOARD);
  const line = playLine(INITIAL_FEN, ['e2e4', 'e7e5', 'g1f3']);
  const moves = paired.getByRole('list', { name: 'Moves' });
  await expect(moves.getByRole('button', { name: /^Move / })).toHaveCount(3);
  const board = paired.getByRole('group', { name: BOARD });
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(board).toHaveAttribute('data-fen', line[0]!.fenAfter);

  await play(paired, 'c7c5', BOARD);
  await expect(board).toHaveAttribute('data-fen', playUci(line[0]!.fenAfter, 'c7c5')!.fenAfter);
  await expect(moves.getByRole('button', { name: /^Move / })).toHaveCount(3);
  await expect(moves.getByRole('list', { name: 'Variation from move 1. e4' }).getByRole('button', { name: /^Variation move 1… c5/ })).toBeVisible();
  await paired.getByRole('button', { name: 'Back to the main line' }).click();
  await expect(board).toHaveAttribute('data-fen', line[0]!.fenAfter);
  await expect(moves.getByRole('list', { name: /^Variation/ })).toHaveCount(0);

  // The line's own next move steps along it, and a move at the end of the line extends it.
  await play(paired, 'e7e5', BOARD);
  await expect(board).toHaveAttribute('data-fen', line[1]!.fenAfter);
  await paired.getByRole('button', { name: 'Last position' }).click();
  await play(paired, 'b8c6', BOARD);
  await expect(moves.getByRole('button', { name: /^Move / })).toHaveCount(4);
  await expect(paired.getByRole('button', { name: 'Back to the main line' })).toHaveCount(0);
});
