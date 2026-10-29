// Feature map: Puzzles. Solve one, fail another and retry it, and read the attempts back.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { legalMoves, moveLabel, outcomeOf, piecesOf, playLine, playUci, turnOf, type PlayedMove } from '../../packages/shared/src/chess.ts';
import type { CatalogueItem } from '../../packages/shared/src/content/course.ts';
import { TRACKS } from '../../packages/shared/src/content/lessons.ts';
import type { PuzzleFile } from '../../packages/shared/src/content/puzzles.ts';
import { coachIdle, expect, fenOf, play, storedOnDevice, test } from '../fixtures/app.ts';

const load = (file: string) => (JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8')) as PuzzleFile).puzzles;
const puzzles = [...load('puzzles.json'), ...load('theme-puzzles.json')];
const lessons = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as CatalogueItem[];
/** The first Lesson offered after Mixed: the sets come by track, in the Lessons' order. */
const firstSet = TRACKS.flatMap((t) => lessons.filter((l) => l.track === t)).find((l) => puzzles.some((p) => p.lessonId === l.id))!;
const BOARD = 'Puzzle board';

async function current(page: Page, previous?: string) {
  // Exact: the region `No more Puzzles` also has "Puzzle" in its name, and shows until the next Puzzle replaces it.
  const region = page.getByRole('region', { name: 'Puzzle', exact: true });
  // Wait for a Puzzle (a new one, after `previous`) before reading its id.
  await expect(region).toHaveAttribute('data-puzzle-id', /.+/);
  if (previous) await expect(region).not.toHaveAttribute('data-puzzle-id', previous);
  const id = await region.getAttribute('data-puzzle-id');
  const puzzle = puzzles.find((p) => p.id === id);
  if (!puzzle) throw new Error(`Puzzle ${id} is not in the data file`);
  // The opponent's set-up move is played for the Player.
  await expect(page.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', (playUci(puzzle.fen, puzzle.moves[0] as string))?.fenAfter ?? '');
  return puzzle;
}

test('solve one Puzzle, then fail a second and retry it', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  await expect(paired.getByRole('heading', { name: 'Italian Game Puzzles' })).toBeVisible();

  const first = await current(paired);
  const region = paired.getByRole('region', { name: 'Puzzle' });
  await expect(region).toContainText(/Find the best move for (White|Black)\./);
  // No Winning Chances bar in a Puzzle: it would give the answer away.
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveCount(0);
  await solveStepwise(paired, first.moves);
  await expect(paired.getByText('Solved first time!')).toBeVisible();
  // A solved Puzzle no longer asks for the move.
  await expect(region).not.toContainText('Find the best move');
  await expect(region).toContainText(/You found the best move for (White|Black)\./);
  // Why is it the answer? The Coach is told no Winning Chances, as the Puzzle shows none.
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const [why] = await app.rows<{ job: string; brief: string }>('coach_calls');
  expect(why?.job).toBe('why');
  expect(JSON.parse(why?.brief ?? '{}')).not.toHaveProperty('winningChances');

  await paired.getByRole('button', { name: 'Next Puzzle' }).click();
  const second = await current(paired, first.id);
  expect(second.id).not.toBe(first.id);
  const fen = await fenOf(paired, BOARD);
  const wrong = legalMoves(fen).find((m) => m !== second.moves[1] && !(second.moves.length === 2 && outcomeOf(playUci(fen, m)?.fenAfter ?? fen)?.reason === 'checkmate'));
  await play(paired, wrong as string, BOARD);
  await expect(paired.getByText(/is not the move\. Try again\./)).toBeVisible();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', fen);
  await solveStepwise(paired, second.moves);
  await expect(paired.getByText('Solved after 1 wrong try.')).toBeVisible();

  // The result shows before the desktop has saved it, so wait for the row.
  const attempts = () =>
    app
      .rows<{ puzzle_id: string; opening: string; solved: number; mistakes: number }>('puzzle_attempts')
      .then((rows) => rows.map(({ puzzle_id, opening, solved, mistakes }) => ({ puzzle_id, opening, solved, mistakes })));
  await expect.poll(attempts).toEqual([
    { puzzle_id: first.id, opening: 'italian-game', solved: 1, mistakes: 0 },
    { puzzle_id: second.id, opening: 'italian-game', solved: 0, mistakes: 1 },
  ]);

  // A shown solution says so instead of still asking for the move.
  await paired.getByRole('button', { name: 'Next Puzzle' }).click();
  await current(paired, second.id);
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
  await expect(region).not.toContainText('Find the best move');
  await expect(region).toContainText(/The solution for (White|Black) is on the board\./);
});

test('a Theme Lesson has its own Puzzles', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/forks`);
  await expect(paired.getByRole('heading', { name: 'Forks Puzzles' })).toBeVisible();
  const puzzle = await current(paired);
  expect(puzzle.lessonId).toBe('forks');
  expect(puzzle.themes).toContain('fork');
  await solveStepwise(paired, puzzle.moves);
  await expect(paired.getByText('Solved first time!')).toBeVisible();
  await expect
    .poll(async () => (await app.rows<{ puzzle_id: string; opening: string }>('puzzle_attempts')).map((r) => [r.puzzle_id, r.opening]))
    .toEqual([[puzzle.id, 'forks']]);
});

test('a shown Puzzle writes out its solution, and the Player can step through it', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const puzzle = await current(paired);
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
  const line = playLine(puzzle.fen, puzzle.moves);
  const region = paired.getByRole('region', { name: 'Puzzle' });
  // Numbered as on a scoresheet, from the Puzzle's own move number, one move per button.
  await expect(region).toContainText(`Solution: ${scoresheet(line.slice(1))}`, { useInnerText: true });
  const boardEl = paired.getByRole('group', { name: BOARD });
  await expect(boardEl).toHaveAttribute('data-fen', line.at(-1)!.fenAfter);
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(boardEl).toHaveAttribute('data-fen', line.at(-1)!.fenBefore);
  // The first position is the Puzzle as it was set, after the opponent's move.
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(boardEl).toHaveAttribute('data-fen', line[0]!.fenAfter);
  await region.getByRole('button', { name: moveLabel(line[1]!.fenBefore, line[1]!.san) }).click();
  await expect(boardEl).toHaveAttribute('data-fen', line[1]!.fenAfter);
});

test('a Why Question after a Puzzle shows the position it explains, with its arrows', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const puzzle = await current(paired);
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const explained = playUci(puzzle.fen, puzzle.moves[0] as string)?.fenAfter ?? '';
  const boardEl = paired.getByRole('group', { name: BOARD });
  await expect(boardEl).toHaveAttribute('data-fen', explained);
  // Every arrow starts on a piece of the position shown.
  const arrows = boardEl.getByRole('img', { name: /^Arrow / });
  await expect(arrows.first()).toBeVisible();
  const occupied = new Set(piecesOf(explained).map((p) => p.square));
  const starts = await arrows.evaluateAll((els) => els.map((e) => /^Arrow (\w\d)/.exec(e.getAttribute('aria-label') ?? '')?.[1] ?? ''));
  for (const from of starts) expect(occupied.has(from)).toBe(true);
});

test('when a Lesson’s Puzzles run out, the missed ones can be tried again', async ({ paired, app }) => {
  const lessonId = 'two-knights-defence';
  const count = puzzles.filter((p) => p.lessonId === lessonId).length;
  await paired.goto(`${app.url}/#/puzzles/${lessonId}`);
  const missed: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await current(paired, missed.at(-1));
    missed.push(p.id);
    await paired.getByRole('button', { name: 'Show the solution' }).click();
    await expect(paired.getByText('Here is the solution.')).toBeVisible();
    await paired.getByRole('button', { name: 'Next Puzzle' }).click();
  }
  const done = paired.getByRole('region', { name: 'No more Puzzles' });
  await expect(done).toContainText('You have done every Two Knights Defence Puzzle on this device.');
  await expect(done.getByRole('link', { name: 'Puzzles from every Lesson' })).toHaveAttribute('href', '#/puzzles');
  await done.getByRole('button', { name: `Try the ${count} you missed again` }).click();
  const again = await current(paired);
  expect(missed).toContain(again.id);
  // Tried again, they are no longer done, so not counted as missed either: the progress line and the choice agree.
  await expect(paired.getByText(`Two Knights Defence: 0 of ${count} done.`)).toBeVisible();
  const { choice, sets } = picker(paired);
  await choice.click();
  await expect(sets.locator('[aria-current="page"]')).toHaveText(`Two Knights Defence ${count} Puzzles`);
  await choice.click();

  // Solved on its second go, it still counts as missed first time, and as one Puzzle.
  await solveStepwise(paired, again.moves);
  await expect(paired.getByText('Solved first time!')).toBeVisible();
  // On this device it is done and no longer missed.
  await expect(paired.getByText(`Two Knights Defence: 1 of ${count} done.`)).toBeVisible();
  // Off the missed list on this device, so the desktop has been told.
  await expect.poll(() => storedOnDevice(paired, 'puzzlesMissed')).not.toContain(again.id);
  await paired.goto(`${app.url}/#/profile`);
  await expect(paired.getByRole('region', { name: 'Lesson progress' })).toContainText(`Puzzles: 0 solved first time out of ${count}.`);
  expect(await app.rows('puzzle_attempts')).toHaveLength(count);
});

