// Feature map: Puzzles. Solve one, fail another and retry it, and read the attempts back. A Hint
// before Show the solution, the Ask box naming the move, and the phone's one row above the board.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { legalMoves, moveLabel, outcomeOf, piecesOf, playLine, playUci, turnOf, type PlayedMove } from '../../packages/shared/src/chess.ts';
import type { Brief } from '../../packages/shared/src/coach/brief.ts';
import { HINT_FALLBACK, namedMove } from '../../packages/shared/src/coach/guard.ts';
import type { CatalogueItem } from '../../packages/shared/src/content/course.ts';
import { decisions, TRACKS, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import type { PuzzleFile } from '../../packages/shared/src/content/puzzles.ts';
import { coachIdle, expect, fenOf, play, storedOnDevice, test } from '../fixtures/app.ts';

const load = (file: string) => (JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8')) as PuzzleFile).puzzles;
const puzzles = [...load('puzzles.json'), ...load('theme-puzzles.json')];
const lessons = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as CatalogueItem[];
const readLesson = (id: string) => JSON.parse(readFileSync(new URL(`../../data/lessons/${id}.json`, import.meta.url), 'utf8')) as LessonData;
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
  await showSolution(paired);
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

test('on an iPhone, Next Puzzle shows under the board once the solution is shown', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  for (const [width, height] of [[402, 714], [440, 790]] as const) {
    await paired.setViewportSize({ width, height });
    await showSolution(paired);
    await expect(paired.getByText('Here is the solution.')).toBeAttached();
    const next = paired.getByRole('button', { name: 'Next Puzzle' });
    await expect(next).toBeInViewport({ ratio: 1 });
    expect(await paired.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])).toEqual([width, height]);
    await next.click();
  }
});

test('a shown Puzzle writes out its solution, and the Player can step through it', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const puzzle = await current(paired);
  await showSolution(paired);
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
  await showSolution(paired);
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
    await showSolution(paired);
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
  await showSolution(paired);
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

test('a Puzzle offers a Hint before Show the solution, from the Engine’s line, naming no move', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const puzzle = await current(paired);
  const line = playLine(puzzle.fen, puzzle.moves);
  const set = line[0]!.fenAfter;
  const answer = line[1]!;
  const boardEl = paired.getByRole('group', { name: BOARD });
  const ask = paired.getByLabel('Your Why Question');
  // A Hint first: Show the solution comes only after it, and no Ask box while the answer is still to find.
  const hint = paired.getByRole('button', { name: 'Hint', exact: true });
  await expect(hint).toBeVisible();
  await expect(paired.getByRole('button', { name: 'Show the solution' })).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await hint.click();
  await coachIdle(paired);
  const said = paired.getByLabel('Coach conversation');
  await expect(said).toContainText('Hint, please.');
  // The Hint names and draws no move: not the answer's, nor any other.
  const text = (await said.innerText()).replace('Hint, please.', '');
  for (const m of legalMoves(set)) expect(text).not.toContain(playUci(set, m)!.san);
  await expect(boardEl.getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  // The desktop's brief: a Hint about the Puzzle as set, from the Engine's line, whose best move is the solution's.
  const calls = await app.rows<{ job: string; brief: string; raw_reply: string }>('coach_calls');
  expect(calls.map((c) => c.job)).toEqual(['hint']);
  const brief = JSON.parse(calls[0]!.brief) as Brief;
  expect(brief).toMatchObject({ job: 'hint', fen: set, hideMoves: true, playerSide: turnOf(set) });
  expect(brief).not.toHaveProperty('winningChances');
  expect(brief.candidates[0]?.uci).toBe(answer.uci);
  expect(JSON.parse(calls[0]!.raw_reply)).toMatchObject({ moves: [], arrows: [] });
  await expect(ask).toHaveCount(0);

  // The same button now shows the solution.
  const show = paired.getByRole('button', { name: 'Show the solution' });
  await expect(show).toBeFocused();
  await show.click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
  await expect.poll(async () => (await app.rows<{ solved: number }>('puzzle_attempts')).map((r) => r.solved)).toEqual([0]);

  // The Ask box names the move a Why Question asks about: the solution's first move.
  await expect(ask).toHaveAttribute('placeholder', `Ask why about ${moveLabel(answer.fenBefore, answer.san)}`);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const why = (await app.rows<{ job: string; brief: string }>('coach_calls')).find((c) => c.job === 'why');
  expect((JSON.parse(why!.brief) as Brief).move?.uci).toBe(answer.uci);
  // In the Player's own variation, the move on the board.
  await paired.getByRole('button', { name: 'First position' }).click();
  const other = legalMoves(set).find((m) => m !== answer.uci)!;
  await play(paired, other, BOARD);
  const tried = playUci(set, other)!;
  await expect(ask).toHaveAttribute('placeholder', `Ask why about ${moveLabel(tried.fenBefore, tried.san)}`);
});

test('a Puzzle of several moves offers a Hint again for each move to find', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  let puzzle = await current(paired);
  // The first Italian Game Puzzle with more than one move to find.
  while (puzzle.moves.length < 4) {
    await showSolution(paired);
    await paired.getByRole('button', { name: 'Next Puzzle' }).click();
    puzzle = await current(paired, puzzle.id);
  }
  await paired.getByRole('button', { name: 'Hint', exact: true }).click();
  await expect(paired.getByRole('button', { name: 'Show the solution' })).toBeEnabled();
  await solveStepwise(paired, puzzle.moves.slice(0, 3));
  await expect(paired.getByRole('button', { name: 'Hint', exact: true })).toBeEnabled();
  await expect(paired.getByRole('button', { name: 'Show the solution' })).toHaveCount(0);
});

