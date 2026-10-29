// Feature map: Lesson, one of each kind walked decision by decision: an opening (for Black, so the
// Engine moves first), a Theme, an endgame (several parts, then a play-out) and a way of thinking
// during a game. One Coach call per decision, every main-line move graded Best or Good, progress
// survives a reload, and the catalogue shows progress from the database. The catalogue's four tracks
// and the Player's next Lesson (ADR 0012), which finishing a Lesson moves on; the intro's goal, the
// Lessons it builds on and How moves are written; the Lesson's learning goal and the current part's
// key idea sent with every Coach call. Every other Lesson's data is checked without a browser:
// content.test.ts (legal, credited, goals and key ideas) and lesson-engine.test.ts (every move Best
// or Good). Goals and key ideas are read from the data, never written here.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { legalMoves, piecesOf, playUci, sanLine } from '../../packages/shared/src/chess.ts';
import type { Brief } from '../../packages/shared/src/coach/brief.ts';
import { LEVEL_NAMES, suggestNext, TRACK_NAMES, type CatalogueItem } from '../../packages/shared/src/content/course.ts';
import { BANDS, decisions, TRACKS, type LessonData } from '../../packages/shared/src/content/lessons.ts';
import type { LessonProgress } from '../../packages/shared/src/protocol.ts';
import { coachIdle, coachPanel, connection, expect, fenOf, play, test } from '../fixtures/app.ts';

const index = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as CatalogueItem[];
const readLesson = (id: string) => JSON.parse(readFileSync(new URL(`../../data/lessons/${id}.json`, import.meta.url), 'utf8')) as LessonData;
/** The seed's Player is at casual level, with no rating linked. */
const SEED_PLAYER = { level: 'casual', rating: null } as const;
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

interface CoachAskFrame {
  type: string;
  job: string;
  moveUci?: string;
  lesson?: { isLessonMove?: boolean };
  lessonFocus?: unknown;
}

/**
 * The Coach requests the page sends from now on, watched from a fresh connection. It starts the
 * Lesson and waits until the Coach is ready: the desktop is connected a moment before it says
 * whether the Coach is, and a Hint pressed in between would not reach the Coach.
 */
async function watchCoachAsks(page: Page, start: 'Start the Lesson' | 'Resume the Lesson' = 'Start the Lesson'): Promise<CoachAskFrame[]> {
  const sent: CoachAskFrame[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const frame = JSON.parse(String(f.payload)) as CoachAskFrame;
      if (frame.type === 'coach.ask') sent.push(frame);
    }),
  );
  await page.reload();
  await expect(connection(page)).toHaveText(/Desktop connected/);
  await page.getByRole('button', { name: start }).click();
  await expect(coachPanel(page).getByText('Coach ready', { exact: true })).toBeVisible();
  return sent;
}

/** The Lesson's focus as the desktop puts it in a brief: a Lesson turn names the Lesson in `lesson.opening` instead. */
function briefFocus(lesson: LessonData, job: string, keyIdea: string): unknown {
  return { ...(job === 'lesson-turn' ? {} : { lesson: lesson.name }), learningGoal: lesson.goal, keyIdea };
}

