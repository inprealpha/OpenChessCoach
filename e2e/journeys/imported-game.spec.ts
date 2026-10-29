// Feature map: Imported Game (PGN and by username) and Review.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { INITIAL_FEN } from '../../packages/shared/src/chess.ts';
import { CoachClient } from '../../packages/backend/src/client.ts';
import { coachIdle, connection, engineGate, expect, fenOf, storedOnDevice, test } from '../fixtures/app.ts';

const PGNS = readFileSync(new URL('../../packages/shared/test/fixtures/lichess-games.pgn', import.meta.url), 'utf8')
  .trim()
  .split(/\n\n(?=\[Event )/);

test('a pasted PGN is imported once, and a broken one shows an error', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const before = (await app.rows('games')).length;

  await paired.getByLabel('PGN', { exact: true }).fill('1. e4 e5 2. Ke3 Nf6 1-0');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('alert')).toContainText(/not legal|isn’t legal|illegal/i);
  expect(await app.rows('games')).toHaveLength(before);

  await paired.getByLabel('PGN', { exact: true }).fill(PGNS[1] as string);
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  // Neither player is known to the app, so the Player picks a side.
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported:' })).toBeVisible();
  const table = paired.getByRole('table', { name: 'Game list' });
  await expect(table.getByRole('row')).toHaveCount(before + 2);
  await expect(table).toContainText('Scandinavian Defense');

  await paired.getByLabel('PGN', { exact: true }).fill(PGNS[1] as string);
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByText('You already imported that game.')).toBeVisible();
  expect(await app.rows('games')).toHaveLength(before + 1);

  // A PGN that doesn't say when it was played shows no made-up date.
  await paired.getByLabel('PGN', { exact: true }).fill('[White "Alex"]\n[Black "Sam"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 1/2-1/2');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported: Alex vs Sam' })).toBeVisible();
  const dateless = table.getByRole('row').filter({ hasText: 'Sam (PGN)' });
  await expect(dateless.getByRole('cell').first()).toHaveText('Unknown');
  await expect(dateless.getByRole('link', { name: 'Review: Sam, date unknown' })).toBeVisible();
});

test('moves pasted without a result import when they end in checkmate, and an unfinished game says how to fix it', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const before = (await app.rows('games')).length;

  await paired.getByLabel('PGN', { exact: true }).fill('1. e4 e5 2. Nf3');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('alert')).toHaveText(
    'That game has no result. Add it after the last move (1-0, 0-1 or 1/2-1/2), then import it again. Only finished games can be imported.',
  );
  expect(await app.rows('games')).toHaveLength(before);

  // Moves copied from a book or a chat, with no result: the checkmate on the board decides it.
  await paired.getByLabel('PGN', { exact: true }).fill('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported:' })).toBeVisible();
  const games = await app.rows<{ result: string; moves: string }>('games');
  expect(games).toHaveLength(before + 1);
  expect(games.find((g) => g.moves.endsWith('h5f7'))?.result).toBe('1-0');
  const row = paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'Wayward Queen Attack' });
  await expect(row).toContainText('Won with White');
});

test('the Player picks their side for a pasted PGN, none is picked for them, and the list shows it', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  await paired.getByLabel('PGN', { exact: true }).fill(PGNS[1] as string);
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  // Asked once, as a question rather than an error, with neither side picked.
  const question = paired.getByRole('group', { name: 'Which side did you play?' });
  await expect(question).toBeVisible();
  await expect(paired.getByRole('alert')).toHaveCount(0);
  await expect(question.getByRole('radio', { name: 'White' })).not.toBeChecked();
  await expect(question.getByRole('radio', { name: 'Black' })).not.toBeChecked();
  await expect(paired.getByRole('button', { name: 'Import PGN' })).toBeDisabled();
  await question.getByRole('radio', { name: 'Black' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported: Sig vs Desmond_Wilson' })).toBeVisible();
  expect((await app.rows<{ white: string; player_side: string }>('games')).find((g) => g.white === 'Sig')?.player_side).toBe('black');
  // White won, and the Player was Black.
  await expect(paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'Sig (PGN)' })).toContainText('Lost with Black');
});

test('a side picked for one pasted game is asked again for another', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  await paired.getByLabel('PGN', { exact: true }).fill(PGNS[1] as string);
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  const question = paired.getByRole('group', { name: 'Which side did you play?' });
  await question.getByRole('radio', { name: 'Black' }).check();
  // The Player pastes another game instead: Black was their side in the first one.
  await paired.getByLabel('PGN', { exact: true }).fill('[White "Carol"]\n[Black "Dan"]\n\n1. d4 d5 2. c4 e6 1-0');
  await expect(question).toHaveCount(0);
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(question.getByRole('radio', { name: 'Black' })).not.toBeChecked();
  await expect(question.getByRole('radio', { name: 'White' })).not.toBeChecked();
  expect(await app.rows('games')).toHaveLength(1);
});

test('a game imported with the wrong side gets the right one, and a game can be deleted', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const table = paired.getByRole('table', { name: 'Game list' });
  // The seeded game: the Player as White, and Black won.
  const row = table.getByRole('row').filter({ hasText: 'ikatsca (PGN)' });
  await expect(row).toContainText('Lost with White');

  await row.getByRole('button', { name: /^More: / }).click();
  await row.getByRole('button', { name: 'I played Black' }).click();
  // The game had no Review, so nothing is lost and nothing is asked.
  await expect(table.getByRole('row').filter({ hasText: 'bijean (PGN)' })).toContainText('Won with Black');
  expect((await app.rows<{ player_side: string }>('games')).map((g) => g.player_side)).toEqual(['black']);

  const moved = table.getByRole('row').filter({ hasText: 'bijean (PGN)' });
  await moved.getByRole('button', { name: /^More: / }).click();
  await moved.getByRole('button', { name: 'Delete game' }).click();
  const confirm = paired.getByRole('alertdialog', { name: 'Delete the game against bijean?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Keep the game' })).toBeFocused();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  expect(await app.rows('games')).toHaveLength(1);

  await moved.getByRole('button', { name: /^More: / }).click();
  await moved.getByRole('button', { name: 'Delete game' }).click();
  await paired.getByRole('alertdialog').getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(paired.getByText('No games yet.', { exact: false })).toBeVisible();
  expect(await app.rows('games')).toHaveLength(0);
});

