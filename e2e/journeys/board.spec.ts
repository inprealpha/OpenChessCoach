// Feature map: Board and Engine, Why Question. ADR 0002: the Engine judges, the Coach explains;
// ADR 0006: the Engine is deterministic in verify mode; ADR 0007: the browser and the desktop run
// the same Engine build.
import type { Page } from '@playwright/test';
import type { GradedMove } from '../../packages/shared/src/analysis.ts';
import { INITIAL_FEN, playUci, sanLine, turnOf } from '../../packages/shared/src/chess.ts';
import type { Analysis } from '../../packages/shared/src/engine.ts';
import { parseSinglePgn } from '../../packages/shared/src/pgn.ts';
import { winningChancesFor } from '../../packages/shared/src/winning-chances.ts';
import { game, PGN_FIXTURES } from '../../packages/shared/test/golden.ts';
import { CoachClient } from '../../packages/backend/src/client.ts';
import { startVerifyInstance, VERIFY_ENGINE } from '../../packages/backend/src/verify/instance.ts';
import { board, coachIdle, connection, expect, fenOf, play, square, test } from '../fixtures/app.ts';

const MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'b2b4'];

/** The threat arrows on the board, by accessible name. */
function threatArrows(page: Page) {
  return page.getByRole('img', { name: /^Threat: / });
}