for (const id of ['caro-kann', 'pins', 'queen-mate']) {
  const lesson = readLesson(id);
  const steps = decisions(lesson);

  test(`the ${lesson.name} Lesson, decision by decision`, async ({ paired, app }) => {
    const boardName = `${lesson.name} Lesson board`;
    const lessonCalls = async () => (await app.rows<{ job: string }>('coach_calls')).filter((c) => c.job === 'lesson-turn').length;

    await paired.goto(`${app.url}/#/lesson/${id}`);
    await expect(paired.getByRole('heading', { name: lesson.name })).toBeVisible();
    // A text kept from Wikibooks or Wikipedia keeps its credit; one written for OpenChessCoach has none (ADR 0012).
    const about = paired.getByRole('region', { name: 'About this Lesson' });
    if (lesson.intro.credit) await expect(about.getByRole('link', { name: lesson.intro.credit.source })).toBeVisible();
    else await expect(about).not.toContainText('Text adapted from');
    // An opening shows no Position card while it is played, so its part's text is in the intro.
    const opening = lesson.parts[0]!;
    if (lesson.kind === 'opening' && opening.text) await expect(about).toContainText(opening.text);
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
        await expect(position).not.toContainText(part.keyIdea);
      }
      await expect(paired.getByRole('region', { name: 'Your choice' })).toHaveCount(0);
      await expect(paired.getByLabel('Coach conversation')).toContainText('What are your options here?');
      await play(paired, node.main, boardName);
      await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`You played ${node.mainSan}`);
      // The Engine check (ADR 0008): the move the Lesson teaches is never graded worse than Good.
      await expect(paired.getByRole('region', { name: 'Your choice' }).getByTitle(/^Move Grade: (Best|Good)$/)).toBeVisible();
      // Once the part's last decision is played well, its key idea sums it up; not before.
      const lastOfPart = steps[i + 1]?.partIndex !== steps[i]!.partIndex;
      if (lastOfPart) await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`Key idea: ${part.keyIdea}`);
      else await expect(paired.getByRole('region', { name: 'Your choice' })).not.toContainText('Key idea:');
      await coachIdle(paired);
      expect(await lessonCalls()).toBe(i + 1);
      if (i === 0) {
        // A Why Question about the choice: the Coach answers, again with no Winning Chances.
        await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
        await coachIdle(paired);
        // The keyboard carries on from the Why box.
        await expect(paired.getByLabel('Your Why Question')).toBeFocused();
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
    for (const part of lesson.parts) await expect(done.getByRole('list', { name: 'What you learned' })).toContainText(part.keyIdea);
    // The next Lesson is the one the app suggests now this one is complete, not the next in its track.
    const next = suggestNext(index, [finished(id)], SEED_PLAYER)!.lesson;
    await expect(done.getByRole('link', { name: `Your next Lesson: ${next.name}` })).toHaveAttribute('href', `#/lesson/${next.id}`);
    // And the next Lesson in its own track, when that is another one.
    const inTrack = index.slice(index.findIndex((l) => l.id === id) + 1).find((l) => l.track === lesson.track);
    const trackLink = done.getByRole('link', { name: /^Next in / });
    if (inTrack && inTrack.id !== next.id) await expect(trackLink).toHaveAccessibleName(`Next in ${TRACK_NAMES[lesson.track].name}: ${inTrack.name}`);
    else await expect(trackLink).toHaveCount(0);
    // The finished board keeps no arrow from the last decision.
    await expect(paired.getByRole('group', { name: boardName }).getByRole('img', { name: /^Arrow / })).toHaveCount(0);
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

test('Show the move names the Lesson’s move in the Coach log once per decision, and the summary counts it apart', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node } = decisions(lesson)[0]!;
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  // The keyboard carries on from the same button, now Show the move.
  await expect(paired.getByRole('button', { name: 'Show the move' })).toBeFocused();
  // The Lesson's move, never another the Engine likes as well: the Player would be told it isn't the Lesson's.
  const shown = paired.getByLabel('Coach conversation').getByText(`The Lesson’s move here is ${node.mainSan}.`);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await expect(shown).toHaveCount(1);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await paired.getByRole('button', { name: 'Show the move' }).dblclick();
  await paired.waitForTimeout(500);
  await expect(shown).toHaveCount(1);
  await expect(paired.getByRole('img', { name: `Arrow ${node.main.slice(0, 2)} to ${node.main.slice(2, 4)} (green)` })).toHaveCount(1);
});

