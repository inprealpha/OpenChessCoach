// Feature map: Lesson, one of each kind walked decision by decision: an opening (for Black, so the
// Engine moves first), a Theme and an endgame (several parts, then a play-out). One Coach call per
// decision, every main-line move graded Best or Good, progress survives a reload, and the catalogue
// shows progress from the database. Every other Lesson's data is checked without a browser:
// content.test.ts (legal, credited) and lesson-engine.test.ts (every move Best or Good).
import { readFileSync } from 'node:fs';
import { legalMoves, piecesOf } from '../../packages/shared/src/chess.ts';
import { decisions, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import { coachIdle, expect, fenOf, play, test } from '../fixtures/app.ts';

for (const id of ['caro-kann', 'pins', 'queen-mate']) {
  const lesson = JSON.parse(readFileSync(new URL(`../../data/lessons/${id}.json`, import.meta.url), 'utf8')) as LessonData;
  const steps = decisions(lesson);

  test(`the ${lesson.name} Lesson, decision by decision`, async ({ paired, app }) => {
    const boardName = `${lesson.name} Lesson board`;
    const lessonCalls = async () => (await app.rows<{ job: string }>('coach_calls')).filter((c) => c.job === 'lesson-turn').length;

    await paired.goto(`${app.url}/#/lesson/${id}`);
    await expect(paired.getByRole('heading', { name: lesson.name })).toBeVisible();
    await expect(paired.getByRole('link', { name: /^(Wikibooks|Wikipedia), / }).first()).toBeVisible();
    await paired.getByRole('button', { name: 'Start the Lesson' }).click();

    for (const [i, { node, part }] of steps.entries()) {
      if (i === 2) {
        // Reload part-way, once the next decision shows (Continue saves before showing it): the
        // Lesson resumes at the same decision.
        await expect(paired.getByText(`Decision ${i + 1} of ${steps.length}`)).toBeVisible();
        await paired.reload();
        await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
        await expect
          .poll(async () => (await app.rows<{ lesson_id: string; step: number; completed: number }>('lesson_progress'))[0])
          .toMatchObject({ lesson_id: id, step: 2, completed: 0 });
      }
      await expect(paired.getByText(`Decision ${i + 1} of ${steps.length}`)).toBeVisible();
      await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', node.fen);
      // No Winning Chances bar in a Lesson: it would give the answer away.
      await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveCount(0);
      if (lesson.kind !== 'opening') await expect(paired.getByRole('region', { name: 'Position' })).toContainText(part.title);
      await expect(paired.getByLabel('Coach conversation')).toContainText('What are your options here?');
      await play(paired, node.main, boardName);
      await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`You played ${node.mainSan}`);
      // The Engine check (ADR 0008): the move the Lesson teaches is never graded worse than Good.
      await expect(paired.getByRole('region', { name: 'Your choice' }).getByTitle(/^Move Grade: (Best|Good)$/)).toBeVisible();
      await coachIdle(paired);
      expect(await lessonCalls()).toBe(i + 1);
      if (i === 0) {
        // A Why Question about the choice: the Coach answers, again with no Winning Chances.
        await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
        await coachIdle(paired);
      }
      await paired.getByRole('button', { name: /^Continue/ }).click();
    }
    // The Lesson hides the Winning Chances, so none of its Coach briefs carries them.
    const briefs = (await app.rows<{ job: string; brief: string }>('coach_calls')).map((c) => ({ job: c.job, chances: JSON.parse(c.brief).winningChances }));
    expect(briefs.filter((b) => b.job === 'why')).toHaveLength(1);
    expect(briefs.filter((b) => b.chances !== undefined)).toEqual([]);

    const done = paired.getByRole('region', { name: 'Lesson complete' });
    await expect(done).toBeVisible();
    if (lesson.playOut) await expect(done.getByRole('link', { name: /^Play it out against the Engine/ })).toHaveAttribute('href', `#/play-out/${id}`);
    await expect.poll(async () => (await app.rows<{ step: number; completed: number }>('lesson_progress'))[0]).toMatchObject({
      step: steps.length,
      completed: 1,
    });
    expect(await lessonCalls()).toBe(steps.length);

    await paired.goto(`${app.url}/#/lessons`);
    await expect(paired.getByRole('link', { name: `${lesson.name}: Complete` })).toBeVisible();
  });
}

test('an explanation the desktop refuses shows its error, not as sent', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  const box = paired.getByLabel('Explain your thinking (optional)');
  // Past the box's limit, as a modified page could send.
  await box.evaluate((el: HTMLTextAreaElement) => el.removeAttribute('maxlength'));
  const long = 'I want to control the centre. '.repeat(12).trim();
  await box.fill(long);
  await play(paired, 'e2e4', 'Italian Game Lesson board');
  await coachIdle(paired);
  const log = paired.getByLabel('Coach conversation');
  await expect(log).toContainText('A question can be at most 300 characters.');
  await expect(log).not.toContainText('You:');
  expect(await app.rows('coach_calls')).toHaveLength(0);
});