test('switching the side of a reviewed game asks first, as its Review goes', async ({ paired, app }) => {
  const c = await CoachClient.connect(app.url, app.token);
  try {
    await c.request('review.start', { gameId: 1 });
  } finally {
    await c.close();
  }
  await paired.goto(`${app.url}/#/games`);
  const row = paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'ikatsca (PGN)' });
  await expect(row.getByRole('link', { name: /^Open Review/ })).toBeVisible();
  await row.getByRole('button', { name: /^More: / }).click();
  await row.getByRole('button', { name: 'I played Black' }).click();
  const confirm = paired.getByRole('alertdialog', { name: 'Did you play Black against bijean?' });
  await expect(confirm).toContainText('Review');
  await confirm.getByRole('button', { name: 'Yes, I played Black' }).click();
  await expect(paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'bijean (PGN)' }).getByRole('link', { name: /^Review: bijean/ })).toBeVisible();
  expect(await app.rows('reviews')).toHaveLength(0);
  expect(await app.rows('grade_counts')).toHaveLength(0);
});

test('a side change asks first when another device made the game’s Review after the list loaded', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const table = paired.getByRole('table', { name: 'Game list' });
  const row = table.getByRole('row').filter({ hasText: 'ikatsca (PGN)' });
  await expect(row.getByRole('link', { name: /^Review: / })).toBeVisible();
  const other = await CoachClient.connect(app.url, app.token);
  try {
    await other.request('review.start', { gameId: 1 });
  } finally {
    await other.close();
  }
  // This list still shows no Review, but the desktop knows better.
  await row.getByRole('button', { name: /^More: / }).click();
  await row.getByRole('button', { name: 'I played Black' }).click();
  const confirm = paired.getByRole('alertdialog', { name: 'Did you play Black against bijean?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(row.getByRole('link', { name: /^Open Review/ })).toBeVisible();
  expect(await app.rows('reviews')).toHaveLength(1);
  expect((await app.rows<{ player_side: string }>('games')).map((g) => g.player_side)).toEqual(['white']);
  await confirm.getByRole('button', { name: 'Yes, I played Black' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'bijean (PGN)' })).toContainText('Won with Black');
  expect(await app.rows('reviews')).toHaveLength(0);
  expect(await app.rows('grade_counts')).toHaveLength(0);
});

test('a game another device deleted leaves the list when the Player deletes it too', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const table = paired.getByRole('table', { name: 'Game list' });
  await table.getByRole('button', { name: /^More: / }).click();
  await table.getByRole('button', { name: 'I played Black' }).click();
  const saved = paired.getByRole('status').filter({ hasText: 'Saved: you played Black against bijean.' });
  await expect(saved).toBeVisible();
  const other = await CoachClient.connect(app.url, app.token);
  try {
    await other.request('games.delete', { gameId: 1 });
  } finally {
    await other.close();
  }
  await table.getByRole('button', { name: /^More: / }).click();
  await table.getByRole('button', { name: 'Delete game' }).click();
  await paired.getByRole('alertdialog').getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(paired.getByRole('alert').filter({ hasText: 'That game is not in your game list.' })).toBeVisible();
  // Gone either way: the row goes, and so does the message about the side change.
  await expect(paired.getByText('No games yet.', { exact: false })).toBeVisible();
  await expect(saved).toHaveCount(0);
});

test('a refused change says why by the game’s row', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const table = paired.getByRole('table', { name: 'Game list' });
  const other = await CoachClient.connect(app.url, app.token);
  try {
    // The game's Review is being made, from another device.
    let grading!: () => void;
    const started = new Promise<void>((resolve) => (grading = resolve));
    const reviewing = other.request('review.start', { gameId: 1 }, undefined, () => grading());
    await started;
    await table.getByRole('button', { name: /^More: / }).click();
    await table.getByRole('button', { name: 'Delete game' }).click();
    await paired.getByRole('alertdialog').getByRole('button', { name: 'Yes, delete it' }).click();
    await expect(table.getByRole('alert')).toContainText('being made right now');
    await reviewing;
  } finally {
    await other.close();
  }
  expect(await app.rows('games')).toHaveLength(1);
});