test('a move played after Show the move is counted apart from the Player’s own first tries', async ({ paired, app }) => {
  const lesson = readLesson('skewers');
  const steps = decisions(lesson);
  const last = steps.length - 1;
  saveProgress(app, 'skewers', last, false);
  await paired.goto(`${app.url}/#/lesson/skewers`);
  await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await play(paired, steps[last]!.node.main, `${lesson.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(paired.getByRole('region', { name: 'Lesson complete' })).toContainText('Your first try at the one decision you played this time: 1 after Show the move.');
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
  // Any move of the Player's: the position comes from the data.
  await play(paired, legalMoves(playOut.fen)[0]!, boardName);
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
  // Wikipedia (ADR 0005, ADR 0012: CC BY-SA text is credited).
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
  // One Lesson for each example: every Lesson with its own, and an opening, an endgame and a Theme without.
  const ids = [
    ...['forks', 'pins', 'pinned-pieces', 'skewers', 'discovered-attacks', 'back-rank-mate', 'mating-patterns', 'removing-the-defender', 'king-and-pawn', 'rook-endgames'],
    ...['candidate-moves', 'simple-plans', 'italian-game', 'queen-mate', 'double-attack'],
  ];
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

test('the catalogue shows the four tracks and the Player’s next Lesson; finishing it moves the next Lesson on', async ({ paired, app }) => {
  const first = suggestNext(index, [], SEED_PLAYER)!.lesson;
  await paired.goto(`${app.url}/#/lessons`);
  const suggested = paired.getByRole('region', { name: 'Your next Lesson' });
  await expect(suggested.getByRole('heading', { name: first.name })).toBeVisible();
  await expect(suggested).toContainText(`${TRACK_NAMES[first.track].name} · ${LEVEL_NAMES[first.level]}`);
  await expect(suggested).toContainText(first.goal);
  await expect(suggested).toContainText('Start here.');
  await expect(suggested).not.toContainText('so the beginner Lessons come first');
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
  // A link with a track opens the catalogue there.
  await paired.goto(`${app.url}/#/learn`);
  await paired.goto(`${app.url}/#/lessons?track=endgames`);
  const endgames = paired.getByRole('heading', { name: TRACK_NAMES.endgames.name, level: 2, exact: true });
  await expect(endgames).toBeFocused();
  await expect(endgames).toBeInViewport();

  // Learn offers the same Lesson, a click away.
  await paired.goto(`${app.url}/#/learn`);
  await expect(paired.getByText(/^Your next Lesson:/)).toContainText(first.name);
  await expect(paired.getByRole('link', { name: first.name, exact: true })).toHaveAttribute('href', `#/lesson/${first.id}`);

  // Started on another device and one decision from the end: the suggestion says so and resumes it.
  const steps = decisions(readLesson(first.id));
  saveProgress(app, first.id, steps.length - 1, false);
  await paired.goto(`${app.url}/#/lessons`);
  // The catalogue counts decisions from the index, as the Lesson cards do.
  await expect(suggested).toContainText(`You started this Lesson and have made ${steps.length - 1} of its ${first.decisions} decisions.`);
  await suggested.getByRole('link', { name: `Resume ${first.name}` }).click();
  await paired.getByRole('button', { name: 'Resume the Lesson' }).click();
  await play(paired, steps[steps.length - 1]!.node.main, `${first.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: /^Continue/ }).click();

  // Finished: the Lesson complete region and the catalogue both move on to the same next Lesson.
  const then = suggestNext(index, [finished(first.id)], SEED_PLAYER)!.lesson;
  expect(then.id).not.toBe(first.id);
  await expect(paired.getByRole('region', { name: 'Lesson complete' }).getByRole('link', { name: `Your next Lesson: ${then.name}` })).toHaveAttribute(
    'href',
    `#/lesson/${then.id}`,
  );
  // The screen shows the end before the desktop has saved it: leave only once it has.
  await expect
    .poll(async () => (await app.rows<{ lesson_id: string; completed: number }>('lesson_progress')).find((r) => r.lesson_id === first.id)?.completed)
    .toBe(1);
  await paired.goto(`${app.url}/#/lessons`);
  await expect(suggested.getByRole('heading', { name: then.name })).toBeVisible();
  const why = suggestNext(index, [finished(first.id)], SEED_PLAYER)!.why;
  expect(why === 'ready' || why === 'next').toBe(true);
  await expect(suggested).toContainText(why === 'ready' ? 'You have done the Lessons it builds on.' : 'It comes next in the order of the Lessons.');
  await expect(paired.getByRole('link', { name: `${first.name}: Complete` })).toBeVisible();
  await expect(jumps.filter({ hasText: TRACK_NAMES[first.track].name })).toContainText(`1 of ${index.filter((l) => l.track === first.track).length} complete`);
});

test('once every Lesson is complete, the catalogue says so', async ({ paired, app }) => {
  for (const l of index) saveProgress(app, l.id, l.decisions, true);
  await paired.goto(`${app.url}/#/lessons`);
  await expect(paired.getByRole('region', { name: 'Your next Lesson' })).toContainText('You have done every Lesson.');
  await expect(paired.getByRole('link', { name: `${index[0]!.name}: Complete` })).toBeVisible();
});

test('the Lesson intro says what the Player will learn and links the Lessons it builds on, without locking it', async ({ paired, app }) => {
  // A Lesson with prior knowledge; its goal and prior knowledge are read from the data.
  const target = index.find((l) => l.priorKnowledge.length);
  expect(target, 'a Lesson with prior knowledge').toBeDefined();
  const lesson = readLesson(target!.id);
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const about = paired.getByRole('region', { name: 'About this Lesson' });
  await expect(about).toContainText(`${TRACK_NAMES[lesson.track].name} · ${LEVEL_NAMES[lesson.level]}`);
  await expect(about.getByRole('heading', { name: 'What you will learn' })).toBeVisible();
  await expect(about).toContainText(lesson.goal);

  const builtOn = about.getByRole('list', { name: 'It builds on these Lessons' });
  const prior = index.find((l) => l.id === lesson.priorKnowledge[0])!;
  const item = builtOn.getByRole('listitem').filter({ has: paired.getByRole('link', { name: prior.name, exact: true }) });
  await expect(item.getByRole('link')).toHaveAttribute('href', `#/lesson/${prior.id}`);
  // The seed's Player is casual: a beginner Lesson counts as known for them (ADR 0012), so it is optional, not one to do first.
  await expect(item).toContainText(prior.level === 'beginner' ? 'Optional at your level' : 'Not started');
  await expect(about).not.toContainText('do those first');
  // Never a gate: the Lesson starts whether or not the Player has done what it builds on.
  await expect(about.getByRole('button', { name: 'Start the Lesson' })).toBeEnabled();
  saveProgress(app, prior.id, prior.decisions, true);
  await paired.reload();
  await expect(item).toContainText('Complete');
});

test('every Coach call in a Lesson carries the Lesson’s learning goal and the part’s key idea', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node, part } = decisions(lesson)[0]!;
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const sent = await watchCoachAsks(paired);
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await play(paired, node.main, `${lesson.name} Lesson board`);
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);

  // The page sends it with a Hint, a Lesson turn and a Why Question alike (ADR 0012).
  const focus = { lesson: lesson.name, learningGoal: lesson.goal, keyIdea: part.keyIdea };
  expect(sent.map((f) => f.job)).toEqual(['hint', 'lesson-turn', 'why']);
  expect(sent.map((f) => f.lessonFocus)).toEqual([focus, focus, focus]);
  // The desktop puts it in each brief as `focus`.
  const briefs = (await app.rows<{ job: string; brief: string }>('coach_calls')).map((c) => ({ job: c.job, focus: JSON.parse(c.brief).focus }));
  expect(briefs.map((b) => b.job)).toEqual(['hint', 'lesson-turn', 'why']);
  expect(briefs.map((b) => b.focus)).toEqual(briefs.map((b) => briefFocus(lesson, b.job, part.keyIdea)));
});