test('on a phone the progress line shares the choice’s row, so the board starts right under it', async ({ paired, app }) => {
  const board = paired.getByRole('group', { name: BOARD });
  const { choice } = picker(paired);
  const progress = paired.locator('#puzzle-progress');
  // Every Lesson's Puzzles, the default, the Lesson with the longest name, and the Italian Game once a
  // Puzzle is missed ("Italian Game: 1 of 28 done (1 missed).", which took a row of its own on main).
  for (const route of ['#/puzzles', '#/puzzles/rook-endgames', '#/puzzles/italian-game']) {
    await paired.goto(`${app.url}/${route}`);
    const first = await current(paired);
    if (route.endsWith('italian-game')) {
      await showSolution(paired);
      await paired.getByRole('button', { name: 'Next Puzzle' }).click();
      await current(paired, first.id);
      await expect(progress).toHaveText(/1 of \d+ done \(1 missed\)\./);
    }
    for (const [width, height] of [[402, 714], [440, 790], [390, 844], [390, 664]] as const) {
      await paired.setViewportSize({ width, height });
      await expect(progress).toBeVisible();
      const [c, p, b] = [await choice.boundingBox(), await progress.boundingBox(), await board.boundingBox()];
      // One row: the progress line's middle is inside the choice's box, and the board starts under that row.
      expect(p!.y + p!.height / 2, `${route} at ${width}×${height}`).toBeGreaterThan(c!.y);
      expect(p!.y + p!.height / 2, `${route} at ${width}×${height}`).toBeLessThan(c!.y + c!.height);
      expect(b!.y - (c!.y + c!.height), `${route} at ${width}×${height}`).toBeLessThan(12);
      // The count shows whole, and the page never scrolls sideways.
      await expect(progress).toHaveText(/\d+ of \d+ done/);
      expect(await progress.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      // The set's name, which the progress line leaves out, shows whole in the heading, within the header line's row.
      const heading = paired.getByRole('heading', { level: 1 });
      expect(await heading.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), `${route} at ${width}×${height}`).toBe(true);
      expect((await paired.locator('header.frame-head').boundingBox())!.height).toBeLessThanOrEqual(44);
    }
  }
});