/** Plays the moves on the free board with Threat on and returns each Move Grade, the threat, the final Engine lines and the Winning Chances bar. */
async function playAndRead(page: Page, url: string): Promise<{ grades: string[]; threat: string; lines: string[]; bar: string }> {
  await page.goto(`${url}/#/board`);
  await page.getByRole('button', { name: 'Threat' }).click();
  for (const uci of MOVES) await play(page, uci);
  // After 4.b4 the pawn attacks the bishop on c5: the threat White would carry out if it were White's move.
  await expect(threatArrows(page)).toHaveCount(1);
  const threat = (await threatArrows(page).getAttribute('aria-label')) ?? '';
  const moves = page.getByRole('list', { name: 'Moves' }).getByRole('button');
  await expect(moves).toHaveCount(MOVES.length);
  for (let i = 0; i < MOVES.length; i++) await expect(moves.nth(i)).toHaveAccessibleName(/, (Best|Good|Inaccuracy|Mistake|Blunder)$/);
  const grades = await moves.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  await page.getByRole('button', { name: 'Show Engine lines' }).click();
  const section = page.getByRole('region', { name: 'Engine lines' });
  await expect(section.getByText('Depth 10')).toBeVisible();
  const lines = await section.getByRole('listitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  // Black is to move: the bar names White, the side at the bottom, with the rest of line 1's percentage.
  const black = Number(/Black’s winning chances: (\d+)%/.exec(lines[0] ?? '')?.[1]);
  const bar = chancesBar(page);
  await expect(bar).toHaveAccessibleName(`Winning Chances bar: White’s winning chances: ${100 - black}%`);
  return { grades, threat, lines, bar: (await bar.getAttribute('aria-label')) ?? '' };
}

test('the Engine grades every move, and finds the threat, the same way on every run', async ({ paired, app, browser }) => {
  const first = await playAndRead(paired, app.url);
  expect(first.lines).toHaveLength(5);
  expect(first.threat).toBe('Threat: White threatens bxc5 (b4 to c5)');
  expect(first.bar).toBe('Winning Chances bar: White’s winning chances: 48%');

  const second = await startVerifyInstance();
  try {
    const page = await browser.newPage();
    await page.goto(`${second.url}/#pair=${second.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    const again = await playAndRead(page, second.url);
    expect(again).toEqual(first);
    await page.close();
  } finally {
    await second.stop();
  }
});

/** The Engine lines the board shows for its position: the depth, and each line's move, evaluation and continuation. */
async function shownLines(page: Page): Promise<{ depth: string; lines: string[] }> {
  const section = page.getByRole('region', { name: 'Engine lines' });
  const depth = (await section.getByText(/^Depth \d+$/).allTextContents()).join();
  const lines = await section.getByRole('listitem').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label') ?? ''} | ${(e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()}`));
  return { depth, lines };
}

/** The same lines as the board would show them, from the desktop Engine's analysis. */
function asShown(analysis: Analysis): { depth: string; lines: string[] } {
  return {
    depth: `Depth ${analysis.depth}`,
    lines: analysis.lines.map((line, i) => {
      const sans = sanLine(analysis.fen, line.pv.slice(0, 6));
      const chances = winningChancesFor(line.score, turnOf(analysis.fen));
      return `Engine line ${i + 1}: ${sans[0] ?? ''}, ${chances.text}, ${chances.evaluation} | ${[chances.short, chances.evaluation, ...sans].join(' ')}`;
    }),
  };
}

test('the browser Engine shows the same lines as the desktop Engine for golden positions', async ({ paired, app }) => {
  // A real Lichess game from the golden fixtures, checked at the start, mid-opening with Black to
  // move, after castling, and after a pawn break (ADR 0007: one Engine build in both places).
  const golden = game('iinnkv77');
  const checkpoints = [0, 7, 16, 23];
  const desktop = await CoachClient.connect(app.url, app.token);
  try {
    await paired.goto(`${app.url}/#/board`);
    await paired.getByRole('button', { name: 'Show Engine lines' }).click();
    let played = 0;
    for (const ply of checkpoints) {
      for (; played < ply; played++) await play(paired, (golden.moves[played] as GradedMove).uci);
      const fen = (golden.moves[ply] as GradedMove).fenBefore;
      expect(await fenOf(paired)).toBe(fen);
      const expected = asShown(await desktop.request('engine.analyse', { fen }));
      // Compare final analyses only: the board also shows shallower lines while the Engine thinks.
      expect(expected.depth).toBe(`Depth ${VERIFY_ENGINE.depth}`);
      expect(expected.lines).toHaveLength(VERIFY_ENGINE.multiPv);
      await expect.poll(() => shownLines(paired), { message: `Engine lines after ply ${ply}` }).toEqual(expected);
    }
  } finally {
    await desktop.close();
  }
});

test('the Threat button shows the opponent’s threat, follows each move and is remembered on the device', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const button = paired.getByRole('button', { name: 'Threat' });
  // Off by default: no arrow, even with Scholar's Mate threatened after 1.e4 e5 2.Qh5 Nc6 3.Bc4.
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  for (const uci of ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4']) await play(paired, uci);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(5);
  await expect(threatArrows(paired)).toHaveCount(0);

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(threatArrows(paired)).toHaveAccessibleName('Threat: White threatens Qxf7# (h5 to f7)');

  // 3...g6 stops the mate and attacks the queen: now Black threatens gxh5.
  await play(paired, 'g7g6');
  await expect(threatArrows(paired)).toHaveAccessibleName('Threat: Black threatens gxh5 (g6 to h5)');
  // Stepping back shows the threat in that position again.
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(threatArrows(paired)).toHaveAccessibleName('Threat: White threatens Qxf7# (h5 to f7)');

  // The choice survives a reload.
  await paired.reload();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await play(paired, 'e2e4');
  await play(paired, 'e7e5');
  await play(paired, 'g1f3');
  await expect(threatArrows(paired)).toHaveAccessibleName('Threat: White threatens Nxe5 (f3 to e5)');

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(threatArrows(paired)).toHaveCount(0);
  await paired.reload();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('the Engine lines lead with the side to move’s Winning Chances, the evaluation beside them', async ({ paired, app }) => {
  // The start position and 1. e4 in verify mode: the same Engine facts as the golden Italian Game.
  await paired.goto(`${app.url}/#/board`);
  await paired.getByRole('button', { name: 'Show Engine lines' }).click();
  const section = paired.getByRole('region', { name: 'Engine lines' });
  const first = section.getByRole('listitem').first();
  await expect(section.getByText('Depth 10')).toBeVisible();
  await expect(first).toHaveAccessibleName('Engine line 1: e4, White’s winning chances: 53%, +0.38');
  await expect(first.getByTestId('winning-chances')).toHaveText('53%');
  await expect(first.getByTestId('evaluation')).toHaveText('+0.38');
  // The evaluation is kept, smaller, beside the percentage.
  const size = (testId: string) => first.getByTestId(testId).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await size('evaluation')).toBeLessThan(await size('winning-chances'));
  await expect(section).toContainText('White’s winning chances');

  await play(paired, 'e2e4');
  await expect(section.getByText('Depth 10')).toBeVisible();
  await expect(section.getByRole('listitem').first()).toHaveAccessibleName('Engine line 1: e6, Black’s winning chances: 47%, -0.37');
  await expect(section).toContainText('Black’s winning chances');
});

/** The Winning Chances bar beside the board, read by its accessible name. */
function chancesBar(page: Page) {
  return page.getByRole('meter', { name: /^Winning Chances bar/ });
}

test('the Winning Chances bar beside the board matches the Engine lines, follows the moves and flips with the board', async ({ paired, app }) => {
  // The start position and 1. e4 in verify mode: the same seeded Engine facts as the Engine lines journey.
  await paired.goto(`${app.url}/#/board`);
  const bar = chancesBar(paired);
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  await expect(bar).toHaveAttribute('aria-valuenow', '53');
  await expect(bar.getByTestId('bar-percent')).toHaveText(['47%', '53%']);

  // The same value as the Engine's first candidate move for the same position.
  await paired.getByRole('button', { name: 'Show Engine lines' }).click();
  const section = paired.getByRole('region', { name: 'Engine lines' });
  await expect(section.getByRole('listitem').first()).toHaveAccessibleName('Engine line 1: e4, White’s winning chances: 53%, +0.38');

  await play(paired, 'e2e4');
  await expect(section.getByRole('listitem').first()).toHaveAccessibleName('Engine line 1: e6, Black’s winning chances: 47%, -0.37');
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');

  // It follows the board as the Player steps through moves, with no Coach call.
  await play(paired, 'g7g5');
  await expect(section.getByText('Depth 10')).toBeVisible();
  const afterG5 = (await section.getByRole('listitem').first().getAttribute('aria-label')) ?? '';
  const white = Number(/White’s winning chances: (\d+)%/.exec(afterG5)?.[1]);
  expect(white).toBeGreaterThan(53);
  await expect(bar).toHaveAccessibleName(`Winning Chances bar: White’s winning chances: ${white}%`);
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  await paired.getByRole('button', { name: 'Last position' }).click();
  await expect(bar).toHaveAccessibleName(`Winning Chances bar: White’s winning chances: ${white}%`);
  expect(await app.rows('coach_calls')).toHaveLength(0);

  // It flips with the board: the side at the bottom of the board fills the bar from the bottom.
  const fill = () =>
    bar.getByTestId('bar-fill').evaluate((el) => {
      const own = el.getBoundingClientRect();
      const whole = (el.parentElement as HTMLElement).getBoundingClientRect();
      return { side: el.getAttribute('data-side'), fromBottom: Math.abs(own.bottom - whole.bottom) < 1.5, share: Math.round((own.height / whole.height) * 100) };
    });
  await expect.poll(fill).toEqual({ side: 'white', fromBottom: true, share: white });
  await paired.getByRole('button', { name: 'Flip board' }).click();
  await expect(bar).toHaveAccessibleName(`Winning Chances bar: Black’s winning chances: ${100 - white}%`);
  await expect.poll(fill).toEqual({ side: 'black', fromBottom: true, share: 100 - white });
});

test('the Winning Chances bar stands beside the board, and under it on a phone', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const bar = chancesBar(paired);
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  const boxes = async () => {
    const b = await board(paired, 'Chess board').boundingBox();
    const c = await bar.boundingBox();
    if (!b || !c) throw new Error('The board or the bar is not shown');
    return { board: b, bar: c };
  };
  const wide = await boxes();
  expect(wide.bar.x + wide.bar.width).toBeLessThanOrEqual(wide.board.x);
  expect(Math.abs(wide.bar.height - wide.board.height)).toBeLessThan(2);

  // A phone: the board keeps the full width and the bar lies under it, as wide as the board.
  await paired.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const { board: b, bar: c } = await boxes();
      return c.y >= b.y + b.height;
    })
    .toBe(true);
  const narrow = await boxes();
  expect(Math.abs(narrow.bar.width - narrow.board.width)).toBeLessThan(2);
  expect(narrow.board.width).toBeGreaterThan(340);
  expect(narrow.bar.height).toBeLessThan(30);
});