test('a thinking Lesson, played to the end: each Coach call carries its part’s key idea, which the screen shows only once the part is played', async ({ paired, app }) => {
  const lesson = readLesson('piece-values');
  const steps = decisions(lesson);
  const boardName = `${lesson.name} Lesson board`;
  // Several parts, each with a decision before its last: the key idea must wait for the part's end.
  expect(lesson.kind).toBe('thinking');
  expect(new Set(steps.map((s) => s.partIndex)).size).toBeGreaterThan(1);
  expect(steps.some((s, i) => steps[i + 1]?.partIndex === s.partIndex)).toBe(true);
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const sent = await watchCoachAsks(paired);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  for (const [i, { node, part }] of steps.entries()) {
    await expect(paired.getByText(`Decision ${i + 1} of ${steps.length}`)).toBeVisible();
    await expect(paired.getByRole('region', { name: 'Position' })).toContainText(part.title);
    await play(paired, node.main, boardName);
    await expect(choice).toContainText(`You played ${node.mainSan}`);
    await expect(choice.getByTitle(/^Move Grade: (Best|Good)$/)).toBeVisible();
    await coachIdle(paired);
    if (steps[i + 1]?.partIndex === steps[i]!.partIndex) await expect(choice).not.toContainText('Key idea:');
    else await expect(choice).toContainText(`Key idea: ${part.keyIdea}`);
    await paired.getByRole('button', { name: /^Continue/ }).click();
  }
  // Once the Lesson is over, a Why Question asks about the position on the board, with no move.
  const done = paired.getByRole('region', { name: 'Lesson complete' });
  await expect(done).toBeVisible();
  for (const part of lesson.parts) await expect(done.getByRole('list', { name: 'What you learned' })).toContainText(part.keyIdea);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);

  // The Hint and every Lesson turn carry their own part's key idea; the last Why Question, the last part's.
  const last = steps[steps.length - 1]!.part;
  const parts = [steps[0]!.part, ...steps.map((s) => s.part), last];
  expect(sent.map((f) => f.job)).toEqual(['hint', ...steps.map(() => 'lesson-turn'), 'why']);
  expect(sent.map((f) => f.lessonFocus)).toEqual(parts.map((p) => ({ lesson: lesson.name, learningGoal: lesson.goal, keyIdea: p.keyIdea })));
  expect(sent[sent.length - 1]).not.toHaveProperty('moveUci');
  const briefs = (await app.rows<{ job: string; brief: string }>('coach_calls')).map((c) => ({ job: c.job, brief: JSON.parse(c.brief) as { fen: string; focus?: unknown; move?: unknown } }));
  expect(briefs.map((b) => b.job)).toEqual(sent.map((f) => f.job));
  expect(briefs.map((b) => b.brief.focus)).toEqual(briefs.map((b, i) => briefFocus(lesson, b.job, parts[i]!.keyIdea)));
  expect(briefs[briefs.length - 1]!.brief).not.toHaveProperty('move');
});

test('on a phone, the catalogue and a Lesson intro fit the screen, with the next Lesson and the tracks first', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/lessons`);
  const suggested = paired.getByRole('region', { name: 'Your next Lesson' });
  await expect(suggested.getByRole('link', { name: /^(Start|Resume) / })).toBeInViewport();
  await expect(paired.getByRole('navigation', { name: 'Tracks' })).toBeInViewport();
  // Nothing wider than the screen, and every Lesson's card within it.
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const cards = paired.getByRole('link', { name: /: (Not started|Complete|\d+ of \d+ decisions)$/ });
  await expect(cards).toHaveCount(index.length);
  expect(await cards.evaluateAll((links) => links.filter((a) => a.getBoundingClientRect().right > innerWidth).length)).toBe(0);

  const first = suggestNext(index, [], SEED_PLAYER)!.lesson;
  await suggested.getByRole('link', { name: `Start ${first.name}` }).click();
  await expect(paired.getByRole('region', { name: 'About this Lesson' })).toBeVisible();
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(paired.getByRole('button', { name: 'Start the Lesson' })).toBeVisible();
  // How moves are written, opened, still fits.
  await paired.getByText('How moves are written', { exact: true }).click();
  await expect(paired.getByText('takes: Nxe5 is a knight taking on e5')).toBeVisible();
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('How moves are written explains the notation, closed until the Player opens it, in the intro and while playing', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/italian-game`);
  const about = paired.getByRole('region', { name: 'About this Lesson' });
  const help = paired.getByText('How moves are written', { exact: true });
  const takes = paired.getByText('takes: Nxe5 is a knight taking on e5');
  await expect(about.getByText('How moves are written', { exact: true })).toBeVisible();
  await expect(takes).toBeHidden();
  await help.click();
  for (const text of ['The letters a to h are the files', 'king, queen, rook, bishop, knight', 'checkmate', 'castles kingside', 'castles queenside', 'becomes a queen', 'White’s 12th move', 'Black’s 12th move']) {
    await expect(about).toContainText(text);
  }
  await expect(takes).toBeVisible();
  // While playing, beside the board: one, closed again.
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(paired.getByText('Decision 1 of')).toBeVisible();
  await expect(help).toHaveCount(1);
  await expect(takes).toBeHidden();
  await help.click();
  await expect(takes).toBeVisible();
});

