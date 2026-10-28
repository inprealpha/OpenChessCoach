// Feature map: Lesson, one of each kind walked decision by decision: an opening (for Black, so the
// Engine moves first), a Theme and an endgame (several parts, then a play-out). One Coach call per
// decision, every main-line move graded Best or Good, progress survives a reload, and the catalogue
// shows progress from the database. The catalogue's four tracks and its suggested next Lesson
// (ADR 0011), which finishing a Lesson moves on; the intro's goal and the Lessons it builds on; the
// Lesson's goal and key idea sent with every Coach call. Every other Lesson's data is checked
// without a browser: content.test.ts (legal, credited, goals and key ideas) and lesson-engine.test.ts
// (every move Best or Good). Goals and key ideas are read from the data, never written here.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { legalMoves, piecesOf } from '../../packages/shared/src/chess.ts';
import { LEVEL_NAMES, suggestNext, TRACK_NAMES, type CatalogueItem } from '../../packages/shared/src/content/course.ts';
import { decisions, TRACKS, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import type { LessonProgress } from '../../packages/shared/src/protocol.ts';
import { coachIdle, connection, expect, fenOf, play, test } from '../fixtures/app.ts';

const index = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as CatalogueItem[];
const readLesson = (id: string) => JSON.parse(readFileSync(new URL(`../../data/lessons/${id}.json`, import.meta.url), 'utf8')) as LessonData;
/** The seed's Player is at casual level. */
const SEED_LEVEL = 'casual';
const finished = (lessonId: string): LessonProgress => ({ lessonId, step: 1, completed: true, updatedAt: '2026-10-01T10:00:00.000Z' });

/** Saves a Lesson's progress straight into the desktop's database, as if played on another device. */
function saveProgress(app: { app: { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } } }, id: string, step: number, completed: boolean): void {
  app.app.db
    .prepare(
      `INSERT INTO lesson_progress (lesson_id, step, completed, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(lesson_id) DO UPDATE SET step = excluded.step, completed = excluded.completed, updated_at = excluded.updated_at`,
    )
    .run(id, step, completed ? 1 : 0, '2026-10-01T10:00:00.000Z');
}

/** The Coach requests the page sends from now on: watch from a fresh connection. */
async function watchCoachAsks(page: Page): Promise<{ type: string; job: string; lessonFocus?: unknown }[]> {
  const sent: { type: string; job: string; lessonFocus?: unknown }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const frame = JSON.parse(String(f.payload)) as { type: string; job: string };
      if (frame.type === 'coach.ask') sent.push(frame);
    }),
  );
  await page.reload();
  await expect(connection(page)).toHaveText(/Desktop connected/);
  return sent;
}