test('a Hint whose words name the solution reaches the Player as a general Hint, and no word of it streams first', async ({ paired, app }) => {
  // Every frame the desktop sends, from a fresh connection.
  const received: string[] = [];
  paired.on('websocket', (ws) => ws.on('framereceived', (f) => received.push(String(f.payload))));
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  await paired.reload();
  const puzzle = await current(paired);
  const [, answer] = playLine(puzzle.fen, puzzle.moves);
  const said = `Play ${answer!.san} now, it wins.`;
  await app.script({ kind: 'reply', reply: { text: said, moves: [answer!.uci], arrows: [{ uci: answer!.uci, brush: 'green' }], highlights: [answer!.uci.slice(2, 4)] } });
  await paired.getByRole('button', { name: 'Hint', exact: true }).click();
  await coachIdle(paired);
  const conversation = paired.getByLabel('Coach conversation');
  await expect(conversation).toContainText(HINT_FALLBACK);
  await expect(conversation).not.toContainText(answer!.san);
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  expect(received.filter((f) => f.includes(answer!.san) || f.includes(answer!.uci))).toEqual([]);
  // The log keeps what the Coach said, and why it was kept back.
  const [call] = await app.rows<{ job: string; raw_reply: string; stripped: string }>('coach_calls');
  expect(JSON.parse(call!.raw_reply).text).toBe(said);
  expect(JSON.parse(call!.stripped)).toContain(`text names ${answer!.san}, which a Hint keeps back`);
});

test('a Hint that says the solution in words, or with a figurine, reaches the Player as a general Hint', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  let puzzle = await current(paired);
  const pieces: Record<string, [string, string]> = { K: ['king', '♔'], Q: ['queen', '♕'], R: ['rook', '♖'], B: ['bishop', '♗'], N: ['knight', '♘'] };
  for (const style of ['words', 'figurine'] as const) {
    const [, answer] = playLine(puzzle.fen, puzzle.moves);
    const [word, figurine] = pieces[answer!.san[0] ?? ''] ?? ['pawn', ''];
    const to = answer!.uci.slice(2, 4);
    const said = style === 'words' ? `The ${word} belongs on ${to}, so look there.` : `Try ${figurine}${answer!.san.slice(word === 'pawn' ? 0 : 1)} now.`;
    await app.script({ kind: 'reply', reply: { text: said, moves: [], arrows: [], highlights: [] } });
    await paired.getByRole('button', { name: 'Hint', exact: true }).click();
    await coachIdle(paired);
    const conversation = paired.getByLabel('Coach conversation');
    await expect(conversation, said).toContainText(HINT_FALLBACK);
    await expect(conversation).not.toContainText(said);
    await paired.getByRole('button', { name: 'Show the solution' }).click();
    await paired.getByRole('button', { name: 'Next Puzzle' }).click();
    puzzle = await current(paired, puzzle.id);
  }
});

test('a Hint without the Coach says why, names no move, and Show the solution still works', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/puzzles/italian-game`);
  const puzzle = await current(paired);
  const set = playUci(puzzle.fen, puzzle.moves[0] as string)!.fenAfter;
  await fetch(`${app.url}/__verify/coach/status`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ unavailable: 'The Coach is off for this test.' }) });
  await paired.getByRole('button', { name: 'Hint', exact: true }).click();
  const coach = paired.getByRole('region', { name: 'Coach' });
  const message = 'Hints need the Coach, which is unavailable. Press Show the solution to see the moves.';
  await expect(coach).toContainText(message);
  // Every legal move counts here, a pawn's move to a bare square too.
  expect(namedMove(await coach.innerText(), set, new Set(legalMoves(set)))).toBeUndefined();
  expect(await app.rows('coach_calls')).toEqual([]);
  await paired.getByRole('button', { name: 'Show the solution' }).click();
  await expect(paired.getByText('Here is the solution.')).toBeVisible();
});

test.describe('while the Coach gives a Hint', () => {
  // Slow enough to try a move while the Hint is on its way.
  test.use({ appOptions: { chunkDelayMs: 300 } });

  test('the board takes no move and says why; once the Hint is in, it does', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/puzzles/italian-game`);
    const puzzle = await current(paired);
    const set = playUci(puzzle.fen, puzzle.moves[0] as string)!.fenAfter;
    const board = paired.getByRole('group', { name: BOARD });
    await paired.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(paired.getByRole('region', { name: 'Coach' }).getByText('Answering…')).toBeAttached();
    await play(paired, puzzle.moves[1] as string, BOARD);
    await expect(board.locator('..').getByRole('status')).toHaveText('One moment: the Coach is giving a Hint.');
    await expect(board).toHaveAttribute('data-fen', set);
    await coachIdle(paired);
    await expect(paired.getByRole('region', { name: 'Coach' }).getByText('Coach ready')).toBeAttached();
    await solveStepwise(paired, puzzle.moves);
    await expect(paired.getByText('Solved first time!')).toBeVisible();
  });
});