/** The Lesson turns' briefs, as the desktop sent them to the Coach. */
async function lessonBriefs(app: { rows<T>(table: string): Promise<T[]> }): Promise<Brief[]> {
  return (await app.rows<{ job: string; brief: string }>('coach_calls')).filter((c) => c.job === 'lesson-turn').map((c) => JSON.parse(c.brief) as Brief);
}

test('a poor move that isn’t the Lesson’s keeps the answer back, and Continue with the Lesson’s move then shows it with its note', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const steps = decisions(lesson);
  const { node } = steps[0]!;
  const boardName = `${lesson.name} Lesson board`;
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const sent = await watchCoachAsks(paired);
  await play(paired, 'g2g4', boardName);
  await coachIdle(paired);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await expect(choice).toContainText('You played g4');
  await expect(choice.getByTitle(/^Move Grade: (Inaccuracy|Mistake|Blunder)$/)).toBeVisible();
  // Nothing on the screen gives the answer away: no popularity table, which would list it, no green
  // arrow, no Lesson note, and no Why Question until the Player chooses how to go on.
  await expect(choice.getByRole('table')).toHaveCount(0);
  await expect(paired.getByRole('group', { name: boardName }).getByRole('img', { name: /\(green\)$/ })).toHaveCount(0);
  if (node.notes) await expect(paired.getByText(node.notes.text)).toHaveCount(0);
  await expect(paired.getByLabel('Your Why Question')).toHaveCount(0);
  await expect(choice).not.toContainText('Key idea:');
  await expect(paired.getByLabel('Coach conversation')).toContainText('Try another move, or continue with the Lesson’s move.');
  // The page says the move isn't the Lesson's, and the desktop's brief keeps the answer back.
  expect(sent.filter((f) => f.job === 'lesson-turn').map((f) => f.lesson?.isLessonMove)).toEqual([false]);
  const [brief] = await lessonBriefs(app);
  expect(brief?.candidates).toEqual([]);
  expect(brief?.lesson).toMatchObject({ notes: '', isLessonMove: false });
  await expect(choice.getByRole('button', { name: 'Try another move' })).toBeVisible();

  // Continue with the Lesson's move shows the move, its note and how often players choose it, before moving on.
  await choice.getByRole('button', { name: 'Continue with the Lesson’s move' }).click();
  const shown = paired.getByRole('region', { name: 'The Lesson’s move' });
  await expect(shown).toContainText(`The Lesson continues with ${node.mainSan}, the move it teaches.`);
  if (node.notes) await expect(shown).toContainText(node.notes.text);
  if (node.popular.casual.length) await expect(shown.getByRole('table', { name: 'Move popularity at your level' })).toBeVisible();
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', playUci(node.fen, node.main)!.fenAfter);
  await expect(paired.getByRole('group', { name: boardName }).getByRole('img', { name: /^(Best|Inaccuracy|Mistake|Blunder) on / })).toHaveCount(0);
  await expect(paired.getByLabel('Your Why Question')).toBeVisible();
  const go = shown.getByRole('button', { name: 'Continue', exact: true });
  await expect(go).toBeFocused();
  await go.click();
  await expect(paired.getByText(`Decision 2 of ${steps.length}`)).toBeVisible();
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', steps[1]!.node.fen);
  // Showing the Lesson's move costs no Coach call.
  expect(await lessonBriefs(app)).toHaveLength(1);
});

test('a sound move that isn’t the Lesson’s says so plainly, and the Player can try another', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node } = decisions(lesson)[0]!;
  const boardName = `${lesson.name} Lesson board`;
  const other = node.popular.casual.find((p) => p.uci !== node.main)!;
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await play(paired, other.uci, boardName);
  await coachIdle(paired);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await expect(choice).toContainText(`You played ${other.san}`);
  await expect(choice.getByTitle(/^Move Grade: (Best|Good)$/)).toBeVisible();
  await expect(choice).toContainText('A sound move, but not the one this Lesson is teaching.');
  // How often players at the Player's level choose this move, but not the table, which would show the Lesson's.
  await expect(choice).toContainText(`${other.percent}% of players rated ${BANDS.casual.label} play ${other.san} here.`);
  await expect(choice.getByRole('table')).toHaveCount(0);
  await expect(paired.getByLabel('Coach conversation')).toContainText('a sound move, but not the one this Lesson is teaching');
  expect((await lessonBriefs(app))[0]?.candidates).toEqual([]);
  await expect(choice.getByRole('button', { name: 'Continue with the Lesson’s move' })).toBeVisible();

  // Try another move: the keyboard carries on from the board.
  await choice.getByRole('button', { name: 'Try another move' }).click();
  await expect(paired.getByRole('group', { name: boardName })).toBeFocused();
  await play(paired, node.main, boardName);
  await coachIdle(paired);
  await expect(choice).toContainText(`You played ${node.mainSan}`);
  await expect(choice.getByRole('table', { name: 'Move popularity at your level' })).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Try another move' })).toHaveCount(0);
  // The Lesson's own move gets the whole brief, notes and all.
  const [, lessonMove] = await lessonBriefs(app);
  expect(lessonMove?.candidates.length).toBeGreaterThan(0);
  expect(lessonMove?.lesson).not.toHaveProperty('isLessonMove');
  if (node.notes) expect(lessonMove?.lesson?.notes).toBe(node.notes.text);
});