for (const id of ['caro-kann', 'pins', 'queen-mate']) {
  const lesson = readLesson(id);
  const steps = decisions(lesson);

  test(`the ${lesson.name} Lesson, decision by decision`, async ({ paired, app }) => {
    const boardName = `${lesson.name} Lesson board`;
    const lessonCalls = async () => (await app.rows<{ job: string }>('coach_calls')).filter((c) => c.job === 'lesson-turn').length;

    await paired.goto(`${app.url}/#/lesson/${id}`);
    await expect(paired.getByRole('heading', { name: lesson.name })).toBeVisible();
    // A text kept from Wikibooks or Wikipedia keeps its credit; one written for OpenChessCoach has none (ADR 0011).
    const about = paired.getByRole('region', { name: 'About this Lesson' });
    if (lesson.intro.credit) await expect(about.getByRole('link', { name: lesson.intro.credit.source })).toBeVisible();
    else await expect(about).not.toContainText('Text adapted from');
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
      if (lesson.kind !== 'opening') {
        const position = paired.getByRole('region', { name: 'Position' });
        await expect(position).toContainText(part.title);
        // Every position names its source; a part's text, only when it is kept from Wikibooks or Wikipedia.
        await expect(position.getByRole('link', { name: part.credit.source }).first()).toBeVisible();
        if (!part.textCredit) await expect(position).not.toContainText('Text adapted from');
        // The part's key idea would give the answer away: the screen shows it only once the part is
        // played (the Coach's replies may use it after a move, as the fake Coach does).
        if (part.keyIdea.trim()) await expect(position).not.toContainText(part.keyIdea);
      }
      await expect(paired.getByRole('region', { name: 'Your choice' })).toHaveCount(0);
      await expect(paired.getByLabel('Coach conversation')).toContainText('What are your options here?');
      await play(paired, node.main, boardName);
      await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`You played ${node.mainSan}`);
      // The Engine check (ADR 0008): the move the Lesson teaches is never graded worse than Good.
      await expect(paired.getByRole('region', { name: 'Your choice' }).getByTitle(/^Move Grade: (Best|Good)$/)).toBeVisible();
      // Once the part's last decision is played well, its key idea sums it up.
      const lastOfPart = steps[i + 1]?.partIndex !== steps[i]!.partIndex;
      if (lastOfPart && part.keyIdea.trim()) await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`Key idea: ${part.keyIdea}`);
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
    // What the Lesson taught, part by part, once it is over.
    for (const part of lesson.parts.filter((p) => p.keyIdea.trim())) await expect(done.getByRole('list', { name: 'What you learned' })).toContainText(part.keyIdea);
    // The next Lesson is the one the app suggests now this one is complete, not the next in its track.
    const next = suggestNext(index, [finished(id)], SEED_LEVEL)?.lesson;
    if (next) await expect(done.getByRole('link', { name: `Next Lesson: ${next.name}` })).toHaveAttribute('href', `#/lesson/${next.id}`);
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
  const lesson = readLesson('skewers');
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
  const lesson = readLesson('caro-kann');
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
  const lesson = readLesson('queen-mate');
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
  const lesson = readLesson('pins');
  const { node: first, part } = decisions(lesson)[0]!;
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
  // The position keeps its credit, now further down, and so does a text kept from Wikibooks or
  // Wikipedia (ADR 0005, ADR 0011: CC BY-SA text is credited).
  const position = paired.getByRole('region', { name: 'Position' });
  await expect(position.getByRole('link', { name: part.credit.source }).first()).toBeVisible();
  await expect(position.getByRole('link', { name: part.credit.licence }).first()).toBeVisible();
  if (part.textCredit) await expect(position.getByRole('link', { name: part.textCredit.source }).first()).toBeVisible();
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

test('the catalogue shows the four tracks and suggests a Lesson; finishing it moves the suggestion on', async ({ paired, app }) => {
  const first = suggestNext(index, [], SEED_LEVEL)!.lesson;
  await paired.goto(`${app.url}/#/lessons`);
  const suggested = paired.getByRole('region', { name: 'Suggested next' });
  await expect(suggested.getByRole('heading', { name: first.name })).toBeVisible();
  await expect(suggested).toContainText(`${TRACK_NAMES[first.track].name} · ${LEVEL_NAMES[first.level]}`);
  if (first.goal.trim()) await expect(suggested).toContainText(first.goal);
  await expect(suggested).toContainText('Start here.');
  await expect(suggested.getByRole('link', { name: `Start ${first.name}` })).toHaveAttribute('href', `#/lesson/${first.id}`);

  // The four tracks in order, each with a link at the top that jumps to it. Every Lesson is open:
  // nothing is locked, whatever its prior knowledge.
  const jumps = paired.getByRole('navigation', { name: 'Tracks' }).getByRole('link');
  await expect(jumps).toHaveText(TRACKS.map((t) => new RegExp(`^${TRACK_NAMES[t].name}`)));
  for (const t of TRACKS) await expect(paired.getByRole('heading', { name: TRACK_NAMES[t].name, level: 2, exact: true })).toBeVisible();
  for (const l of index) {
    const group = paired.getByRole('list', { name: `${TRACK_NAMES[l.track].name}, ${LEVEL_NAMES[l.level]}` });
    await expect(group.getByRole('link', { name: `${l.name}: Not started` })).toHaveAttribute('href', `#/lesson/${l.id}`);
  }
  const lastTrack = TRACK_NAMES[TRACKS[TRACKS.length - 1]!].name;
  await jumps.filter({ hasText: lastTrack }).click();
  const lastHeading = paired.getByRole('heading', { name: lastTrack, level: 2, exact: true });
  await expect(lastHeading).toBeFocused();
  await expect(lastHeading).toBeInViewport();

  // Learn offers the same Lesson, a click away.
  await paired.goto(`${app.url}/#/learn`);
  await expect(paired.getByRole('link', { name: first.name, exact: true })).toHaveAttribute('href', `#/lesson/${first.id}`);

  // Started on another device and one decision from the end: the suggestion says so and resumes it.
  const steps = decisions(readLesson(first.id));
  saveProgress(app, first.id, steps.length - 1, false);
  await paired.goto(`${app.url}/#/lessons`);
  // The catalogue counts decisions from the index, as the Lesson cards do.
  await expect(suggested).toContainText(`You started this Lesson and have done ${steps.length - 1} of ${first.decisions} decisions.`);
  await suggested.getByRole('link', { name: `Resume ${first.name}` }).click();
  await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
  await play(paired, steps[steps.length - 1]!.node.main, `${first.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: /^Continue/ }).click();

  // Finished: the Lesson complete region and the catalogue both move on to the same next Lesson.
  const then = suggestNext(index, [finished(first.id)], SEED_LEVEL)!.lesson;
  expect(then.id).not.toBe(first.id);
  await expect(paired.getByRole('region', { name: 'Lesson complete' }).getByRole('link', { name: `Next Lesson: ${then.name}` })).toHaveAttribute(
    'href',
    `#/lesson/${then.id}`,
  );
  await paired.goto(`${app.url}/#/lessons`);
  await expect(suggested.getByRole('heading', { name: then.name })).toBeVisible();
  await expect(paired.getByRole('link', { name: `${first.name}: Complete` })).toBeVisible();
  await expect(jumps.filter({ hasText: TRACK_NAMES[first.track].name })).toContainText(`1 of ${index.filter((l) => l.track === first.track).length} complete`);
});

test('once every Lesson is complete, the catalogue says so', async ({ paired, app }) => {
  for (const l of index) saveProgress(app, l.id, l.decisions, true);
  await paired.goto(`${app.url}/#/lessons`);
  await expect(paired.getByRole('region', { name: 'Suggested next' })).toContainText('You have done every Lesson.');
  await expect(paired.getByRole('link', { name: `${index[0]!.name}: Complete` })).toBeVisible();
});

test('the Lesson intro says what the Player will learn and links the Lessons it builds on, without locking it', async ({ paired, app }) => {
  // A Lesson with prior knowledge, if the data has one yet; the goal is read from the data either way.
  const target = index.find((l) => l.priorKnowledge.length) ?? index[0]!;
  const lesson = readLesson(target.id);
  await paired.goto(`${app.url}/#/lesson/${target.id}`);
  const about = paired.getByRole('region', { name: 'About this Lesson' });
  await expect(about).toContainText(`${TRACK_NAMES[lesson.track].name} · ${LEVEL_NAMES[lesson.level]}`);
  const goal = about.getByRole('heading', { name: 'What you will learn' });
  if (lesson.goal.trim()) {
    await expect(goal).toBeVisible();
    await expect(about).toContainText(lesson.goal);
  } else await expect(goal).toHaveCount(0);

  const builtOn = about.getByRole('list', { name: 'It builds on' });
  const priorId = lesson.priorKnowledge[0];
  if (!priorId) {
    await expect(builtOn).toHaveCount(0);
    return;
  }
  const prior = index.find((l) => l.id === priorId)!;
  const item = builtOn.getByRole('listitem').filter({ has: paired.getByRole('link', { name: prior.name, exact: true }) });
  await expect(item.getByRole('link')).toHaveAttribute('href', `#/lesson/${prior.id}`);
  await expect(item).toContainText('Not started');
  // Never a gate: the Lesson starts whether or not the Player has done what it builds on.
  await expect(about.getByRole('button', { name: 'Start the Lesson' })).toBeEnabled();
  saveProgress(app, prior.id, prior.decisions, true);
  await paired.reload();
  await expect(item).toContainText('Complete');
});

test('every Coach call in a Lesson carries the Lesson’s goal and the part’s key idea', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node, part } = decisions(lesson)[0]!;
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const sent = await watchCoachAsks(paired);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await play(paired, node.main, `${lesson.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);

  // The page sends it with a Hint, a Lesson turn and a Why Question alike (ADR 0011).
  const focus = { name: lesson.name, goal: lesson.goal, keyIdea: part.keyIdea };
  expect(sent.map((f) => f.job)).toEqual(['hint', 'lesson-turn', 'why']);
  expect(sent.map((f) => f.lessonFocus)).toEqual([focus, focus, focus]);
  // The desktop puts it in each brief as `focus`, when the Lesson has a goal or a key idea to give.
  const briefs = (await app.rows<{ job: string; brief: string }>('coach_calls')).map((c) => ({ job: c.job, focus: JSON.parse(c.brief).focus }));
  expect(briefs.map((b) => b.job)).toEqual(['hint', 'lesson-turn', 'why']);
  const expected = lesson.goal.trim() || part.keyIdea.trim() ? { lesson: lesson.name, goal: lesson.goal.trim(), keyIdea: part.keyIdea.trim() } : undefined;
  expect(briefs.map((b) => b.focus)).toEqual([expected, expected, expected]);
});

test('on a phone, the catalogue and a Lesson intro fit the screen, with the suggestion and the tracks first', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/lessons`);
  const suggested = paired.getByRole('region', { name: 'Suggested next' });
  await expect(suggested.getByRole('link', { name: /^(Start|Resume) / })).toBeInViewport();
  await expect(paired.getByRole('navigation', { name: 'Tracks' })).toBeInViewport();
  // Nothing wider than the screen, and every Lesson's card within it.
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const cards = paired.getByRole('link', { name: /: (Not started|Complete|\d+ of \d+ decisions)$/ });
  await expect(cards).toHaveCount(index.length);
  expect(await cards.evaluateAll((links) => links.filter((a) => a.getBoundingClientRect().right > innerWidth).length)).toBe(0);

  const first = suggestNext(index, [], SEED_LEVEL)!.lesson;
  await suggested.getByRole('link', { name: `Start ${first.name}` }).click();
  await expect(paired.getByRole('region', { name: 'About this Lesson' })).toBeVisible();
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(paired.getByRole('button', { name: 'Start the Lesson' })).toBeVisible();
});

/** How many king moves apart two squares are. */
function distance(a: string, b: string): number {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}