test('the squares meet edge to edge, like a real board', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const squares = board(paired, 'Chess board').getByRole('button');
  await expect(squares).toHaveCount(64);
  // Squares are buttons: none may pick up the app's rounded button corners, which leave gaps.
  const corners = await squares.evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).borderRadius))]);
  expect(corners).toEqual(['0px']);
});

test('a pawn reaching the last rank offers four full-size pieces and a readable Cancel', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  for (const uci of ['a2a4', 'h7h6', 'a4a5', 'h6h5', 'a5a6', 'h5h4', 'a6b7', 'h4h3']) await play(paired, uci);
  await square(paired, 'b7').click();
  await square(paired, 'a8').click();
  const dialog = paired.getByRole('dialog', { name: 'Choose a piece to promote to' });
  // The dialog's buttons must not pick up the app's button padding and white text, and on a
  // phone, where four pieces and Cancel don't fit on one row, they must wrap rather than shrink.
  for (const size of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
    await paired.setViewportSize(size);
    for (const name of ['queen', 'rook', 'bishop', 'knight']) {
      const piece = await dialog.getByRole('button', { name: `Promote to ${name}` }).locator('img').boundingBox();
      expect(piece?.width, `${name} at ${size.width}px`).toBeGreaterThanOrEqual(48);
      expect(piece?.height, `${name} is square at ${size.width}px`).toBe(piece?.width);
    }
  }
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const [text, background] = await cancel.evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
  expect(text).not.toBe(background);
  expect(text).not.toBe('rgb(255, 255, 255)');
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await play(paired, 'b7a8n');
  await expect(square(paired, 'a8')).toHaveAccessibleName('a8, white knight');
});

test('a mate shows on the Winning Chances bar as a mate, not a percentage', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  for (const uci of ['f2f3', 'e7e5', 'g2g4']) await play(paired, uci);
  const bar = chancesBar(paired);
  await expect(bar).toHaveAccessibleName('Winning Chances bar: Black mates in 1');
  await expect(bar.getByTestId('bar-percent')).toHaveText(['M1']);
  await play(paired, 'd8h4');
  await expect(bar).toHaveAccessibleName('Winning Chances bar: Black has checkmated');
});

test('a graded move on the Board shows its Move Grade symbol, and the symbol follows the steps', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const symbols = board(paired).getByRole('img', { name: /^(Best|Inaccuracy|Mistake|Blunder) on [a-h][1-8]$/ });
  // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? lets White mate with Qxf7#.
  for (const uci of ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6']) await play(paired, uci);
  await expect(paired.getByRole('button', { name: 'Move 3… Nf6, Blunder', exact: true })).toBeVisible();
  await expect(symbols).toHaveCount(1);
  await expect(board(paired).getByRole('img', { name: 'Blunder on f6' })).toBeVisible();
  // Each step shows the symbol of the move that reached the position, none at the start.
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(board(paired).getByRole('img', { name: 'Blunder on f6' })).toHaveCount(0);
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect(board(paired).getByRole('img', { name: 'Blunder on f6' })).toBeVisible();
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(symbols).toHaveCount(0);
});

/** Records every piece slide on the board as "from-to", read from where the piece's image starts out. */
async function recordSlides(page: Page): Promise<void> {
  await page.evaluate(() => {
    const slides: string[] = [];
    (window as unknown as { slides: string[] }).slides = slides;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = animate.apply(this, args);
      const to = this.closest('[data-square]')?.getAttribute('data-square');
      const grid = this.closest('[data-orientation]');
      if (to && grid) {
        const b = grid.getBoundingClientRect();
        const p = this.getBoundingClientRect();
        const col = Math.floor(((p.x + p.width / 2 - b.x) / b.width) * 8);
        const row = Math.floor(((p.y + p.height / 2 - b.y) / b.height) * 8);
        const white = grid.getAttribute('data-orientation') === 'white';
        slides.push(`${'abcdefgh'[white ? col : 7 - col]}${white ? 8 - row : row + 1}-${to}`);
      }
      return animation;
    };
  });
}