test('on a phone, the More menu of the last game opens where the Player can see it', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/games`);
  const row = paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'ikatsca (PGN)' });
  await row.getByRole('button', { name: /^More: / }).click();
  await expect(row.getByRole('button', { name: 'I played Black' })).toBeInViewport({ ratio: 1 });
  await expect(row.getByRole('button', { name: 'Delete game' })).toBeInViewport({ ratio: 1 });
});

test('games are imported by username, finished ones only', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  await paired.getByLabel('Site').selectOption('lichess');
  await paired.getByRole('textbox', { name: 'Username' }).fill('CoachVerify');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported 3 finished games' })).toContainText('1 still in progress and skipped');
  const games = await app.rows<{ source: string; source_id: string }>('games');
  expect(games.filter((g) => g.source === 'lichess').map((g) => g.source_id).sort()).toEqual(['iinnkv77', 'wab4h6cl', 'wvkkfh56']);
  // The next import carries on from the newest game, and asks again for the one still being played.
  expect(await app.rows('site_imports')).toEqual([{ site: 'lichess', username: 'coachverify', imported_through: Date.parse('2013-01-01T01:35:46Z') }]);
  expect(await app.rows('site_import_playing')).toEqual([{ site: 'lichess', username: 'coachverify', game_id: 'livegame1' }]);

  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported 0 finished games' })).toContainText('3 already in your list');
  expect(await app.rows('games')).toHaveLength(games.length);

  await paired.getByLabel('Site').selectOption('chesscom');
  await paired.getByRole('textbox', { name: 'Username' }).fill('coachverify');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported 3 finished games' })).toBeVisible();

  await paired.getByLabel('Site').selectOption('lichess');
  await paired.getByRole('textbox', { name: 'Username' }).fill('BusyPlayer');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('alert')).toHaveText('Lichess is limiting requests right now. Wait a minute and try again.');
  await paired.getByRole('textbox', { name: 'Username' }).fill('NoSuchPlayer');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('alert')).toHaveText('Lichess has no player called "NoSuchPlayer". Check the spelling.');
});

test('clearing an import box clears the message from the last import', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  const pgnBox = paired.getByLabel('PGN', { exact: true });
  await pgnBox.fill('1. e4 e5 2. Ke3 Nf6 1-0');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('alert')).toBeVisible();
  await pgnBox.fill('');
  await expect(paired.getByRole('button', { name: 'Import PGN' })).toBeDisabled();
  await expect(paired.getByRole('alert')).toHaveCount(0);

  const username = paired.getByRole('textbox', { name: 'Username' });
  await paired.getByLabel('Site').selectOption('lichess');
  await username.fill('NoSuchPlayer');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('alert')).toHaveText('Lichess has no player called "NoSuchPlayer". Check the spelling.');
  await username.fill('');
  await expect(paired.getByRole('button', { name: 'Fetch finished games' })).toBeDisabled();
  await expect(paired.getByRole('alert')).toHaveCount(0);

  await username.fill('CoachVerify');
  await paired.getByRole('button', { name: 'Fetch finished games' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported 3 finished games' })).toBeVisible();
  await username.fill('');
  await expect(paired.getByRole('status').filter({ hasText: 'Imported' })).toHaveCount(0);
});

/** The seeded Italian Game's first key moment, 11. Bxf7+, as the Player sees its Winning Chances. */
async function expectBxf7Chances(moment: Locator): Promise<void> {
  await expect(moment.getByRole('button')).toHaveAccessibleName('Show moment: move 11. Bxf7+, Mistake');
  // Before is the position after 10… dxe4, scored as the bar and the graph score it.
  await expect(moment.getByTestId('chances-before')).toHaveText('Before: White’s winning chances: 48% -0.25');
  await expect(moment.getByTestId('chances-after')).toHaveText('After 11. Bxf7+: White’s winning chances: 35% -1.72');
  await expect(moment.getByText(/^Better: /)).toHaveText('Better: axb4 48% (-0.20), Ng5 44% (-0.67), Ne5 44% (-0.68)');
}

/** The seeded game's Winning Chances graph: the Player's two Mistakes (11. Bxf7+, 12. Bg5) and nothing else. */
async function expectGraphMarks(page: Page): Promise<void> {
  const graph = page.getByRole('figure', { name: 'Winning Chances graph' });
  await expect(graph).toBeVisible();
  const marks = graph.getByRole('button', { name: /^(Inaccuracy|Mistake|Blunder) by (White|Black), move \d+$/ });
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveAccessibleName('Mistake by White, move 11');
  await expect(marks.nth(1)).toHaveAccessibleName('Mistake by White, move 12');
  for (const mark of await marks.all()) await expect(mark).toHaveAttribute('data-grade', 'Mistake');
}

test('a Review lists key moments with Move Grades, and reopening it makes no Coach call', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  await paired.getByRole('link', { name: /^Review: ikatsca/ }).click();
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  const moments = paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
  await expect(moments.first()).toBeVisible({ timeout: 90_000 });
  const count = await moments.count();
  expect(count).toBeGreaterThanOrEqual(3);
  expect(count).toBeLessThanOrEqual(5);
  for (let i = 0; i < count; i++) await expect(moments.nth(i).getByRole('button', { name: /, (Inaccuracy|Mistake|Blunder)$/ })).toBeVisible();

  const calls = await app.rows<{ job: string; brief: string }>('coach_calls');
  expect(calls.filter((c) => c.job === 'review-moment')).toHaveLength(count);
  const [review] = await app.rows<{ moments: string }>('reviews');
  expect(JSON.parse(review?.moments ?? '[]')).toHaveLength(count);
  expect((await app.rows('graded_moves')).length).toBe(48);
  expect((await app.rows('grade_counts')).length).toBeGreaterThan(0);

  // Each moment shows the Player's Winning Chances before and after their move, with the
  // evaluation beside them: 11. Bxf7+ (Mistake) took White from 48% to 35%.
  await expectBxf7Chances(moments.first());
  // The Coach is told those Winning Chances in the same words, and the fake Coach repeats them.
  const bxf7 = calls.find((c) => c.job === 'review-moment');
  expect(JSON.parse(bxf7?.brief ?? '{}').winningChances).toEqual({ before: 'White’s winning chances: 48%', after: 'White’s winning chances: 35%' });
  await expect(moments.first()).toContainText('Before it, White’s winning chances: 48%. After it, White’s winning chances: 35%.');

  // Jump to a moment: the board shows the position before the move.
  await moments.nth(1).getByRole('button').click();
  await expect(moments.nth(1)).toHaveClass(/active/);

  // Move Grade symbols sit on the square each graded move landed on, and follow the steps.
  const board = paired.getByRole('group', { name: 'Review board' });
  const symbols = board.getByRole('img', { name: /^(Best|Inaccuracy|Mistake|Blunder) on [a-h][1-8]$/ });
  await paired.getByRole('button', { name: 'Move 11. Bxf7+, Mistake', exact: true }).click();
  await expect(symbols).toHaveCount(1);
  await expect(board.getByRole('img', { name: 'Mistake on f7' })).toBeVisible();
  await paired.getByRole('button', { name: 'Next move' }).click(); // 11… Rxf7, Best: a star
  await expect(board.getByRole('img', { name: 'Best on f7' })).toBeVisible();
  await expect(symbols).toHaveCount(1);
  await paired.getByRole('button', { name: 'Next move' }).click(); // 12. Bg5, Mistake
  await expect(board.getByRole('img', { name: 'Mistake on g5' })).toBeVisible();
  await expect(symbols).toHaveCount(1);
  await paired.getByRole('button', { name: 'Move 10. a3, Good', exact: true }).click(); // Good: nothing drawn
  await expect(symbols).toHaveCount(0);
  await paired.getByRole('button', { name: 'Move 16… Nc6, Inaccuracy', exact: true }).click();
  await expect(board.getByRole('img', { name: 'Inaccuracy on c6' })).toBeVisible();
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(symbols).toHaveCount(0);

  // The Winning Chances graph under the board marks the Player's two Mistakes, and jumps the board.
  await expectGraphMarks(paired);
  const graph = paired.getByRole('figure', { name: 'Winning Chances graph' });
  const current = graph.getByRole('img', { name: /^Current position: / });
  await expect(current).toHaveAccessibleName('Current position: Start: White’s winning chances: 53%');
  await graph.getByRole('button', { name: 'Mistake by White, move 12' }).click();
  await expect(board.getByRole('img', { name: 'Mistake on g5' })).toBeVisible();
  await expect(paired.getByRole('listitem').filter({ has: paired.getByRole('button', { name: 'Move 12. Bg5, Mistake', exact: true }) })).toHaveClass(/current/);
  await expect(current).toHaveAccessibleName('Current position: 12. Bg5: White’s winning chances: 19%');
  // The current move follows the steps.
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect(current).toHaveAccessibleName('Current position: 12… Qd5: White’s winning chances: 16%');
  // A click anywhere on the graph jumps there: its left edge is the start.
  const slider = graph.getByRole('slider', { name: 'Move on the Winning Chances graph' });
  await slider.click({ position: { x: 2, y: 20 } });
  await expect(current).toHaveAccessibleName('Current position: Start: White’s winning chances: 53%');
  await expect(symbols).toHaveCount(0);
  // On the graph, its own keys step once: ↑ is a step forward there, not the page's jump to the start.
  await slider.press('ArrowRight');
  await expect(current).toHaveAccessibleName(/^Current position: 1\. e4: /);
  await slider.press('ArrowUp');
  await expect(current).toHaveAccessibleName(/^Current position: 1… e5: /);

  // Reopen: the saved Review comes back with no Coach call and no Engine run, graph included.
  await paired.reload();
  await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem')).toHaveCount(count);
  expect(await app.rows('coach_calls')).toHaveLength(calls.length);
  await expectBxf7Chances(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first());
  await expectGraphMarks(paired);
  expect((await app.rows('graded_moves')).length).toBe(48);

  // The Winning Chances bar beside the board follows the moves, from the Review's own facts: no
  // Coach call and no Engine run. The Player is White, at the bottom of the board and of the bar.
  const bar = paired.getByRole('meter', { name: /^Winning Chances bar/ });
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  await paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first().getByRole('button').click();
  // A key moment shows the position before the move: the bar agrees with the moment's "Before".
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 48%');
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 35%');
  await paired.getByRole('button', { name: 'Last position' }).click();
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 4%');
  expect(await app.rows('coach_calls')).toHaveLength(calls.length);

  // A Why Question works on any move of the game.
  await paired.getByRole('button', { name: /^Move 3\. Nf3/ }).click();
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  await expect(paired.getByLabel('Coach conversation')).toContainText('Nf3 is graded');
  expect((await app.rows<{ job: string }>('coach_calls')).filter((c) => c.job === 'why')).toHaveLength(1);
});

test.describe('a Review’s overview', () => {
  // Slow enough to see the overview stream before the key moments.
  test.use({ appOptions: { chunkDelayMs: 40 } });

  test('opens the Review, streamed before the key moments; each move it names jumps the board there; it reopens with no Coach call', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/review/1`);
    // Every change to the card of the Review being made, as it happens: what its first line says,
    // and what the Coach has written so far, the overview first. Read after the Review, so a slow
    // or fast machine sees the same order.
    await paired.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { madeSeen: string[] }).madeSeen = seen;
      new MutationObserver(() => {
        const card = document.querySelector('.card[role="status"][aria-live="polite"]');
        if (!card) return;
        const parts = [...card.querySelectorAll('p.stream')].map((p) => (p.getAttribute('data-testid') === 'overview-stream' ? 'overview' : 'moment'));
        const entry = `${card.querySelector('p')?.textContent ?? ''} | ${[...new Set(parts)].join(', ')}`;
        if (seen.at(-1) !== entry) seen.push(entry);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await paired.getByRole('button', { name: 'Start the Review' }).click();
    const overview = paired.getByRole('region', { name: 'Overview' });
    await expect(overview).toBeVisible({ timeout: 90_000 });
    // The overview streamed first, with the card saying so; then the key moments, under it.
    const seen = await paired.evaluate(() => (window as unknown as { madeSeen: string[] }).madeSeen);
    const writing = 'The Coach is writing an overview of the game…';
    const explaining = 'The Coach is explaining the key moments…';
    expect(seen[0]).toMatch(new RegExp(`^${writing} \\| `));
    expect(seen).toContain(`${writing} | overview`);
    expect(seen).toContain(`${explaining} | overview, moment`);
    expect(seen.findIndex((e) => e.startsWith(explaining))).toBeGreaterThan(seen.indexOf(`${writing} | overview`));
    expect(seen.filter((e) => e.includes('moment')).every((e) => e.startsWith(explaining))).toBe(true);
    // The recorded reply for game 1 (verify/recordings/coach.json), above the key moments.
    await expect(overview).toContainText('Your opening went well, and your opponent had to find 9… d5 there');
    const keyMoments = paired.getByRole('region', { name: 'Key moments' });
    expect((await overview.boundingBox())!.y).toBeLessThan((await keyMoments.boundingBox())!.y);
    const calls = await app.rows<{ job: string }>('coach_calls');
    expect(calls.map((c) => c.job)).toEqual(['review-overview', 'review-moment', 'review-moment', 'review-moment', 'review-moment']);

    // Every move the overview names is a link to its place in the game, the opponent's too.
    const links = overview.getByRole('button');
    await expect(links).toHaveText(['9… d5', '11. Bxf7+', '12. Bg5', '18. d5', '24. Bxc5']);
    const board = paired.getByRole('group', { name: 'Review board' });
    const current = paired.getByRole('figure', { name: 'Winning Chances graph' }).getByRole('img', { name: /^Current position: / });
    await overview.getByRole('button', { name: 'Go to move 9… d5, Best' }).click();
    await expect(board.getByRole('img', { name: 'Best on d5' })).toBeVisible();
    await expect(current).toHaveAccessibleName(/^Current position: 9… d5: /);
    await expect(paired.getByRole('listitem').filter({ has: paired.getByRole('button', { name: 'Move 9… d5, Best', exact: true }) })).toHaveClass(/current/);
    await overview.getByRole('button', { name: 'Go to move 12. Bg5, Mistake' }).click();
    await expect(board.getByRole('img', { name: 'Mistake on g5' })).toBeVisible();
    await expect(current).toHaveAccessibleName('Current position: 12. Bg5: White’s winning chances: 19%');

    // Reopened, the saved overview is there, links and all, with no Coach call.
    const text = await overview.textContent();
    await paired.reload();
    await expect(paired.getByRole('region', { name: 'Overview' })).toHaveText(text ?? '');
    await expect(paired.getByRole('region', { name: 'Overview' }).getByRole('button')).toHaveCount(5);
    expect(await app.rows('coach_calls')).toHaveLength(calls.length);
  });

  test('turned off in Settings, a Review is its key moments only, with no overview call, and stays so when turned on again', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    const toggle = paired.getByRole('checkbox', { name: 'Open each Review with the Coach’s overview of the whole game' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(paired.getByRole('region', { name: 'Reviews' }).getByRole('status')).toHaveText('Saved.');
    expect(await app.rows<{ key: string; value: string }>('settings')).toContainEqual({ key: 'reviewOverview', value: 'false' });

    await paired.goto(`${app.url}/#/review/1`);
    await paired.getByRole('button', { name: 'Start the Review' }).click();
    await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem')).toHaveCount(4, { timeout: 90_000 });
    await expect(paired.getByRole('region', { name: 'Overview' })).toHaveCount(0);
    // The Coach call log: the four key moments, and no overview.
    expect((await app.rows<{ job: string }>('coach_calls')).map((c) => c.job)).toEqual(['review-moment', 'review-moment', 'review-moment', 'review-moment']);

    // Turned on again, the Review saved without one keeps no overview.
    await paired.goto(`${app.url}/#/settings`);
    await toggle.check();
    await expect(paired.getByRole('region', { name: 'Reviews' }).getByRole('status')).toHaveText('Saved.');
    await paired.goto(`${app.url}/#/review/1`);
    await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem')).toHaveCount(4);
    await expect(paired.getByRole('region', { name: 'Overview' })).toHaveCount(0);
    expect(await app.rows('coach_calls')).toHaveLength(4);
  });
});