test('another mate on the last move: the Ask box and the Why Question both take the move on the board', async ({ paired, app }) => {
  // Puzzle zwIo0 (Discovered check): 30. fxe8=Q# is the solution, and fxe8=R# mates too.
  await onlyPuzzle(paired, app.url, 'zwIo0');
  const puzzle = await current(paired);
  const set = playUci(puzzle.fen, puzzle.moves[0] as string)!.fenAfter;
  await play(paired, 'f7e8r', BOARD);
  await expect(paired.getByText('Solved first time!')).toBeVisible();
  const mine = playUci(set, 'f7e8r')!;
  expect(mine.san).toBe('fxe8=R#');
  const ask = paired.getByLabel('Your Why Question');
  await expect(ask).toHaveAttribute('placeholder', `Ask why about ${moveLabel(set, mine.san)}`);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const why = (await app.rows<{ job: string; brief: string }>('coach_calls')).find((c) => c.job === 'why');
  expect((JSON.parse(why!.brief) as Brief).move?.uci).toBe('f7e8r');
});

test('on a phone the Ask box fits the longest move it can name, in Puzzles and in Lessons', async ({ paired, app }) => {
  const short = (fenBefore: string, san: string) => `Why ${moveLabel(fenBefore, san)}?`;
  const puzzleLabels = puzzles.map((p) => playLine(p.fen, p.moves)[1]!).map((m) => short(m.fenBefore, m.san));
  const lessonLabels = lessons.flatMap((l) => decisions(readLesson(l.id)).map((d) => short(d.node.fen, d.node.mainSan)));
  const longest = (labels: string[]) => [...labels].sort((a, b) => b.length - a.length).slice(0, 12);
  const labels = [...longest(puzzleLabels), ...longest(lessonLabels)];
  expect(labels).toContain('Why 30. fxe8=Q#?');
  /** How much room the box leaves beside each label, in its own font. */
  const rooms = (texts: string[]) =>
    paired.getByRole('textbox', { name: 'Your Why Question' }).evaluate((el: HTMLInputElement, all: string[]) => {
      const style = getComputedStyle(el);
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) throw new Error('No canvas');
      ctx.font = style.font;
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { size: parseFloat(style.fontSize), cut: all.filter((t) => ctx.measureText(t).width > room) };
    }, texts);
  for (const [width, height] of [[390, 664], [402, 714], [440, 790], [390, 844]] as const) {
    await paired.setViewportSize({ width, height });
    // A Puzzle's box sits between the step buttons: the narrowest it gets.
    await paired.goto(`${app.url}/#/puzzles/italian-game`);
    const puzzle = await current(paired);
    await showSolution(paired);
    const answer = playLine(puzzle.fen, puzzle.moves)[1]!;
    await expect(paired.getByLabel('Your Why Question')).toHaveAttribute('placeholder', short(answer.fenBefore, answer.san));
    // 16 px, so iOS doesn't zoom in, and every label whole.
    expect(await rooms(labels), `${width}×${height}`).toEqual({ size: 16, cut: [] });
    await paired.getByRole('button', { name: 'Next Puzzle' }).click();
  }
  // A Lesson's box, after the Player's move.
  await paired.setViewportSize({ width: 390, height: 664 });
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await play(paired, 'e2e4', 'Italian Game Lesson board');
  await coachIdle(paired);
  await expect(paired.getByLabel('Your Why Question')).toHaveAttribute('placeholder', 'Why 1. e4?');
  expect(await rooms(labels)).toEqual({ size: 16, cut: [] });
});

/** Opens a Puzzle's Lesson with every other Puzzle of it done on this device, so `id` comes next. */
async function onlyPuzzle(page: Page, url: string, id: string): Promise<void> {
  const lessonId = puzzles.find((p) => p.id === id)!.lessonId;
  const others = puzzles.filter((p) => p.lessonId === lessonId && p.id !== id).map((p) => p.id);
  await page.goto(`${url}/#/puzzles/${lessonId}`);
  await current(page);
  await page.evaluate(
    (done) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('ai-chess-coach', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(done, 'puzzlesDone');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    others,
  );
  await page.reload();
}

/** Shows a Puzzle's solution: a Hint first, then the same button shows the solution. */
async function showSolution(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hint', exact: true }).click();
  await page.getByRole('button', { name: 'Show the solution' }).click();
}

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