/** The slides recorded since the last call, sorted. */
async function slides(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { slides: string[] }).slides.splice(0).sort());
}

test('a move slides its piece; a dropped piece, a new board, a jump and a device asking for less motion show at once', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await recordSlides(paired);
  await play(paired, 'e2e4');
  await expect.poll(() => slides(paired)).toEqual(['e2-e4']);
  for (const uci of ['e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']) await play(paired, uci);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(6);
  await slides(paired);
  // Castling moves the king and the rook.
  await play(paired, 'e1g1');
  await expect.poll(() => slides(paired)).toEqual(['e1-g1', 'h1-f1']);
  // A piece dragged to its square is already there: it doesn't slide again.
  await square(paired, 'd7').dragTo(square(paired, 'd6'));
  await expect(square(paired, 'd6')).toHaveAccessibleName('d6, black pawn');
  // Stepping back slides the piece home; the flipped board slides it the other way up.
  await paired.getByRole('button', { name: 'Flip board' }).click();
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(square(paired, 'd7')).toHaveAccessibleName('d7, black pawn');
  expect(await slides(paired)).toEqual(['d6-d7']);
  // A jump through the moves shows its position at once.
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(square(paired, 'e2')).toHaveAccessibleName('e2, white pawn');
  expect(await slides(paired)).toEqual([]);
  // A promotion slides the pawn in as its new piece; a new board after it is not a move.
  await paired.getByRole('button', { name: 'Flip board' }).click();
  for (const uci of ['a2a4', 'h7h6', 'a4a5', 'h6h5', 'a5a6', 'h5h4', 'a6b7', 'h4h3']) await play(paired, uci);
  await expect(square(paired, 'h3')).toHaveAccessibleName('h3, black pawn');
  await slides(paired);
  await play(paired, 'b7a8q');
  await expect.poll(() => slides(paired)).toEqual(['b7-a8']);
  await paired.getByRole('button', { name: 'New board' }).click();
  await expect(square(paired, 'b7')).toHaveAccessibleName('b7, black pawn');
  expect(await slides(paired)).toEqual([]);
  // Nor is a new board after a single move: it shows the start at once, not that move taken back.
  await play(paired, 'e2e4');
  await expect.poll(() => slides(paired)).toEqual(['e2-e4']);
  await paired.getByRole('button', { name: 'New board' }).click();
  await expect(square(paired, 'e2')).toHaveAccessibleName('e2, white pawn');
  expect(await slides(paired)).toEqual([]);
  // Nothing slides when the device asks for less motion.
  await paired.emulateMedia({ reducedMotion: 'reduce' });
  await play(paired, 'e2e4');
  await expect(square(paired, 'e4')).toHaveAccessibleName('e4, white pawn');
  expect(await slides(paired)).toEqual([]);
});

test('the arrow keys step through the moves as on Lichess, but not while the Player types', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const fens = [INITIAL_FEN];
  for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
    await play(paired, uci);
    fens.push(playUci(fens.at(-1) as string, uci)?.fenAfter as string);
  }
  const shows = (i: number) => expect(board(paired)).toHaveAttribute('data-fen', fens[i] as string);
  await shows(3);
  // Focus is still on the square just clicked: the keys work from there.
  for (const [key, i] of [['ArrowLeft', 2], ['ArrowLeft', 1], ['ArrowRight', 2], ['Home', 0], ['End', 3], ['ArrowUp', 0], ['ArrowDown', 3]] as const) {
    await paired.keyboard.press(key);
    await shows(i);
  }
  await expect(paired.getByRole('button', { name: 'Previous move' })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft');

  // In the Why Question box the arrows move the text cursor, not the board.
  const box = paired.getByLabel('Your Why Question');
  await box.fill('why');
  for (const key of ['ArrowLeft', 'Home', 'ArrowUp']) await box.press(key);
  await shows(3);
  // A modified arrow is left to the browser: Alt+← is its Back.
  await paired.getByRole('button', { name: 'Flip board' }).focus();
  await paired.evaluate(() =>
    addEventListener('keydown', (e) => setTimeout(() => Object.assign(window, { leftAlone: !e.defaultPrevented })), { once: true }),
  );
  await paired.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => paired.evaluate(() => (window as { leftAlone?: boolean }).leftAlone)).toBe(true);
  await shows(3);
});

test('en passant slides only the capturing pawn, and a promotion made by dragging slides its pawn in', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  for (const uci of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await play(paired, uci);
  await expect(square(paired, 'd5')).toHaveAccessibleName('d5, black pawn');
  await recordSlides(paired);
  // The pawn taken en passant just goes.
  await play(paired, 'e5d6');
  await expect.poll(() => slides(paired)).toEqual(['e5-d6']);
  for (const uci of ['h7h6', 'd6c7', 'h6h5']) await play(paired, uci);
  await expect(square(paired, 'h5')).toHaveAccessibleName('h5, black pawn');
  await slides(paired);
  const dialog = paired.getByRole('dialog', { name: 'Choose a piece to promote to' });
  // A drag to the last rank that the Player cancels leaves the same promotion, by clicks, its slide.
  await square(paired, 'c7').dragTo(square(paired, 'b8'));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await play(paired, 'c7b8q');
  await expect(square(paired, 'b8')).toHaveAccessibleName('b8, white queen');
  expect(await slides(paired)).toEqual(['c7-b8']);
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect.poll(() => slides(paired)).toEqual(['b8-c7']);
  // A pawn dragged to the last rank goes back while the Player chooses, so its new piece slides in.
  await square(paired, 'c7').dragTo(square(paired, 'b8'));
  await dialog.getByRole('button', { name: 'Promote to queen' }).click();
  await expect(square(paired, 'b8')).toHaveAccessibleName('b8, white queen');
  expect(await slides(paired)).toEqual(['c7-b8']);
});