test('Try another move waits for the Coach’s answer, and starts the next try with no arrows and no reasoning', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node } = decisions(lesson)[0]!;
  const boardName = `${lesson.name} Lesson board`;
  const other = node.popular.casual.find((p) => p.uci !== node.main)!;
  // Hold the Coach's answer back, as the real Coach, which is slow, would.
  let holding = true;
  const held: (() => void)[] = [];
  await paired.routeWebSocket(/\/ws\b/, (ws) => {
    const server = ws.connectToServer();
    const asks = new Set<string>();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id: string; type: string };
      if (msg.type === 'coach.ask') asks.add(msg.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id?: string };
      if (holding && msg.id && asks.has(msg.id)) held.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  // A fresh connection, through the route.
  await paired.reload();
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(coachPanel(paired).getByText('Coach ready', { exact: true })).toBeVisible();
  await paired.getByLabel('Explain your thinking (optional)').fill('I want to bring a piece out.');
  await play(paired, other.uci, boardName);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await expect(choice).toContainText(`You played ${other.san}`);
  // While the Coach answers, the Player can't move on: its arrows would land on the next try.
  await expect(choice.getByRole('button', { name: 'Try another move' })).toBeDisabled();
  await expect(choice.getByRole('button', { name: 'Continue with the Lesson’s move' })).toBeDisabled();
  holding = false;
  for (const send of held.splice(0)) send();
  await coachIdle(paired);
  const board = paired.getByRole('group', { name: boardName });
  await expect(board.getByRole('img', { name: /\((blue|red|yellow)\)$/ })).not.toHaveCount(0);
  await choice.getByRole('button', { name: 'Try another move' }).click();
  // The arrows were about the move taken back, and so was the reasoning.
  await expect(board.getByRole('img', { name: /\((blue|red|yellow|green)\)$/ })).toHaveCount(0);
  await expect(paired.getByLabel('Explain your thinking (optional)')).toHaveValue('');
  await play(paired, node.main, boardName);
  await coachIdle(paired);
  await expect(choice).toContainText(`You played ${node.mainSan}`);
  expect((await lessonBriefs(app)).map((b) => b.question)).toEqual(['I want to bring a piece out.', undefined]);
});

test('a part whose line starts with the opponent’s move says at its first decision what the opponent played', async ({ paired, app }) => {
  const lesson = readLesson('mate-in-one');
  const { part, node } = decisions(lesson)[0]!;
  // The board shows the position after the opponent's move.
  expect(node.ply).toBe(1);
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(paired.getByRole('group', { name: `${lesson.name} Lesson board` })).toHaveAttribute('data-fen', node.fen);
  const played = sanLine(part.fen, part.mainLine.slice(0, 1))[0]!;
  await expect(paired.getByRole('region', { name: 'Position' })).toContainText(`${part.side === 'white' ? 'Black' : 'White'} played ${played}.`);
});

test('after a part’s first decision, its text folds away as how the part began, and the Position says what the opponent replied', async ({ paired, app }) => {
  const lesson = readLesson('piece-values');
  const steps = decisions(lesson);
  const boardName = `${lesson.name} Lesson board`;
  // A decision after the first of its part, and the part's first decision before it.
  const later = steps.findIndex((s, i) => i > 0 && steps[i - 1]!.partIndex === s.partIndex);
  const { part, node } = steps[later]!;
  expect(part.text).toBeTruthy();
  saveProgress(app, lesson.id, later - 1, false);
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  await paired.getByRole('button', { name: /^(Resume|Start) the Lesson$/ }).click();
  const position = paired.getByRole('region', { name: 'Position' });
  await expect(position.getByText(part.text!)).toBeVisible();
  await expect(position.getByText('How this part began')).toHaveCount(0);
  await play(paired, steps[later - 1]!.node.main, boardName);
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(paired.getByText(`Decision ${later + 1} of ${steps.length}`)).toBeVisible();
  await expect(position).toContainText(part.title);
  const replied = sanLine(part.fen, part.mainLine.slice(0, node.ply)).at(-1)!;
  await expect(position).toContainText(`${part.side === 'white' ? 'Black' : 'White'} replied ${replied}.`);
  // The text describes the position the part started from: folded away until the Player opens it.
  await expect(position.getByText(part.text!)).toBeHidden();
  await position.getByText('How this part began').click();
  await expect(position.getByText(part.text!)).toBeVisible();

  // A part where the Player changes sides says so.
  const turned = steps.findIndex((s) => s.partIndex > 0 && lesson.parts[s.partIndex - 1]!.side !== s.part.side && steps.find((x) => x.partIndex === s.partIndex) === s);
  if (turned >= 0) {
    saveProgress(app, lesson.id, turned, false);
    await paired.goto(`${app.url}/#/learn`);
    await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
    await paired.getByRole('button', { name: /^(Resume|Start) the Lesson$/ }).click();
    await expect(position).toContainText(`You play ${steps[turned]!.part.side === 'white' ? 'White' : 'Black'} in this part.`);
  }
});