test('a poor choice can be retried, and the catalogue shows partial progress', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await play(paired, 'g2g4', 'Italian Game Lesson board');
  await coachIdle(paired);
  // The Player's choice carries its Move Grade symbol on the board.
  const board = paired.getByRole('group', { name: 'Italian Game Lesson board' });
  const symbols = board.getByRole('img', { name: /^(Best|Inaccuracy|Mistake|Blunder) on [a-h][1-8]$/ });
  await expect(symbols).toHaveCount(1);
  await expect(symbols).toHaveAccessibleName(/^(Inaccuracy|Mistake|Blunder) on g4$/);
  await paired.getByRole('button', { name: 'Try another move' }).click();
  await expect(symbols).toHaveCount(0);
  await play(paired, 'e2e4', 'Italian Game Lesson board');
  await coachIdle(paired);
  await expect(board.getByRole('img', { name: 'Best on e4' })).toBeVisible();
  await paired.getByRole('button', { name: 'Continue' }).click();
  await expect(paired.getByText('Decision 2 of')).toBeVisible();
  await paired.goto(`${app.url}/#/lessons`);
  await expect(paired.getByRole('link', { name: /^Italian Game: 1 of \d+ decisions$/ })).toBeVisible();
  await expect.poll(async () => (await app.rows<{ step: number }>('lesson_progress'))[0]?.step).toBe(1);
});

test('a Lesson resumed at its last decision sums up the one decision played', async ({ paired, app }) => {
  const lesson = JSON.parse(readFileSync(new URL('../../data/lessons/skewers.json', import.meta.url), 'utf8')) as LessonData;
  const steps = decisions(lesson);
  const last = steps.length - 1;
  app.app.db
    .prepare('INSERT INTO lesson_progress (lesson_id, step, completed, updated_at) VALUES (?, ?, 0, ?)')
    .run('skewers', last, '2026-10-01T10:00:00.000Z');
  await paired.goto(`${app.url}/#/lesson/skewers`);
  await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
  await expect(paired.getByText(`Decision ${steps.length} of ${steps.length}`)).toBeVisible();
  await play(paired, steps[last]!.node.main, `${lesson.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: /^Continue/ }).click();
  await expect(paired.getByRole('region', { name: 'Lesson complete' })).toContainText(
    /Your first try at the one decision you played this time: 1 (Best|Good)\./,
  );
});

test('a double click on Continue moves on one decision, not two', async ({ paired, app }) => {
  const lesson = JSON.parse(readFileSync(new URL('../../data/lessons/caro-kann.json', import.meta.url), 'utf8')) as LessonData;
  const steps = decisions(lesson);
  const boardName = `${lesson.name} Lesson board`;
  await paired.goto(`${app.url}/#/lesson/caro-kann`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await play(paired, steps[0]!.node.main, boardName);
  await coachIdle(paired);
  await paired.getByRole('button', { name: /^Continue/ }).dblclick();
  await expect(paired.getByText(`Decision 2 of ${steps.length}`)).toBeVisible();
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', steps[1]!.node.fen);
  // Give a second, skipping Continue time to land before checking it did not.
  await paired.waitForTimeout(500);
  await expect(paired.getByText(`Decision 2 of ${steps.length}`)).toBeVisible();
  await expect.poll(async () => (await app.rows<{ step: number; completed: number }>('lesson_progress'))[0]).toMatchObject({ step: 1, completed: 0 });
});

test('a double click on Start the Lesson shows the first prompt once', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  const start = paired.getByRole('button', { name: 'Start the Lesson' });
  await expect(start).toBeVisible();
  // Both clicks land in the same instant, before the page has redrawn: the fastest double click.
  await start.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(paired.getByText('Decision 1 of')).toBeVisible();
  // Give a second prompt time to land before checking it did not.
  await paired.waitForTimeout(500);
  await expect(paired.getByLabel('Coach conversation').getByText('What are your options here?')).toHaveCount(1);
});

test('Show the move adds the Engine’s move to the Coach log once per decision', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  const engineMove = paired.getByLabel('Coach conversation').getByText(/The Engine’s move here is/);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await expect(engineMove).toHaveCount(1);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await paired.getByRole('button', { name: 'Show the move' }).dblclick();
  // Long enough for another analysis from the desktop to have come back.
  await paired.waitForTimeout(1000);
  await expect(engineMove).toHaveCount(1);
  await expect(paired.getByRole('img', { name: /^Arrow \w\d to \w\d \(green\)$/ })).toHaveCount(1);
});