/** How far from its square, in squares, a square's piece is drawn. */
async function drawnAway(page: Page, sq: string): Promise<number> {
  return square(page, sq).evaluate((el) => {
    const s = el.getBoundingClientRect();
    const p = el.querySelector('img')?.getBoundingClientRect() ?? s;
    return Math.round(Math.hypot(p.x - s.x, p.y - s.y) / s.width);
  });
}

test('a step taken back before its slide ends draws the captured piece back on its square', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  for (const uci of ['e2e4', 'd7d5']) await play(paired, uci);
  await expect(square(paired, 'd5')).toHaveAccessibleName('d5, black pawn');
  // Slides that last a minute, so the step back comes while exd5 is still sliding.
  await paired.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      return animate.call(this, keyframes, { ...(options as KeyframeAnimationOptions), duration: 60_000 });
    };
  });
  await play(paired, 'e4d5');
  await expect(square(paired, 'd5')).toHaveAccessibleName('d5, white pawn');
  expect(await drawnAway(paired, 'd5')).toBe(1);
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(square(paired, 'd5')).toHaveAccessibleName('d5, black pawn');
  // White's pawn slides back to e4; Black's is on d5 at once, not sliding in from e4.
  expect(await drawnAway(paired, 'e4')).toBe(1);
  expect(await drawnAway(paired, 'd5')).toBe(0);
});

test('the Engine’s reply in an Engine Game slides its piece', async ({ paired, app }) => {
  const BOARD = 'Engine Game board';
  await paired.goto(`${app.url}/#/engine-game`);
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Start the Engine Game' }).click();
  await expect(square(paired, 'e2', BOARD)).toHaveAccessibleName('e2, white pawn');
  await recordSlides(paired);
  await play(paired, 'e2e4', BOARD);
  // In verify mode the Engine answers 1...d5.
  await expect(square(paired, 'd5', BOARD)).toHaveAccessibleName('d5, black pawn');
  expect(await slides(paired)).toEqual(['d7-d5', 'e2-e4']);
});

test('in a Review, a step slides its piece; a jump through the moves and opening or closing a key moment show at once', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/review/1`);
  await expect(square(paired, 'e2', 'Review board')).toHaveAccessibleName('e2, white pawn');
  await recordSlides(paired);
  // From the start to 2. Bc4 is three moves: a jump.
  await paired.getByRole('button', { name: /^Move 2\. Bc4/ }).click();
  await expect(square(paired, 'c4', 'Review board')).toHaveAccessibleName('c4, white bishop');
  expect(await slides(paired)).toEqual([]);
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect.poll(() => slides(paired)).toEqual(['b8-c6']);
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect.poll(() => slides(paired)).toEqual(['c6-b8']);
  await paired.getByRole('button', { name: /^Move 11\. Bxf7\+/ }).click();
  await expect(square(paired, 'f7', 'Review board')).toHaveAccessibleName('f7, white bishop');
  expect(await slides(paired)).toEqual([]);
  // A key moment opened from the position after its move shows the one before it, and closing it
  // shows the one after again: neither is a move, though each is one move away.
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  const show = paired.getByRole('button', { name: 'Show moment: move 11. Bxf7+, Mistake' });
  await expect(show).toBeVisible({ timeout: 90_000 });
  await paired.getByRole('button', { name: /^Move 11\. Bxf7\+/ }).click();
  await expect(square(paired, 'f7', 'Review board')).toHaveAccessibleName('f7, white bishop');
  await slides(paired);
  await show.click();
  await expect(square(paired, 'f7', 'Review board')).toHaveAccessibleName('f7, black pawn');
  expect(await slides(paired)).toEqual([]);
  await show.click();
  await expect(square(paired, 'f7', 'Review board')).toHaveAccessibleName('f7, white bishop');
  expect(await slides(paired)).toEqual([]);
});

test('the arrow keys do nothing while the promotion dialog is open, and step again once it closes', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const line = ['a2a4', 'h7h6', 'a4a5', 'h6h5', 'a5a6', 'h5h4', 'a6b7', 'h4h3'];
  for (const uci of line) await play(paired, uci);
  const shows = (plies: number) =>
    expect(board(paired)).toHaveAttribute('data-fen', line.slice(0, plies).reduce((fen, uci) => playUci(fen, uci)?.fenAfter as string, INITIAL_FEN));
  await square(paired, 'b7').click();
  await square(paired, 'a8').click();
  const dialog = paired.getByRole('dialog', { name: 'Choose a piece to promote to' });
  await expect(dialog).toBeVisible();
  for (const key of ['ArrowLeft', 'Home', 'ArrowUp']) await paired.keyboard.press(key);
  await expect(dialog).toBeVisible();
  await shows(8);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await paired.keyboard.press('ArrowLeft');
  await shows(7);
});

test('on a phone, the move list keeps the move just played in view once its Move Grade arrives', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/board`);
  const list = paired.getByRole('list', { name: 'Moves' });
  const current = list.locator('li.current');
  /** Whether the current move shows whole inside the move list's own scroll box. */
  const currentInView = async () => {
    const box = await list.boundingBox();
    const item = await current.boundingBox();
    return Boolean(box && item && item.y >= box.y - 1 && item.y + item.height <= box.y + box.height + 1);
  };
  const hidden: string[] = [];
  for (const [i, m] of (game('iinnkv77').moves.slice(0, 40) as GradedMove[]).entries()) {
    await play(paired, m.uci);
    await expect(list.getByRole('listitem')).toHaveCount(i + 1);
    // Its Move Grade badge arrives a moment later and widens the item, often onto a new row.
    await expect(current.getByRole('button')).toHaveAccessibleName(/, (Best|Good|Inaccuracy|Mistake|Blunder)$/);
    if (!(await currentInView())) hidden.push(`ply ${i + 1}, ${m.san}`);
  }
  expect(hidden).toEqual([]);
});