test('a Lesson and its play-out link back to the Lessons, on the intro and while playing', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/lesson/queen-mate`);
  const back = paired.getByRole('link', { name: 'Back to the Lessons' });
  await expect(back).toHaveAttribute('href', '#/lessons');
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(paired.getByText('Decision 1 of')).toBeVisible();
  await expect(back).toBeVisible();
  await back.click();
  await expect(paired.getByRole('heading', { name: 'Lessons', level: 1 })).toBeVisible();
  await paired.goto(`${app.url}/#/play-out/queen-mate`);
  await paired.getByRole('link', { name: 'Back to the Lessons' }).click();
  await expect(paired.getByRole('heading', { name: 'Lessons', level: 1 })).toBeVisible();
});

test('the browser’s Back from a Lesson returns to the place in the Lessons the Player had scrolled to', async ({ paired, app }) => {
  // The last Lesson in the list, far down the Lessons; its intro is much shorter than that.
  const last = index.at(-1)!;
  await paired.goto(`${app.url}/#/lessons`);
  // The router puts the place back itself. With the browser's own restoring off, as on a browser that
  // puts it back on the screen still showing (and cuts it short there), it still comes back.
  await paired.evaluate(() => (history.scrollRestoration = 'manual'));
  const link = paired.locator(`a.item[href="#/lesson/${last.id}"]`);
  await link.scrollIntoViewIfNeeded();
  const y = await paired.evaluate(() => scrollY);
  expect(y).toBeGreaterThan(1000);
  await link.click();
  await expect(paired.getByRole('heading', { name: last.name, level: 1 })).toBeVisible();
  // A new step opens at the top of its screen.
  expect(await paired.evaluate(() => scrollY)).toBe(0);
  await paired.goBack();
  await expect(paired.getByRole('heading', { name: 'Lessons', level: 1 })).toBeAttached();
  await expect.poll(() => paired.evaluate(() => scrollY)).toBe(y);
  await expect(link).toBeInViewport();
  // Forward returns to the Lesson at its top.
  await paired.goForward();
  await expect(paired.getByRole('heading', { name: last.name, level: 1 })).toBeVisible();
  expect(await paired.evaluate(() => scrollY)).toBe(0);
});