test('the Player chooses what to practise: every Lesson mixed, or one Theme, opening or endgame', async ({ paired, app }) => {
  const count = (lessonId: string) => puzzles.filter((p) => p.lessonId === lessonId).length;
  await paired.goto(`${app.url}/#/puzzles`);
  const { choice, sets } = picker(paired);
  // Closed, so the Puzzle comes first; the progress line says how far the Player got.
  await expect(paired.getByText(`Every Lesson: 0 of ${puzzles.length} done.`)).toBeVisible();
  await expect(sets).toBeHidden();
  await choice.click();
  // Mixed is the default: every Lesson's Puzzles, near the Player's level.
  await expect(sets.locator('[aria-current="page"]')).toHaveText(`Mixed: every Lesson ${puzzles.length} Puzzles`);
  // Each Theme, opening and endgame with Puzzles is offered, with how many it has; a Lesson without Puzzles isn't.
  await expect(sets.getByRole('list', { name: 'Themes' }).getByRole('link', { name: /^Pins/ })).toHaveText(`Pins ${count('pins')} Puzzles`);
  await expect(sets.getByRole('list', { name: 'Openings' }).getByRole('link', { name: /^Italian Game/ })).toHaveText(`Italian Game ${count('italian-game')} Puzzles`);
  await expect(sets.getByRole('list', { name: 'Endgames' }).getByRole('link', { name: /^Rook endgames/ })).toHaveCount(1);
  await expect(sets.getByRole('link', { name: /Mate with king and queen/ })).toHaveCount(0);

  // Choosing Pins serves only Pins Puzzles; the choice closes and keeps focus.
  await sets.getByRole('link', { name: /^Pins/ }).click();
  await expect(paired).toHaveURL(/#\/puzzles\/pins$/);
  await expect(paired.getByRole('heading', { name: 'Pins Puzzles' })).toBeVisible();
  const puzzle = await current(paired);
  expect(puzzle.lessonId).toBe('pins');
  await expect(choice).toBeFocused();
  await expect(sets).toBeHidden();

  // Progress follows the Player: one solved, one shown.
  await solveStepwise(paired, puzzle.moves);
  await expect(paired.getByText('Solved first time!')).toBeVisible();
  await expect(paired.getByText(`Pins: 1 of ${count('pins')} done.`)).toBeVisible();
  await paired.getByRole('button', { name: 'Next Puzzle' }).click();
  const second = await current(paired, puzzle.id);
  expect(second.lessonId).toBe('pins');
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText(`Pins: 2 of ${count('pins')} done (1 missed).`)).toBeVisible();
  await choice.click();
  await expect(sets.locator('[aria-current="page"]')).toHaveText(`Pins ${count('pins')} Puzzles · 2 done (1 missed)`);

  // And back to the mix.
  await sets.getByRole('link', { name: /^Mixed/ }).click();
  await expect(paired).toHaveURL(/#\/puzzles$/);
  await expect(paired.getByRole('heading', { name: 'Puzzles', exact: true })).toBeVisible();
  await current(paired);
  await expect(paired.getByText(`Every Lesson: 2 of ${puzzles.length} done (1 missed).`)).toBeVisible();

  // On a phone every set's name and progress wraps inside the screen, and the page never scrolls sideways.
  await paired.setViewportSize({ width: 390, height: 844 });
  await choice.click();
  await expect(sets).toBeVisible();
  await expect.poll(() => paired.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cut = await sets.getByRole('link').evaluateAll((links) =>
    links.filter((a) => a.getBoundingClientRect().right > innerWidth || a.scrollWidth > a.clientWidth).map((a) => a.textContent),
  );
  expect(cut).toEqual([]);
});

test('arrow keys never change the set; following one gives focus back to the choice', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles`);
  const { choice, sets } = picker(paired);
  const first = await current(paired);
  // Open the choice from the keyboard and arrow down from a set: that only scrolls.
  await choice.focus();
  await paired.keyboard.press('ArrowDown');
  await paired.keyboard.press('Enter');
  await expect(sets).toBeVisible();
  await paired.keyboard.press('Tab');
  await expect(sets.getByRole('link', { name: /^Mixed/ })).toBeFocused();
  await paired.keyboard.press('Tab');
  const set = sets.getByRole('link', { name: new RegExp(`^${firstSet.name}`) });
  await expect(set).toBeFocused();
  await paired.keyboard.press('ArrowDown');
  // Nothing to wait for if it holds: give a wrong change of set the time to happen.
  await paired.waitForTimeout(500);
  await expect(paired).toHaveURL(/#\/puzzles$/);
  await expect(paired.getByRole('region', { name: 'Puzzle', exact: true })).toHaveAttribute('data-puzzle-id', first.id);
  await expect(set).toBeFocused();

  // Enter follows the set; its screen gives focus back to the choice, so the next key works.
  await paired.keyboard.press('Enter');
  await expect(paired).toHaveURL(new RegExp(`#/puzzles/${firstSet.id}$`));
  await expect(paired.getByRole('heading', { name: `${firstSet.name} Puzzles` })).toBeVisible();
  expect((await current(paired)).lessonId).toBe(firstSet.id);
  await expect(choice).toBeFocused();
  await paired.keyboard.press('Enter');
  await paired.keyboard.press('Tab');
  await expect(sets.getByRole('link', { name: /^Mixed/ })).toBeFocused();
  await paired.keyboard.press('Enter');
  await expect(paired).toHaveURL(/#\/puzzles$/);
  await expect(paired.getByRole('heading', { name: 'Puzzles', exact: true })).toBeVisible();
  await expect(choice).toBeFocused();
});

test('the Mixed choice counts only the Puzzles in the data', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles`);
  await current(paired);
  // Ids this device kept from an older Puzzle file, which no longer has them.
  await paired.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('ai-chess-coach', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(['retired-1', 'retired-2'], 'puzzlesDone');
          tx.objectStore('kv').put(['retired-2'], 'puzzlesMissed');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await paired.reload();
  await current(paired);
  await expect(paired.getByText(`Every Lesson: 0 of ${puzzles.length} done.`)).toBeVisible();
  const { choice, sets } = picker(paired);
  await choice.click();
  await expect(sets.getByRole('link', { name: /^Mixed/ })).toHaveText(`Mixed: every Lesson ${puzzles.length} Puzzles`);
});

test('a link to a Lesson without Puzzles, or to none, serves every Lesson’s Puzzles and says so', async ({ paired, app }) => {
  for (const [link, name] of [
    ['queen-mate', 'Mate with king and queen'],
    ['no-such-lesson', 'that link'],
  ]) {
    await paired.goto(`${app.url}/#/puzzles/${link}`);
    await expect(paired.getByRole('note')).toHaveText(`There are no Puzzles for ${name}, so these are from every Lesson.`);
    await expect(paired.getByRole('heading', { name: 'Puzzles', exact: true })).toBeVisible();
    await expect(paired).toHaveTitle('Puzzles · OpenChessCoach');
    await current(paired);
    await expect(paired.getByText(`Every Lesson: 0 of ${puzzles.length} done.`)).toBeVisible();
    const { choice, sets } = picker(paired);
    await choice.click();
    await expect(sets.locator('[aria-current="page"]')).toHaveText(`Mixed: every Lesson ${puzzles.length} Puzzles`);
  }
});

/** The choice of what to practise: a disclosure holding a link per set. */
function picker(page: Page) {
  return { choice: page.getByText('Choose what to practise', { exact: true }), sets: page.getByRole('navigation', { name: 'Puzzles to practise' }) };
}

/** A line as a scoresheet writes it: "13… Bxb2+ 14. Kxb2 Rxd1". */
function scoresheet(moves: PlayedMove[]): string {
  return moves.map((m, i) => (i === 0 || turnOf(m.fenBefore) === 'white' ? moveLabel(m.fenBefore, m.san) : m.san)).join(' ');
}

/** Plays the Player's moves, waiting for each opponent reply by watching the position change. */
async function solveStepwise(page: Page, moves: string[]): Promise<void> {
  for (let i = 1; i < moves.length; i += 2) {
    const before = await fenOf(page, BOARD);
    const mine = playUci(before, moves[i] as string);
    if (!mine) throw new Error(`Puzzle move ${moves[i]} is not legal in ${before}`);
    await play(page, moves[i] as string, BOARD);
    const reply = moves[i + 1];
    const expected = reply ? playUci(mine.fenAfter, reply)?.fenAfter : mine.fenAfter;
    await expect(page.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', expected ?? '');
  }
}