test('an illegal move is refused on the board', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await play(paired, 'e2e5');
  await expect(paired.getByText('That move isn’t legal.')).toBeVisible();
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(0);
});

test('a click on the other side’s piece names the side to move, capitalised', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await square(paired, 'e7').click();
  await expect(paired.getByText('It’s White’s move.', { exact: true })).toBeVisible();
});

test('the Board says when the game is over, and stepping back takes it away', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  const result = paired.getByRole('status', { name: 'Result' });
  await expect(result).toHaveText('');
  for (const uci of ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']) await play(paired, uci);
  await expect(result).toHaveText('Checkmate. White wins.');
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(result).toHaveText('');
});

test('on a phone the Why Question box is wide enough for its placeholder', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/board`);
  const input = paired.getByRole('textbox', { name: 'Your Why Question' });
  await expect(input).toBeVisible();
  const room = await input.evaluate((el: HTMLInputElement) => {
    const style = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.font = style.font;
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - ctx.measureText(el.placeholder).width;
  });
  expect(room).toBeGreaterThanOrEqual(0);
});

test('with reduced motion the Winning Chances bar jumps instead of sliding', async ({ paired, app }) => {
  await paired.emulateMedia({ reducedMotion: 'reduce' });
  await paired.goto(`${app.url}/#/board`);
  const durations = await paired.getByTestId('bar-fill').evaluate((el) => getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d)));
  expect(Math.max(...durations)).toBeLessThan(0.01);
});

test('a Why Question is answered with Engine moves only, and the brief is recorded', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await play(paired, 'e2e4');
  await play(paired, 'e7e5');
  await play(paired, 'd1h5');
  await expect(paired.getByRole('button', { name: /Move 2\. Qh5, / })).toBeVisible();
  await paired.getByLabel('Your Why Question').fill('Why not develop a knight?');
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  await expect(paired.getByLabel('Coach conversation')).toContainText('Qh5 is graded');

  const calls = await app.rows<{ job: string; brief: string; model: string }>('coach_calls');
  expect(calls).toHaveLength(1);
  const call = calls[0] as { job: string; brief: string; model: string };
  expect(call.job).toBe('why');
  expect(call.model).toBe('sonnet');
  const brief = JSON.parse(call.brief) as Record<string, unknown> & { move: { san: string }; question: string };
  expect(brief.move.san).toBe('Qh5');
  expect(brief.question).toBe('Why not develop a knight?');
  // Every arrow on the board comes from the Engine's candidates or the move itself.
  const arrows = paired.getByRole('img', { name: /^Arrow / });
  await expect(arrows.first()).toBeVisible();
});

test('the Coach quotes the Winning Chances the bar shows either side of the move', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  for (const uci of MOVES.slice(0, 5)) await play(paired, uci);
  await expect(paired.getByRole('button', { name: /Move 3\. Bc4, / })).toBeVisible();
  // The bar shows the Engine's best line in the position on the board: 54% after 3. Bc4, and 54% before it.
  const bar = chancesBar(paired);
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 54%');
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 54%');
  await paired.getByRole('button', { name: 'Last position' }).click();

  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  // The fake Coach repeats the brief's Winning Chances word for word, as the real Coach is told to.
  await expect(paired.getByLabel('Coach conversation')).toContainText('Bc4 is graded Good. Before it, White’s winning chances: 54%. After it, White’s winning chances: 54%.');
});

test('a Why Question stops at 300 characters, and the Player sees how many are left', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await play(paired, 'e2e4');
  const input = paired.getByLabel('Your Why Question');
  const left = paired.getByTestId('why-chars-left');
  await input.fill('Why e4?');
  await expect(left).toBeHidden();
  await input.fill('Why '.repeat(70));
  await expect(left).toHaveText('20 characters left');
  await input.fill('Why not d4 instead? '.repeat(250));
  await expect(input).toHaveValue('Why not d4 instead? '.repeat(250).slice(0, 300));
  await expect(left).toHaveText('0 characters left');
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const calls = await app.rows<{ brief: string }>('coach_calls');
  expect((JSON.parse((calls[0] as { brief: string }).brief) as { question: string }).question).toHaveLength(299);
});

test('a question the desktop refuses shows its error and stays in the box, not as sent', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await play(paired, 'e2e4');
  const input = paired.getByLabel('Your Why Question');
  // Past the box's limit, as a modified page could send.
  await input.evaluate((el: HTMLInputElement) => el.removeAttribute('maxlength'));
  const long = 'Why not d4 instead? '.repeat(20).trim();
  await input.fill(long);
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  const log = paired.getByLabel('Coach conversation');
  await expect(log).toContainText('A question can be at most 300 characters.');
  await expect(log).not.toContainText('You:');
  await expect(input).toHaveValue(long);
  expect(await app.rows('coach_calls')).toHaveLength(0);
});