test('in a Review, the arrow keys step through the game as on Lichess', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/review/1`);
  const board = paired.getByRole('group', { name: 'Review board' });
  const list = paired.getByRole('list', { name: 'Moves' });
  const current = list.locator('li.current').getByRole('button');
  const last = list.getByRole('listitem').last();
  /** Whether the last move shows inside the move list's own scroll box. */
  const lastInView = async () => {
    const box = await list.boundingBox();
    const item = await last.boundingBox();
    return Boolean(box && item && item.y >= box.y - 1 && item.y + item.height <= box.y + box.height + 1);
  };
  await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
  await expect(current).toHaveCount(0);
  expect(await lastInView()).toBe(false);
  for (let i = 0; i < 3; i++) await paired.keyboard.press('ArrowRight');
  await expect(current).toHaveAccessibleName(/^Move 2\. Bc4/);
  await paired.keyboard.press('ArrowLeft');
  await expect(current).toHaveAccessibleName(/^Move 1… e5/);
  await paired.keyboard.press('End');
  await expect(last).toHaveClass(/current/);
  // The list scrolls itself to keep the current move in view: the game's last move shows.
  await expect.poll(lastInView).toBe(true);
  await paired.keyboard.press('ArrowUp');
  await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
  await paired.keyboard.press('ArrowDown');
  await expect(last).toHaveClass(/current/);
  await paired.keyboard.press('Home');
  await expect(current).toHaveCount(0);
  await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
});

test('in a Review, the Threat button shows the desktop Engine’s threat for the position on the board', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Threat' }).click();
  // After 9...d5 the pawn attacks White's bishop on c4 and knight on e4.
  await paired.getByRole('button', { name: /^Move 9… d5/ }).click();
  const fen = await fenOf(paired, 'Review board');
  expect(fen).toMatch(/ w /);
  const desktop = await CoachClient.connect(app.url, app.token);
  try {
    const { threat } = await desktop.request('engine.threat', { fen });
    expect(threat).toMatchObject({ side: 'black', san: expect.stringMatching(/^dx[ce]4$/) });
    const t = threat as { san: string; uci: string };
    await expect(paired.getByRole('img', { name: /^Threat: / })).toHaveAccessibleName(`Threat: Black threatens ${t.san} (${t.uci.slice(0, 2)} to ${t.uci.slice(2, 4)})`);
  } finally {
    await desktop.close();
  }
});

test('a Review shows one number per position, and an open key moment shows its position everywhere', async ({ paired, app }) => {
  const bar = paired.getByRole('meter', { name: /^Winning Chances bar/ });
  const current = paired.getByRole('figure', { name: 'Winning Chances graph' }).getByRole('img', { name: /^Current position: / });
  const board = paired.getByRole('group', { name: 'Review board' });
  const symbols = board.getByRole('img', { name: /^(Best|Inaccuracy|Mistake|Blunder) on [a-h][1-8]$/ });
  const threat = paired.getByRole('img', { name: /^Threat: / });
  const coachArrows = paired.getByRole('img', { name: /^Arrow / });
  const move = (name: string) => paired.getByRole('list', { name: 'Moves' }).getByRole('button', { name, exact: true });
  const moment = (san: string) => paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').filter({ hasText: san });
  /** The bar and the graph's current point name the same Winning Chances. */
  const expectShown = async (graphLabel: string, percent: string) => {
    await expect(current).toHaveAccessibleName(`Current position: ${graphLabel}: White’s winning chances: ${percent}`);
    await expect(bar).toHaveAccessibleName(`Winning Chances bar: White’s winning chances: ${percent}`);
  };

  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Threat' }).click();
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first()).toBeVisible({ timeout: 90_000 });

  // 12. Bg5 was the Engine's fourth line: the bar, the graph and its card all read the score
  // that graded it (-3.88), not the next search's, one ply deeper.
  await expect(moment('12. Bg5').getByTestId('chances-after')).toHaveText('After 12. Bg5: White’s winning chances: 19% -3.88');
  await move('Move 12. Bg5, Mistake').click();
  await expectShown('12. Bg5', '19%');
  // Its "Before" is the position after 11… Rxf7, as the bar and the graph show it there.
  await expect(moment('12. Bg5').getByTestId('chances-before')).toHaveText('Before: White’s winning chances: 35% -1.72');
  // A Why Question about it quotes those same numbers: the fake Coach repeats its brief's.
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  await expect(paired.getByLabel('Coach conversation')).toContainText('Before it, White’s winning chances: 35%. After it, White’s winning chances: 19%.');
  await move('Move 11… Rxf7, Best').click();
  await expectShown('11… Rxf7', '35%');

  // The position after 10… dxe4: its symbol, and Black's threat with Threat on.
  await move('Move 10… dxe4, Best').click();
  await expectShown('10… dxe4', '48%');
  await expect(symbols).toHaveCount(1);
  await expect(board.getByRole('img', { name: 'Best on e4' })).toBeVisible();
  await expect(threat).toHaveCount(1);

  // Opening 11. Bxf7+ shows that same position, and everything follows it: the bar, the graph's
  // cursor and the symbol. Only the Coach's arrows are drawn, not the threat.
  await expect(moment('11. Bxf7+').getByTestId('chances-before')).toHaveText('Before: White’s winning chances: 48% -0.25');
  const show = paired.getByRole('button', { name: 'Show moment: move 11. Bxf7+, Mistake' });
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect(coachArrows.first()).toBeVisible();
  await expectShown('10… dxe4', '48%');
  await expect(symbols).toHaveCount(1);
  await expect(board.getByRole('img', { name: 'Best on e4' })).toBeVisible();
  await expect(threat).toHaveCount(0);

  // Closing it shows the position after the move again.
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  await expectShown('11. Bxf7+', '35%');
  await expect(board.getByRole('img', { name: 'Mistake on f7' })).toBeVisible();
  await expect(coachArrows).toHaveCount(0);
});

test('a Review draws the move played and the Engine’s best as arrows, and the Coach’s arrows replace them', async ({ paired, app }) => {
  // The seeded game, graded at verify mode's fixed depth: 11. Bxf7+ is a Mistake where the
  // Engine's best was axb4, and 5. d4 is the Engine's best move.
  const played = (name: string) => paired.getByRole('img', { name: `Move played: ${name}`, exact: true });
  const best = paired.getByRole('img', { name: /^Engine’s best: / });
  const coachArrows = paired.getByRole('img', { name: /^Arrow / });
  const move = (name: string) => paired.getByRole('list', { name: 'Moves' }).getByRole('button', { name, exact: true });

  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first()).toBeVisible({ timeout: 90_000 });

  // A Mistake: the move played in the Mistake's color, the Engine's best in green.
  await move('Move 11. Bxf7+, Mistake').click();
  await expect(played('Bxf7+, Mistake')).toHaveAttribute('stroke', '#8a3d00');
  await expect(paired.getByRole('img', { name: 'Engine’s best: axb4' })).toHaveAttribute('stroke', '#15781b');
  await expect(coachArrows).toHaveCount(0);

  // The Engine's best move itself: one green arrow.
  await move('Move 5. d4, Best').click();
  await expect(played('d4, Best, the Engine’s best')).toHaveAttribute('stroke', '#15781b');
  await expect(best).toHaveCount(0);
  await expect(paired.getByRole('img', { name: /^Move played: / })).toHaveCount(1);

  // Every move, not only key moments: the opponent's Inaccuracy 16… Nc6.
  await move('Move 16… Nc6, Inaccuracy').click();
  await expect(played('Nc6, Inaccuracy')).toHaveAttribute('stroke', '#7a5a00');
  await expect(paired.getByRole('img', { name: 'Engine’s best: Be6' })).toBeVisible();

  // Opening a key moment's explanation shows only the Coach's arrows; closing it brings these back.
  const show = paired.getByRole('button', { name: 'Show moment: move 11. Bxf7+, Mistake' });
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect(coachArrows.first()).toBeVisible();
  await expect(paired.getByRole('img', { name: /^Move played: / })).toHaveCount(0);
  await expect(best).toHaveCount(0);
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  await expect(coachArrows).toHaveCount(0);
  await expect(played('Bxf7+, Mistake')).toBeVisible();
  await expect(paired.getByRole('img', { name: 'Engine’s best: axb4' })).toBeVisible();

  // A saved Review shows the arrows on reopening, with no new Engine run.
  const asked: string[] = [];
  paired.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && /"(engine\.\w+|review\.start)"/.test(f.payload)) asked.push(f.payload);
    }),
  );
  await paired.reload();
  await move('Move 12. Bg5, Mistake').click();
  await expect(played('Bg5, Mistake')).toBeVisible();
  await expect(paired.getByRole('img', { name: 'Engine’s best: Ng5' })).toBeVisible();
  expect(asked).toEqual([]);
});

test('from an open key moment, Next shows its move played and Previous the move before', async ({ paired, app }) => {
  const board = paired.getByRole('group', { name: 'Review board' });
  const current = paired.getByRole('figure', { name: 'Winning Chances graph' }).getByRole('img', { name: /^Current position: / });
  const show = paired.getByRole('button', { name: 'Show moment: move 11. Bxf7+, Mistake' });
  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  await expect(show).toBeVisible({ timeout: 90_000 });

  // A finished Review opens its first moment: the position before 11. Bxf7+. Next plays the
  // move, with its Move Grade.
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect(current).toHaveAccessibleName(/^Current position: 10… dxe4: /);
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect(current).toHaveAccessibleName('Current position: 11. Bxf7+: White’s winning chances: 35%');
  await expect(board.getByRole('img', { name: 'Mistake on f7' })).toBeVisible();

  // Previous from the open moment goes one move back from the position it shows.
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(current).toHaveAccessibleName(/^Current position: 10\. a3: /);
});

test('on a phone, picking a key moment or a move brings the board into view; on a desktop it stays in view', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  const moments = paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
  await expect(moments.first()).toBeVisible({ timeout: 90_000 });
  const board = paired.getByRole('group', { name: 'Review board' });
  /** The board's top edge is on screen, in the top half of the viewport. */
  const boardOnScreen = async () => {
    const box = await board.boundingBox();
    return Boolean(box && box.y >= -1 && box.y < 844 / 2);
  };

  // The key moments and the moves sit far below the board on a phone.
  await moments.nth(2).getByRole('button').click();
  await expect(moments.nth(2).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(boardOnScreen).toBe(true);

  await paired.getByRole('list', { name: 'Moves' }).getByRole('button', { name: 'Move 16… Nc6, Inaccuracy', exact: true }).click();
  await expect(board.getByRole('img', { name: 'Inaccuracy on c6' })).toBeVisible();
  await expect.poll(boardOnScreen).toBe(true);

  // Beside them on a desktop, the whole board stays in view however far down the Player scrolls.
  await paired.setViewportSize({ width: 1280, height: 800 });
  await paired.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await moments.nth(3).getByRole('button').click();
  await expect(moments.nth(3).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  expect(await paired.evaluate(() => scrollY)).toBeGreaterThan(200);
  const box = await board.boundingBox();
  expect(box?.y).toBeGreaterThanOrEqual(-1);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(800);
});

test('a game set up from a position numbers its moves from that position', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/games`);
  await paired
    .getByLabel('PGN', { exact: true })
    .fill('[White "Alex"]\n[Black "Endgame"]\n[Date "2020.01.01"]\n[SetUp "1"]\n[FEN "8/8/8/8/8/4k3/8/R3K3 b - - 0 40"]\n\n40... Kd3 41. Ra3+ Kc4 42. Kd2 1/2-1/2');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported: Alex vs Endgame' })).toBeVisible();
  await paired.getByRole('link', { name: 'Review: Endgame, 2020-01-01' }).click();

  const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
  await expect(moves).toHaveCount(4);
  expect(await moves.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual([
    'Move 40… Kd3',
    'Move 41. Ra3+',
    'Move 41… Kc4',
    'Move 42. Kd2',
  ]);
});