test('on a phone with Safari’s bars (390×664), the Hint and Continue need no scrolling, even with the popularity table', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node } = decisions(lesson)[0]!;
  const boardName = `${lesson.name} Lesson board`;
  await paired.setViewportSize({ width: 390, height: 664 });
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  // While choosing, the Hint sits under the board, and the arrow Show the move draws is in view with it.
  await expect(paired.getByRole('button', { name: 'Hint' })).toBeInViewport({ ratio: 1 });
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await expect(paired.getByRole('group', { name: boardName })).toBeInViewport({ ratio: 0.9 });
  await expect(paired.getByRole('img', { name: `Arrow ${node.main.slice(0, 2)} to ${node.main.slice(2, 4)} (green)` })).toHaveCount(1);
  // After the choice, Continue comes before the popularity table.
  await play(paired, node.main, boardName);
  await coachIdle(paired);
  await expect(paired.getByRole('table', { name: 'Move popularity at your level' })).toBeVisible();
  const atTop = () => paired.evaluate(() => scrollTo(0, 0));
  await atTop();
  await expect(paired.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport({ ratio: 1 });
  await paired.getByRole('button', { name: 'Continue', exact: true }).click();
  // And after a sound move that isn't the Lesson's, with the most to say, both ways on.
  const second = decisions(lesson)[1]!.node;
  await play(paired, second.popular.casual.find((p) => p.uci !== second.main)!.uci, boardName);
  await coachIdle(paired);
  await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText('A sound move, but not the one this Lesson is teaching.');
  await atTop();
  // The sentence that says why comes before the buttons, so it shows with them.
  await expect(paired.getByRole('region', { name: 'Your choice' }).getByText('A sound move, but not the one this Lesson is teaching.')).toBeInViewport({ ratio: 1 });
  await expect(paired.getByRole('button', { name: 'Try another move' })).toBeInViewport({ ratio: 1 });
  await expect(paired.getByRole('button', { name: 'Continue with the Lesson’s move' })).toBeInViewport({ ratio: 1 });
  // Then the Lesson's move, its note and Continue.
  await paired.getByRole('button', { name: 'Continue with the Lesson’s move' }).click();
  await atTop();
  await expect(paired.getByRole('region', { name: 'The Lesson’s move' }).getByRole('button', { name: 'Continue', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a casual Player whose linked rating is under 1400 is suggested the beginner Lessons first', async ({ paired, app }) => {
  app.app.db.prepare(`UPDATE profile SET rating = 1250, rating_site = 'lichess', rating_username = 'CoachVerify' WHERE id = 1`).run();
  const first = suggestNext(index, [], { level: 'casual', rating: 1250 })!.lesson;
  expect(first.level).toBe('beginner');
  await paired.goto(`${app.url}/#/lessons`);
  // The page read the Player Profile when it paired, before the rating was linked.
  await paired.reload();
  const suggested = paired.getByRole('region', { name: 'Your next Lesson' });
  await expect(suggested.getByRole('heading', { name: first.name })).toBeVisible();
  await expect(suggested).toContainText('Start here.');
  await expect(suggested).not.toContainText('skip the beginner Lessons');
  // It says why, as the Player Profile still says Casual.
  await expect(suggested).toContainText(`Your rating on Lichess is ${BANDS.beginner.label}, so the beginner Lessons come first.`);
});

test('a checkmate other than the Lesson’s move counts as correct and ends the part; on a phone, the next Lesson then shows without scrolling', async ({ paired, app }) => {
  const lesson = readLesson('queen-mate');
  const steps = decisions(lesson);
  const boardName = `${lesson.name} Lesson board`;
  // The last decision, where the Lesson's move gives checkmate and so do others.
  const last = steps.length - 1;
  const { node, part } = steps[last]!;
  const mate = legalMoves(node.fen).find((uci) => uci !== node.main && playUci(node.fen, uci)!.san.endsWith('#'))!;
  const san = playUci(node.fen, mate)!.san;
  saveProgress(app, lesson.id, last, false);
  await paired.setViewportSize({ width: 390, height: 664 });
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  const sent = await watchCoachAsks(paired, 'Resume the Lesson');
  await play(paired, mate, boardName);
  await coachIdle(paired);
  const choice = paired.getByRole('region', { name: 'Your choice' });
  await expect(choice).toContainText(`You played ${san}`);
  await expect(choice).toContainText('Checkmate!');
  // Treated as the Lesson's move: no "not the one this Lesson is teaching", no Try another move,
  // the part's key idea, and the Coach gets the whole brief.
  await expect(choice).not.toContainText('not the one this Lesson is teaching');
  await expect(choice.getByRole('button', { name: 'Try another move' })).toHaveCount(0);
  await expect(choice).toContainText(`Key idea: ${part.keyIdea}`);
  expect(sent.filter((f) => f.job === 'lesson-turn').map((f) => f.lesson?.isLessonMove)).toEqual([true]);
  await choice.getByRole('button', { name: 'Continue', exact: true }).click();

  // The Lesson is complete, with the Player's own checkmate on the board, and on a phone its card
  // comes into view with the focus, so the next Lesson needs no scrolling.
  const done = paired.getByRole('region', { name: 'Lesson complete' });
  await expect(done).toBeFocused();
  await expect(done.getByRole('link', { name: /^Your next Lesson: / })).toBeInViewport({ ratio: 1 });
  await expect(paired.getByRole('group', { name: boardName })).toHaveAttribute('data-fen', playUci(node.fen, mate)!.fenAfter);
  await expect(done).toContainText('Your first try at the one decision you played this time:');
  await expect.poll(async () => (await app.rows<{ completed: number }>('lesson_progress'))[0]?.completed).toBe(1);
});

test('after the Lesson’s move, the Coach’s arrows show no other move for the Player: it may be the next decision’s answer', async ({ paired, app }) => {
  const lesson = readLesson('italian-game');
  const { node } = decisions(lesson)[0]!;
  const boardName = `${lesson.name} Lesson board`;
  // A Coach reply that draws another move for the Player in green, as the Engine's top choice.
  const other = legalMoves(node.fen).find((uci) => uci !== node.main && uci.startsWith('d2'))!;
  await paired.routeWebSocket(/\/ws\b/, (ws) => {
    const server = ws.connectToServer();
    const asks = new Set<string>();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id: string; type: string; job?: string };
      if (msg.type === 'coach.ask' && msg.job === 'lesson-turn') asks.add(msg.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id?: string; type?: string; data?: { arrows: { from: string; to: string; brush: string }[] } };
      if (msg.type === 'result' && msg.id && asks.has(msg.id) && msg.data) {
        msg.data.arrows = [{ from: other.slice(0, 2), to: other.slice(2, 4), brush: 'green' }, ...msg.data.arrows];
        ws.send(JSON.stringify(msg));
      } else ws.send(m);
    });
  });
  await paired.goto(`${app.url}/#/lesson/${lesson.id}`);
  await paired.reload();
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await paired.getByRole('button', { name: 'Start the Lesson' }).click();
  await expect(coachPanel(paired).getByText('Coach ready', { exact: true })).toBeVisible();
  await play(paired, node.main, boardName);
  await coachIdle(paired);
  await expect(paired.getByRole('region', { name: 'Your choice' })).toContainText(`You played ${node.mainSan}`);
  const board = paired.getByRole('group', { name: boardName });
  // The move played and the opponent's reply stay; the other move for the Player is not drawn.
  await expect(board.getByRole('img', { name: `Arrow ${node.main.slice(0, 2)} to ${node.main.slice(2, 4)} (green)` })).toHaveCount(1);
  await expect(board.getByRole('img', { name: /\(yellow\)$/ })).not.toHaveCount(0);
  await expect(board.getByRole('img', { name: new RegExp(`^Arrow ${other.slice(0, 2)} to `) })).toHaveCount(0);
});

/** How many king moves apart two squares are. */
function distance(a: string, b: string): number {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}