test('a Coach move the Engine never suggested is stripped before it reaches the board', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/board`);
  await play(paired, 'e2e4');
  await app.script({ kind: 'reply', reply: { text: 'Push the h-pawn.', moves: ['h7h5'], arrows: [{ uci: 'h7h5', brush: 'red' }], highlights: [] } });
  await paired.getByRole('button', { name: 'Ask the Coach why' }).click();
  await coachIdle(paired);
  await expect(paired.getByLabel('Coach conversation')).toContainText('Push the h-pawn.');
  await expect(paired.getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  const calls = await app.rows<{ stripped: string }>('coach_calls');
  expect(JSON.parse((calls[0] as { stripped: string }).stripped)).not.toEqual([]);
});

test.describe('when the Engine can’t start', () => {
  // The offline app shell's service worker caches the Engine's files with requests the route below
  // never sees, and once it controls the page it would serve the Engine whatever the route says.
  test.use({ serviceWorkers: 'block' });

  test('the Player is told instead of left waiting', async ({ page, app }) => {
    // The Engine's files fail to load, as when a browser refuses the Engine's memory.
    await page.context().route('**/engine/**', (route) => route.abort());
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await page.goto(`${app.url}/#/board`);
    await play(page, 'e2e4');
    await expect(page.getByRole('alert')).toHaveText(/The Engine couldn’t start in this browser/);
    // The board itself keeps working.
    await play(page, 'e7e5');
    await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
  });
});

test.describe('setting up a position', () => {
  // White mates with Rd8.
  const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

  async function setUp(page: Page, text: string): Promise<void> {
    await page.getByRole('button', { name: 'Set up a position' }).click();
    await page.getByRole('textbox', { name: /a FEN .* or a PGN/ }).fill(text);
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
  }

  test('a pasted FEN becomes the Board’s position, and the Engine reads it', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    await setUp(paired, MATE_IN_ONE);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', MATE_IN_ONE);
    await expect(paired.getByRole('form', { name: 'Set up a position' })).toHaveCount(0);
    await expect(chancesBar(paired)).toHaveAccessibleName('Winning Chances bar: White mates in 1');
    await paired.getByRole('button', { name: 'Show Engine lines' }).click();
    await expect(paired.getByRole('region', { name: 'Engine lines' }).getByRole('listitem').first()).toHaveAccessibleName(/^Engine line 1: Rd8#/);
    // The Player plays on from it as from any position.
    await play(paired, 'd1d8');
    await expect(paired.getByRole('status', { name: 'Result' })).toHaveText('Checkmate. White wins.');
  });

  test('a pasted PGN fills the move list from its first position, and the keys step through it', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    await setUp(paired, '[Event "Casual"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
    const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
    await expect(moves).toHaveCount(6);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', INITIAL_FEN);
    const ucis = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
    const fenAfter = (n: number): string => ucis.slice(0, n).reduce((fen, uci) => playUci(fen, uci)?.fenAfter ?? fen, INITIAL_FEN);
    await paired.keyboard.press('ArrowRight');
    await paired.keyboard.press('ArrowRight');
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', fenAfter(2));
    // Each move is graded as the Player steps to it.
    await expect(moves.nth(1)).toHaveAccessibleName(/^Move 1… e5, (Best|Good|Inaccuracy|Mistake|Blunder)$/);
    await paired.keyboard.press('End');
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', fenAfter(6));
  });

  test('#/board?fen= opens the Board on that position, from the side to move', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent(MATE_IN_ONE)}`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', MATE_IN_ONE);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-orientation', 'white');
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent(blackToMove)}`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', blackToMove);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-orientation', 'black');
  });

  test('a FEN that isn’t a legal position is refused, and the board stays as it was', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    await play(paired, 'e2e4');
    const before = await fenOf(paired, 'Chess board');
    await setUp(paired, '8/8/8/8 w - - 0 1');
    await expect(paired.getByRole('form', { name: 'Set up a position' }).getByRole('alert')).toHaveText(/^That FEN isn’t a legal position/);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', before);
    await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(1);
  });

  test('a #/board?fen= link whose FEN can’t be read opens the form with its error, on the start position', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent('8/8/8/8 w - - 0 1')}`);
    const form = paired.getByRole('form', { name: 'Set up a position' });
    await expect(form.getByRole('alert')).toHaveText(/^That FEN isn’t a legal position/);
    await expect(form.getByRole('textbox')).toHaveValue('8/8/8/8 w - - 0 1');
    await expect(form.getByRole('textbox')).toBeFocused();
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', INITIAL_FEN);
  });

  test('closing the form, with Set up or Cancel, puts focus back on Set up a position', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    const toggle = paired.getByRole('button', { name: 'Set up a position' });
    await toggle.click();
    await expect(paired.getByRole('textbox', { name: /a FEN .* or a PGN/ })).toBeFocused();
    await paired.getByRole('button', { name: 'Cancel' }).click();
    await expect(toggle).toBeFocused();
    await setUp(paired, MATE_IN_ONE);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', MATE_IN_ONE);
    await expect(toggle).toBeFocused();
    // A screen reader hears what was set up, since the board changed out of sight.
    await expect(paired.getByRole('status').filter({ hasText: /set up/ })).toHaveText('Position set up: White to move.');
    await setUp(paired, '1. e4 e5 *');
    await expect(paired.getByRole('status').filter({ hasText: /set up/ })).toHaveText('Game set up at its first position: step through its 2 moves with → and ←.');
  });

  test('New board after a link shows the start position from White’s side, and drops the link from the address', async ({ paired, app }) => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent(blackToMove)}`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-orientation', 'black');
    // The message about an illegal move goes with the position it was about.
    await play(paired, 'e7e4');
    await expect(paired.getByText('That move isn’t legal.')).toBeVisible();
    await paired.getByRole('button', { name: 'New board' }).click();
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', INITIAL_FEN);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-orientation', 'white');
    await expect(paired.getByText('That move isn’t legal.')).toHaveCount(0);
    expect(new URL(paired.url()).hash).toBe('#/board');
    await paired.reload();
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', INITIAL_FEN);
    // The same link opens its position again, and going on to #/board opens a new board, as it always has.
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent(blackToMove)}`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', blackToMove);
    await paired.goto(`${app.url}/#/board`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', INITIAL_FEN);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-orientation', 'white');
    // A position set up after a link drops it from the address too.
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent(blackToMove)}`);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', blackToMove);
    await setUp(paired, MATE_IN_ONE);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', MATE_IN_ONE);
    expect(new URL(paired.url()).hash).toBe('#/board');
  });

  test('a move played on from a dead position gets no Move Grade, and the Board says why', async ({ paired, app }) => {
    const errors: string[] = [];
    paired.on('pageerror', (e) => errors.push(e.message));
    // A king and knight against a king: nobody can mate.
    await paired.goto(`${app.url}/#/board?fen=${encodeURIComponent('8/8/8/4k3/8/8/4K3/5N2 w - - 0 1')}`);
    const result = paired.getByRole('status', { name: 'Result' });
    await expect(result).toHaveText('A draw: neither side has enough pieces left to mate. Moves played from here get no Move Grade.');
    await play(paired, 'e2e3');
    await play(paired, 'e5d5');
    const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
    await expect(moves).toHaveCount(2);
    await expect(moves.first()).toHaveAccessibleName('Move 1. Ke3');
    await expect(result).toHaveText(/^A draw: neither side has enough pieces left to mate/);
    expect(errors).toEqual([]);
  });

  test('playing the pasted game’s own next move steps to it and keeps the rest of the game', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/board`);
    await setUp(paired, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
    const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
    await expect(moves).toHaveCount(6);
    await play(paired, 'e2e4');
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', playUci(INITIAL_FEN, 'e2e4')?.fenAfter ?? '');
    await expect(moves).toHaveCount(6);
    await expect(moves.first()).toHaveAccessibleName(GRADED);
    // Any other move starts a new line from there, as on Lichess.
    await play(paired, 'd7d5');
    await expect(moves).toHaveCount(2);
  });

  test('holding → through a pasted game, the Engine searches only where the Player stops, and each position once', async ({ paired, app }) => {
    // A 49-move Lichess game (a Giuoco Piano).
    const game = (PGN_FIXTURES.split(/\n\n(?=\[Event)/)[0] as string).trim();
    await paired.goto(`${app.url}/#/board`);
    await expect(chancesBar(paired)).toHaveAttribute('aria-valuenow', /\d/);
    await recordSearches(paired);
    await setUp(paired, game);
    const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
    await expect(moves).toHaveCount(49);
    await holdKey(paired, 'ArrowRight', 40);
    await expect(board(paired, 'Chess board')).toHaveAttribute('data-fen', fenOfPly(game, 40));
    await expect(moves.nth(39)).toHaveAccessibleName(GRADED);
    await expect(chancesBar(paired)).toHaveAttribute('aria-valuenow', /\d/);
    // Back one and on again: the move before gets its Move Grade.
    await paired.keyboard.press('ArrowLeft');
    await expect(moves.nth(38)).toHaveAccessibleName(GRADED);
    await paired.keyboard.press('ArrowRight');
    await expect(chancesBar(paired)).toHaveAttribute('aria-valuenow', /\d/);
    const searched = await searches(paired);
    // About three positions (40, 39 and 38), not one for each of the 40 stepped through.
    expect(searched.length).toBeLessThan(10);
    // Each position is searched once: going back to a graded move asks the Engine nothing again.
    expect(new Set(searched).size).toBe(searched.length);
  });
});