test('an endgame Lesson ends with a position to play out against the Engine', async ({ paired, app }) => {
  const lesson = JSON.parse(readFileSync(new URL('../../data/lessons/queen-mate.json', import.meta.url), 'utf8')) as LessonData;
  const playOut = lesson.playOut!;
  await paired.goto(`${app.url}/#/play-out/queen-mate`);
  await expect(paired.getByRole('heading', { name: `${lesson.name}: play it out` })).toBeVisible();
  const boardName = 'Play-out board';
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', playOut.fen);
  await expect(paired.getByRole('region', { name: 'Play it out' })).toContainText('Checkmate the black king.');
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveCount(0);
  await play(paired, 'b1b5', boardName);
  // The Engine answers for Black; the count is the Player's own moves.
  await expect(paired.getByText('1 move played')).toBeVisible();
  await paired.getByRole('button', { name: 'Start again' }).click();
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', playOut.fen);
});

test('a play-out that loses the pawn says the pawn is gone, not that the game is drawn', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/play-out/king-and-pawn`);
  const boardName = 'Play-out board';
  const status = paired.getByRole('region', { name: 'Play it out' }).getByRole('status');
  await expect(status).toHaveText('Promote your pawn.');
  // The Engine moves first; then walk the white king away from its pawn until the Engine takes it.
  for (let played = 0; played < 12; played++) {
    await expect(paired.getByText(`${played} ${played === 1 ? 'move' : 'moves'} played`)).toBeVisible();
    if ((await status.innerText()).includes('Try again')) break;
    const fen = await fenOf(paired, boardName);
    const king = piecesOf(fen).find((p) => p.role === 'king' && p.color === 'white')?.square ?? '';
    const pawn = piecesOf(fen).find((p) => p.role === 'pawn')?.square ?? 'e3';
    const away = legalMoves(fen)
      .filter((m) => m.startsWith(king))
      .sort((a, b) => distance(b.slice(2, 4), pawn) - distance(a.slice(2, 4), pawn))[0];
    await play(paired, away as string, boardName);
  }
  await expect(status).toHaveText('Your pawn is gone, so it can no longer promote. Try again.');
});

test('on a phone, a Theme Lesson keeps the Move Grade and Continue under the board, with one box to type in', async ({ paired, app }) => {
  const lesson = JSON.parse(readFileSync(new URL('../../data/lessons/pins.json', import.meta.url), 'utf8')) as LessonData;
  const first = decisions(lesson)[0]!.node;
  const boardName = `${lesson.name} Lesson board`;
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/lesson/pins`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  // While choosing, one place to type, and its example fits the Theme.
  const thinking = paired.getByLabel('Explain your thinking (optional)');
  await expect(thinking).toHaveAttribute('placeholder', /pin/i);
  await expect(paired.getByLabel('Your Why Question')).toHaveCount(0);

  await play(paired, first.main, boardName);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await expect(choice).toContainText(`You played ${first.mainSan}`);
  await coachIdle(paired);
  // The Move Grade and Continue sit under the board: no scrolling down and back up for each decision.
  await expect(choice).toBeInViewport();
  await expect(paired.getByRole('button', { name: /^Continue/ })).toBeInViewport();
  await expect(paired.getByRole('group', { name: boardName })).toBeInViewport({ ratio: 0.9 });
  // The position's text keeps its credit, now further down (ADR 0005: CC BY-SA notes are credited).
  const position = paired.getByRole('region', { name: 'Position' });
  await expect(position.getByRole('link', { name: /^Wikibooks, / })).toBeVisible();
  await expect(position.getByRole('link', { name: /^CC BY-SA / })).toBeVisible();
  // Once the move is graded, follow-up questions go in the Coach's box.
  await expect(thinking).toHaveCount(0);
  await expect(paired.getByLabel('Your Why Question')).toBeVisible();
});

test('on a 375px phone, each Lesson’s example in the thinking box shows whole', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 375, height: 812 });
  // One Lesson for each example: every Theme and endgame with its own, and one opening and one endgame without.
  const ids = ['forks', 'pins', 'skewers', 'discovered-attacks', 'back-rank-mate', 'removing-the-defender', 'king-and-pawn', 'rook-endgames', 'italian-game', 'queen-mate'];
  for (const id of ids) {
    await paired.goto(`${app.url}/#/lesson/${id}`);
    await paired.getByRole('button', { name: 'Start the Lesson' }).click();
    const box = paired.getByLabel('Explain your thinking (optional)');
    // A box of two lines that wraps, so the example shows whole whatever the device's font.
    const fit = await box.evaluate((el: HTMLTextAreaElement) => {
      const css = getComputedStyle(el);
      const text = document.createElement('canvas').getContext('2d')!;
      text.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      return {
        tag: el.tagName,
        rows: el.rows,
        example: el.placeholder,
        width: text.measureText(el.placeholder).width,
        room: el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      };
    });
    expect({ tag: fit.tag, rows: fit.rows }, id).toEqual({ tag: 'TEXTAREA', rows: 2 });
    // Within its two lines with room to spare, for wider fonts than this one.
    expect(fit.width, `${id}: ${fit.example}`).toBeLessThanOrEqual(1.8 * fit.room);
  }
});

/** How many king moves apart two squares are. */
function distance(a: string, b: string): number {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}