test('a Review with no key moments says so in a way that fits how the game ended', async ({ paired, app }) => {
  // The Player was White, played the Engine's moves and resigned early: no Inaccuracy or worse.
  await paired.goto(`${app.url}/#/games`);
  await paired.getByLabel('PGN', { exact: true }).fill('[White "Alex"]\n[Black "Sam"]\n[Date "2021.02.03"]\n\n1. e4 e5 2. Nf3 Nc6 0-1');
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Import PGN' }).click();
  await expect(paired.getByRole('status').filter({ hasText: 'Imported: Alex vs Sam' })).toBeVisible();
  await paired.getByRole('link', { name: 'Review: Sam, 2021-02-03' }).click();
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  const region = paired.getByRole('region', { name: 'Key moments' });
  await expect(region).toBeVisible({ timeout: 90_000 });
  await expect(region.getByRole('listitem')).toHaveCount(0);
  // Resigned at move 2, in an equal position: a short game, never "decided".
  await expect(region).toContainText(
    'A short game, with no key moment to walk through: step through the moves and ask the Coach why about any of them.',
  );
  await expect(region).not.toContainText('decided');
});

test.describe('a Review being made', () => {
  // The fake Coach writes slowly, so the Review is still being made when the Player comes back.
  test.use({ appOptions: { chunkDelayMs: 150 } });

  test('keeps going while the Player looks elsewhere, and shows its progress when they come back', async ({ page: paired, app }) => {
    const starts: string[] = [];
    paired.on('websocket', (ws) =>
      ws.on('framesent', (f) => {
        if (typeof f.payload === 'string' && f.payload.includes('"review.start"')) starts.push(f.payload);
      }),
    );
    await paired.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(paired)).toHaveText(/Desktop connected/);
    await paired.goto(`${app.url}/#/review/1`);
    await paired.getByRole('button', { name: 'Start the Review' }).click();
    await expect(paired.getByRole('status').filter({ hasText: /Grading move|explaining the key moments/ })).toBeVisible();

    // Away to the game list and back, inside the app: the page is not reloaded.
    await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
    await expect(paired.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
    await paired.goBack();
    await expect(paired.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await expect(paired.getByRole('button', { name: 'Start the Review' })).toHaveCount(0);
    await expect(paired.getByRole('status').filter({ hasText: /Grading move|explaining the key moments/ })).toBeVisible();

    // It finishes on this screen with no reload and no second request, and opens its first key
    // moment as a Review finished on the spot does.
    const first = paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first();
    await expect(first).toBeVisible({ timeout: 90_000 });
    await expect(first.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(starts).toHaveLength(1);
    expect(await app.rows('reviews')).toHaveLength(1);
  });

  test('goes on through a reload: the reopened screen shows how far it has got, and it finishes there', async ({ page, app }) => {
    const starts: string[] = [];
    page.on('websocket', (ws) =>
      ws.on('framesent', (f) => {
        if (typeof f.payload === 'string' && f.payload.includes('"review.start"')) starts.push(f.payload);
      }),
    );
    const engine = engineGate(app);
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/review/1`);
    await page.getByRole('button', { name: 'Start the Review' }).click();
    const grading = page.getByRole('status').filter({ hasText: /Grading move [1-9]\d* of 48…/ });
    await expect(grading).toBeVisible();

    // The Engine waits while the page reloads, so the Review is still being graded when it reopens.
    engine.hold();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await expect(grading).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start the Review' })).toHaveCount(0);
    engine.release();

    // The same Review finishes on the reopened screen: the desktop made one, and the screen's one
    // request joined it.
    const first = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first();
    await expect(first).toBeVisible({ timeout: 90_000 });
    await expect(first.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(starts).toHaveLength(2);
    expect(await app.rows('reviews')).toHaveLength(1);
    expect(await app.rows<{ job: string }>('coach_calls').then((r) => r.filter((c) => c.job === 'review-moment'))).toHaveLength(4);
    // The overview was written once too, by the Review the reload joined.
    expect(await app.rows<{ job: string }>('coach_calls').then((r) => r.filter((c) => c.job === 'review-overview'))).toHaveLength(1);
  });
});

test('a double click on "Start the Review" starts one Review and shows no error', async ({ page, app }) => {
  const starts: string[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"review.start"')) starts.push(f.payload);
    }),
  );
  await page.goto(`${app.url}/#pair=${app.code}`);
  await expect(connection(page)).toHaveText(/Desktop connected/);
  await page.goto(`${app.url}/#/games`);
  await page.getByRole('link', { name: /^Review: ikatsca/ }).click();
  // Both clicks land before the screen updates, as on a slow device or with a fast double click.
  await page.getByRole('button', { name: 'Start the Review' }).evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  const moments = page.getByRole('region', { name: 'Key moments' }).getByRole('listitem');
  await expect(moments.first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start the Review' })).toHaveCount(0);
  expect(starts).toHaveLength(1);
  expect(await app.rows('reviews')).toHaveLength(1);
});

test.describe('a Player with more games than one page', () => {
  test.use({ seed: 'many-games' });

  test('the game list shows a page of games, newest first, and Show more appends the next page', async ({ paired, app }) => {
    expect(await app.rows('games')).toHaveLength(61);
    const keptOnDevice = async () => ((await storedOnDevice(paired, 'games')) as { games?: unknown[] } | null)?.games?.length;
    await paired.goto(`${app.url}/#/games`);
    const table = paired.getByRole('table', { name: 'Game list' });
    // A header row and the first page of 50 games, newest first.
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect(paired.getByText('Showing 50 of 61 games.')).toBeVisible();
    await expect(table.getByRole('row').nth(1).getByRole('cell').first()).toHaveText('2014-03-01');
    await expect(table.getByRole('link', { name: /^Review: ikatsca/ })).toHaveCount(0);
    // This device keeps only the games the Player has been shown.
    await expect.poll(keptOnDevice).toBe(50);

    await paired.getByRole('button', { name: 'Show more' }).click();
    await expect(table.getByRole('row')).toHaveCount(62);
    await expect(paired.getByText('Showing all 61 games.')).toBeVisible();
    // The seed's Italian Game of 2013 is the oldest, so it comes last.
    await expect(table.getByRole('row').last().getByRole('link', { name: 'Review: ikatsca, 2013-01-05' })).toBeVisible();
    await expect(paired.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    await expect.poll(keptOnDevice).toBe(61);

    // A new game joins the top of the list, and every game shown stays shown.
    await paired.getByLabel('PGN', { exact: true }).fill('[White "bijean"]\n[Black "latecomer"]\n[Date "2015.06.01"]\n\n1. e4 e5 2. Nf3 Nc6 1-0');
    await paired.getByRole('button', { name: 'Import PGN' }).click();
    await paired.getByRole('radio', { name: 'White' }).check();
    await paired.getByRole('button', { name: 'Import PGN' }).click();
    await expect(paired.getByRole('status').filter({ hasText: 'Imported: bijean vs latecomer' })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(63);
    await expect(table.getByRole('row').nth(1)).toContainText('latecomer');
    await expect(paired.getByText('Showing all 62 games.')).toBeVisible();
  });

  test('the game list fits a phone, with no sideways scrolling, a confirmation open or not', async ({ paired, app }) => {
    // The newest game, reviewed, so its confirmation has the longest text.
    const newest = (await app.rows<{ id: number; played_at: string }>('games')).sort((a, b) => b.played_at.localeCompare(a.played_at))[0];
    const c = await CoachClient.connect(app.url, app.token);
    try {
      await c.request('review.start', { gameId: Number(newest?.id) });
    } finally {
      await c.close();
    }
    const pageWidth = () => paired.evaluate(() => document.documentElement.scrollWidth);
    const table = paired.getByRole('table', { name: 'Game list' });
    for (const width of [390, 320]) {
      await paired.setViewportSize({ width, height: 844 });
      await paired.goto(`${app.url}/#/games`);
      await expect(table.getByRole('row')).toHaveCount(51);
      expect(await pageWidth()).toBeLessThanOrEqual(width);
      const row = table.getByRole('row').nth(1);
      await expect(row.getByRole('link', { name: /^Open Review/ })).toBeVisible();
      for (const choice of ['Delete game', 'I played White', 'I played Black']) {
        const more = row.getByRole('button', { name: /^More: / });
        await more.click();
        const button = row.getByRole('button', { name: choice });
        if (!(await button.count())) {
          await more.click();
          continue;
        }
        await button.click();
        await expect(paired.getByRole('alertdialog')).toBeVisible();
        expect(await pageWidth()).toBeLessThanOrEqual(width);
        await paired.keyboard.press('Escape');
        await expect(paired.getByRole('alertdialog')).toHaveCount(0);
      }
    }
  });

  test('back from a Review, the game list shows the same games, scrolled where it was', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/games`);
    const table = paired.getByRole('table', { name: 'Game list' });
    await paired.getByRole('button', { name: 'Show more' }).click();
    await expect(table.getByRole('row')).toHaveCount(62);
    const last = table.getByRole('link', { name: 'Review: ikatsca, 2013-01-05' });
    await last.scrollIntoViewIfNeeded();
    const scrolled = await paired.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    await last.click();
    await expect(paired.getByRole('heading', { name: 'Review' })).toBeVisible();
    await paired.goBack();
    await expect(table.getByRole('row')).toHaveCount(62);
    await expect.poll(() => paired.evaluate(() => window.scrollY)).toBe(scrolled);
  });

  test('left another way than Back, a Review doesn’t take Import more to the old place in the list', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/games`);
    const table = paired.getByRole('table', { name: 'Game list' });
    await paired.getByRole('button', { name: 'Show more' }).click();
    const last = table.getByRole('link', { name: 'Review: ikatsca, 2013-01-05' });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(paired.getByRole('heading', { name: 'Review' })).toBeVisible();
    await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
    await paired.getByRole('link', { name: 'Import more' }).click();
    await expect(table.getByRole('row')).toHaveCount(62);
    const username = paired.getByRole('textbox', { name: 'Username' });
    await expect(username).toBeFocused();
    await expect(username).toBeInViewport();
  });
});