const GRADED = /, (Best|Good|Inaccuracy|Mistake|Blunder)$/;

/** Holds a key down as a keyboard repeats it, about 30 times a second, from inside the page so the test's own speed doesn't count. */
async function holdKey(page: Page, key: string, repeats: number): Promise<void> {
  await page.evaluate(
    ([key, repeats]) =>
      new Promise<void>((done) => {
        let n = 0;
        const timer = setInterval(() => {
          (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
          if (++n === repeats) {
            clearInterval(timer);
            done();
          }
        }, 30);
      }),
    [key, repeats] as const,
  );
}

/** The position after `ply` moves of a PGN. */
function fenOfPly(pgn: string, ply: number): string {
  const { startFen, moves } = parseSinglePgn(pgn);
  return moves.slice(0, ply).reduce((fen, uci) => playUci(fen, uci)?.fenAfter ?? fen, startFen);
}

/** Records each position the browser Engine is asked to search, from the commands sent to its Worker. */
async function recordSearches(page: Page): Promise<void> {
  await page.evaluate(() => {
    const searched: string[] = [];
    (window as unknown as { searched: string[] }).searched = searched;
    const post = Worker.prototype.postMessage as (this: Worker, ...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const [command] = args;
      if (typeof command === 'string' && command.startsWith('position fen ')) searched.push(command.slice('position fen '.length));
      post.apply(this, args);
    } as Worker['postMessage'];
  });
}

/** The positions searched since recording began, in order. */
async function searches(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { searched: string[] }).searched]);
}
