// Feature map: Engine Game, Live Coaching and Hints.
import type { Page } from '@playwright/test';
import { INITIAL_FEN, playUci, turnOf } from '../../packages/shared/src/chess.ts';
import { winningChancesFor } from '../../packages/shared/src/winning-chances.ts';
import { CoachClient } from '../../packages/backend/src/client.ts';
import { coachIdle, connection, expect, fenOf, play, resign, square, test } from '../fixtures/app.ts';

const BOARD = 'Engine Game board';
/** A Move Grade symbol on the board, named like "Mistake on g4". */
const GRADE_SYMBOL = /^(Best|Inaccuracy|Mistake|Blunder) on [a-h][1-8]$/;

async function startGame(page: Page, url: string, side: 'White' | 'Black' = 'White', level = 'Beginner'): Promise<void> {
  await page.goto(`${url}/#/engine-game`);
  await page.getByRole('radio', { name: side }).check();
  await page.getByRole('radio', { name: level }).check();
  await page.getByRole('button', { name: 'Start the Engine Game' }).click();
  await expect(page.getByRole('status', { name: 'Game status' })).toContainText(side === 'White' ? 'Your move' : /Your move|thinking/);
}

async function moveAndWaitForReply(page: Page, uci: string, plies: number): Promise<void> {
  await play(page, uci, BOARD);
  await expect(page.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(plies);
  await expect(page.getByRole('status', { name: 'Game status' })).toContainText('Your move');
}

/** Puts an Engine Game in progress on the device, as the app saves it, and opens it: a journey starts from a known position. */
async function resumeGame(page: Page, url: string, playerSide: 'white' | 'black', moves: string[]): Promise<void> {
  await putGameOnDevice(page, url, playerSide, moves);
  await expect(page.getByRole('status', { name: 'Game status' })).toContainText('Your move');
}

/** Saves an Engine Game on the device, as the app does while it is on, with the Move Grades given so far, and opens it. */
async function putGameOnDevice(page: Page, url: string, playerSide: 'white' | 'black', moves: string[], grades: (string | undefined)[] = []): Promise<void> {
  await page.goto(`${url}/#/engine-game`);
  await page.evaluate(
    (game) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('ai-chess-coach', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(game, 'engineGame');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { clientId: `journey-${Date.now()}`, playerSide, strength: 1, moves, grades, live: false, startedAt: new Date().toISOString() },
  );
  await page.reload();
}

test('play to resignation, resume after a reload, save and review the game', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await moveAndWaitForReply(paired, 'e4d5', 4);
  const fen = await fenOf(paired, BOARD);

  await paired.reload();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', fen);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(4);

  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
  const games = await app.rows<{ id: number; kind: string; result: string; player_side: string; moves: string }>('games');
  const saved = games.find((g) => g.kind === 'engine');
  expect(saved).toMatchObject({ result: '0-1', player_side: 'white' });
  expect(saved?.moves.split(' ')).toHaveLength(4);

  await paired.getByRole('link', { name: 'Review this game' }).click();
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  await expect(paired.getByRole('region', { name: 'Key moments' })).toBeVisible();
  const reviews = await app.rows<{ game_id: number }>('reviews');
  expect(reviews.map((r) => r.game_id)).toContain(saved?.id);
});

test('with Threat on, the board shows the Engine’s threat on the Player’s move', async ({ paired, app }) => {
  await startGame(paired, app.url);
  const button = paired.getByRole('button', { name: 'Threat' });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  // After 1.e4 the Engine answers 1...d5 in verify mode, and its pawn attacks e4.
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await expect(paired.getByRole('img', { name: /^Threat: / })).toHaveAccessibleName('Threat: Black threatens dxe4 (d5 to e4)');
  // 2.exd5 takes the pawn and the Engine answers 2...Nf6: the arrow follows, now to the pawn on d5.
  await moveAndWaitForReply(paired, 'e4d5', 4);
  await expect(paired.getByRole('img', { name: /^Threat: / })).toHaveAccessibleName('Threat: Black threatens Nxd5 (f6 to d5)');
});

test('Resign asks first: Keep playing (or Escape) carries on, Yes, resign ends the game', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);

  await paired.getByRole('button', { name: 'Resign' }).click();
  const confirm = paired.getByRole('alertdialog', { name: 'Resign this game?' });
  await expect(confirm).toBeVisible();
  // Focus goes to the safe choice, so a stray Enter does not end the game.
  await expect(confirm.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep playing' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(paired.getByRole('button', { name: 'Resign' })).toBeFocused();

  await paired.getByRole('button', { name: 'Resign' }).click();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  // Escape still keeps playing after a click elsewhere took focus out of the question.
  await paired.getByRole('button', { name: 'Resign' }).click();
  await paired.getByRole('heading', { name: 'Engine Game' }).click();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await moveAndWaitForReply(paired, 'e4d5', 4);
  expect((await app.rows<{ kind: string }>('games')).filter((g) => g.kind === 'engine')).toHaveLength(0);

  await paired.getByRole('button', { name: 'Resign' }).click();
  await confirm.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  // Resign is gone with the game: focus carries on from the end-of-game card, not the page.
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeFocused();
  await expect
    .poll(async () => (await app.rows<{ kind: string; result: string }>('games')).filter((g) => g.kind === 'engine').map((g) => g.result))
    .toEqual(['0-1']);
});

test('New game asks first in the middle of a game: Keep playing (or Escape) carries on', async ({ paired, app }) => {
  // The app's own dialog, never the browser's.
  paired.on('dialog', () => {
    throw new Error('New game used the browser’s confirm()');
  });
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);

  const newGame = paired.getByRole('button', { name: 'New game' });
  const confirm = paired.getByRole('alertdialog', { name: 'Abandon this game?' });
  await newGame.click();
  await expect(confirm.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(newGame).toBeFocused();
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);

  await newGame.click();
  await confirm.getByRole('button', { name: 'Yes, start a new game' }).click();
  await expect(paired.getByRole('form', { name: 'New Engine Game' })).toBeVisible();
  await expect(paired.getByRole('radio', { name: 'White' })).toBeFocused();
  expect((await app.rows<{ kind: string }>('games')).filter((g) => g.kind === 'engine')).toHaveLength(0);
});

test('once the game ends, the board and the controls are cleared: no arrows, no Threat, no empty Coach', async ({ paired, app }) => {
  await startGame(paired, app.url);
  // The Coach panel says what it is for before it has anything to say.
  const coach = paired.getByRole('region', { name: 'Coach' });
  await expect(coach).toContainText('The Coach speaks up when a move is a Mistake or Blunder. Press Hint for a nudge.');
  await paired.getByRole('button', { name: 'Threat' }).click();
  await moveAndWaitForReply(paired, 'e2e4', 2);
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board.getByRole('img', { name: /^Threat: / })).toHaveCount(1);
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
  await expect(board.getByRole('img', { name: /^(Threat: |Arrow )/ })).toHaveCount(0);
  await expect(paired.getByRole('button', { name: 'Threat' })).toHaveCount(0);
  await expect(coach).toHaveCount(0);
});

test('the Engine’s shown move does not stay on the board once the game ends', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board.getByRole('img', { name: /^Arrow .* \(green\)$/ })).toHaveCount(1);
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(board.getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  // The Coach said something in this game, so its panel stays to be read.
  await expect(paired.getByLabel('Coach conversation')).toContainText('The Engine’s move:');
});

test('the game list and the Review name the Engine by the level the Player chose', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await paired.getByRole('link', { name: 'Review this game' }).click();
  await expect(paired.getByText('You vs Engine (Beginner)')).toBeVisible();
  await paired.goto(`${app.url}/#/games`);
  await expect(paired.getByRole('cell', { name: 'Engine (Beginner)', exact: true })).toBeVisible();
});

test('offering a draw early is declined, and the Engine moves first when the Player is Black', async ({ paired, app }) => {
  await startGame(paired, app.url, 'Black');
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(1);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await paired.getByRole('button', { name: 'Offer a draw' }).click();
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
});

test('a small edge in the opening is no reason for the Engine to agree a draw', async ({ paired, app }) => {
  // After 1. e4 the Player as White is a little better: the Engine still plays on.
  await startGame(paired, app.url, 'White', 'Casual');
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await paired.getByRole('button', { name: 'Offer a draw' }).click();
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
});

test('the Engine agrees a draw when it is clearly lost, and the game says Draw agreed', async ({ paired, app }) => {
  // 1. e4 e5 2. Qh5 Qg5 3. Qxg5: the Engine, as Black, is a queen down.
  await resumeGame(paired, app.url, 'white', ['e2e4', 'e7e5', 'd1h5', 'd8g5', 'h5g5']);
  await paired.getByRole('button', { name: 'Offer a draw' }).click();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Draw agreed.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeFocused();
  await expect
    .poll(async () => (await app.rows<{ kind: string; result: string }>('games')).filter((g) => g.kind === 'engine').map((g) => g.result))
    .toEqual(['1/2-1/2']);
});

test('a position that occurs a third time ends the game in a draw', async ({ paired, app }) => {
  // Both knights out and back twice; the Player, as Black, brings theirs home a second time.
  await resumeGame(paired, app.url, 'black', ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']);
  await play(paired, 'f6g8', BOARD);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Draw by threefold repetition.');
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(8);
  await expect
    .poll(async () => (await app.rows<{ kind: string; result: string }>('games')).filter((g) => g.kind === 'engine').map((g) => g.result))
    .toEqual(['1/2-1/2']);
});

test('a game over on the board but not yet saved as over (the app closed in between) ends when it is opened', async ({ paired, app }) => {
  const errors: string[] = [];
  paired.on('pageerror', (e) => errors.push(e.message));
  // 1. f3 e5 2. g4 Qh4#: the Player, as Black, mated with a move already graded; the result wasn't saved.
  await putGameOnDevice(paired, app.url, 'black', ['f2f3', 'e7e5', 'g2g4', 'd8h4'], [undefined, undefined, undefined, 'Best']);
  const status = paired.getByRole('status', { name: 'Game status' });
  await expect(status).toContainText('You won by checkmate.');
  await expect(tally(paired).first()).toHaveText('★ 1 Best');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
  await expect
    .poll(async () => (await app.rows<{ kind: string; result: string }>('games')).filter((g) => g.kind === 'engine').map((g) => g.result))
    .toEqual(['0-1']);

  // The same moves with the Player as White: the Engine mated them, and the board has no move for the Player.
  await putGameOnDevice(paired, app.url, 'white', ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  await expect(status).toContainText('The Engine won by checkmate.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('throwing a won game into a threefold repetition is a Blunder, and the drawn board reads level', async ({ paired, app }) => {
  // 1. e4 e5 2. Qh5 Qg5 3. Qxg5, then both knights out and back twice: White, the Player, is a
  // queen up, and 7. Ng1 brings the same position a third time.
  await resumeGame(paired, app.url, 'white', ['e2e4', 'e7e5', 'd1h5', 'd8g5', 'h5g5', 'b8c6', 'g1f3', 'c6b8', 'f3g1', 'b8c6', 'g1f3', 'c6b8']);
  await play(paired, 'f3g1', BOARD);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Draw by threefold repetition.');
  await expect(paired.getByRole('button', { name: 'Move 7. Ng1, Blunder' })).toBeVisible();
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 50%');
});

test('the move that ends the game gets its Move Grade too', async ({ paired, app }) => {
  // 1. f3 e5 2. g4: the Player, as Black, mates with Qh4.
  await resumeGame(paired, app.url, 'black', ['f2f3', 'e7e5', 'g2g4']);
  await play(paired, 'd8h4', BOARD);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('You won by checkmate.');
  await expect(paired.getByRole('button', { name: 'Move 2… Qh4#, Best' })).toBeVisible();
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Best on h4' })).toBeVisible();
  // The end-of-game card counts only the Move Grades the game has: 1…e5 came in ungraded.
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('2 moves · You played Black · Engine: Beginner');
  await expect(tally(paired)).toHaveText(['★ 1 Best', '✓ 0 Good', '?! 0 Inaccuracies', '? 0 Mistakes', '?? 0 Blunders']);
  // The symbols are in the page, so every browser draws them, but hidden from screen readers: the words say the same.
  await expect(tally(paired).locator('[aria-hidden="true"]')).toHaveText(['★', '✓', '?!', '?', '??']);
});

/** The end-of-game card's count of the Player's Move Grades, one item per grade. */
function tally(page: Page) {
  return page.getByRole('list', { name: 'Your Move Grades in this game' }).getByRole('listitem');
}

/** Each tally item's contrast ratio (WCAG): its text against its pill, or against the card where the pill is clear. */
function tallyContrast(page: Page): Promise<{ text: string; ratio: number }[]> {
  return tally(page).evaluateAll((items) => {
    const rgba = (css: string) => {
      const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
      return { rgb: [r, g, b], a };
    };
    const over = (top: number[], alpha: number, under: number[]) => top.map((v, i) => alpha * v + (1 - alpha) * under[i]!);
    const luminance = (rgb: number[]) =>
      rgb
        .map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    return items.map((li) => {
      let behind = li.parentElement;
      while (behind && rgba(getComputedStyle(behind).backgroundColor).a === 0) behind = behind.parentElement;
      const card = rgba(getComputedStyle(behind ?? document.body).backgroundColor).rgb;
      const style = getComputedStyle(li);
      const pill = rgba(style.backgroundColor);
      const text = rgba(style.color);
      const opacity = Number(style.opacity);
      const pillOnCard = over(pill.rgb, pill.a, card);
      const bg = over(pillOnCard, opacity, card);
      const fg = over(over(text.rgb, text.a, pillOnCard), opacity, card);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
      return { text: li.textContent?.trim() ?? '', ratio: Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100 };
    });
  });
}

test('the end-of-game card’s counts read clearly in light and dark: zero counts too meet WCAG AA contrast', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await expect(tally(paired)).toHaveCount(5);
  await expect(tally(paired).filter({ hasText: /\b0\b/ })).toHaveCount(4);
  for (const colorScheme of ['light', 'dark'] as const) {
    await paired.emulateMedia({ colorScheme });
    for (const { text, ratio } of await tallyContrast(paired)) {
      expect.soft(ratio, `${colorScheme}: "${text}" against its background`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('a finished game ends on one card: the result, how the Player’s moves were graded, Review this game and New game', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await moveAndWaitForReply(paired, 'e4d5', 4);
  // The card counts what the move list shows for the Player's moves.
  const names = await paired.getByRole('list', { name: 'Moves' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const graded = names.filter((n) => /^Move \d+\. /.test(n)).map((n) => /, (\w+)$/.exec(n)?.[1]);
  expect(graded).toHaveLength(2);
  const count = (g: string) => graded.filter((x) => x === g).length;
  await resign(paired);
  const status = paired.getByRole('status', { name: 'Game status' });
  await expect(status).toContainText('The Engine won by resignation.');
  await expect(status).toContainText('2 moves · You played White · Engine: Beginner');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  await expect(tally(paired)).toHaveText([
    `★ ${count('Best')} Best`,
    `✓ ${count('Good')} Good`,
    `?! ${plural(count('Inaccuracy'), 'Inaccuracy', 'Inaccuracies')}`,
    `? ${plural(count('Mistake'), 'Mistake', 'Mistakes')}`,
    `?? ${plural(count('Blunder'), 'Blunder', 'Blunders')}`,
  ]);
  // One New game, on the card; the toolbar keeps the step buttons.
  const card = status.locator('xpath=..');
  await expect(paired.getByRole('button', { name: 'New game' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'New game' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Review this game' })).toBeVisible();
  // The card's actions sit outside the status region: a screen reader reads the result and the
  // tally once, and not the whole card again when the Review link arrives.
  await expect(status.getByRole('link')).toHaveCount(0);
  await expect(status.getByRole('button')).toHaveCount(0);
  await card.getByRole('link', { name: 'Review this game' }).click();
  await expect(paired.getByRole('button', { name: 'Start the Review' })).toBeVisible();
});

test('on a phone, the end-of-game card sits right under the board, Review this game in view', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeInViewport();
  await expect(tally(paired).last()).toBeInViewport();
  const board = await paired.getByRole('group', { name: BOARD }).boundingBox();
  const card = await paired.getByRole('status', { name: 'Game status' }).boundingBox();
  expect(card && board && card.y > board.y + board.height).toBe(true);
});

test('a finished game still offers its Review after a reload, and its New game starts a fresh one', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
  const href = await paired.getByRole('link', { name: 'Review this game' }).getAttribute('href');
  await paired.reload();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByRole('link', { name: 'Review this game' })).toHaveAttribute('href', href ?? '');

  // The card's New game starts a fresh game.
  await paired.getByRole('button', { name: 'New game' }).click();
  await expect(paired.getByRole('form', { name: 'New Engine Game' })).toBeVisible();
  // The button is gone with the game: focus carries on from the form's first control.
  await expect(paired.getByRole('radio', { name: 'White' })).toBeFocused();
  await paired.getByRole('radio', { name: 'White' }).check();
  await paired.getByRole('button', { name: 'Start the Engine Game' }).click();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(0);
  await expect(paired.getByRole('link', { name: 'Review this game' })).toHaveCount(0);
  await expect(tally(paired)).toHaveCount(0);
});

test('a finished game deleted from the game list: Review this game says so and leads back to the menu', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();

  await paired.goto(`${app.url}/#/games`);
  const row = paired.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'Engine (Beginner)' });
  await row.getByRole('button', { name: /^More: / }).click();
  await row.getByRole('button', { name: 'Delete game' }).click();
  await paired.getByRole('alertdialog').getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(row).toHaveCount(0);

  // This device still holds the finished game, so its card still offers the Review.
  await paired.goto(`${app.url}/#/engine-game`);
  await paired.getByRole('link', { name: 'Review this game' }).click();
  await expect(paired.getByRole('alert')).toHaveText('That game is not in your game list.');
  await paired.getByRole('link', { name: 'Back to the menu' }).click();
  await expect(paired.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
});

test('once the game ends, a declined draw is no longer reported', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await paired.getByRole('button', { name: 'Offer a draw' }).click();
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByText('The Engine declines the draw.')).toHaveCount(0);
});

test('a finished game’s board is read-only: clicks there say nothing about illegal moves', async ({ paired, app }) => {
  await startGame(paired, app.url);
  // A piece picked up before the game ends does not stay picked up afterwards.
  await square(paired, 'e2', BOARD).click();
  await expect(square(paired, 'e2', BOARD)).toHaveAttribute('aria-pressed', 'true');
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(square(paired, 'e2', BOARD)).toHaveAttribute('aria-pressed', 'false');
  await square(paired, 'e4', BOARD).click();
  await square(paired, 'g1', BOARD).click();
  await square(paired, 'f3', BOARD).click();
  await expect(paired.getByText(/isn’t legal|not your move/)).toHaveCount(0);
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
});

test('a finished game steps through its moves, with the buttons or the arrow keys; a game in progress stays on the board', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  const live = await fenOf(paired, BOARD);
  // While the game is on, the board always shows the position to play from.
  await expect(paired.getByRole('button', { name: 'Previous move' })).toHaveCount(0);
  await paired.keyboard.press('ArrowLeft');
  await paired.keyboard.press('Home');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', live);

  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  const afterE4 = playUci(INITIAL_FEN, 'e2e4')?.fenAfter as string;
  await paired.keyboard.press('ArrowLeft');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', afterE4);
  // The Move Grade symbol follows the steps too: 1.e4 is the Engine's best in verify mode.
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Best on e4' })).toBeVisible();
  await paired.keyboard.press('Home');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: GRADE_SYMBOL })).toHaveCount(0);
  await paired.getByRole('button', { name: 'Last position' }).click();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', live);
  await paired.getByRole('button', { name: /^Move 1\. e4/ }).click();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', afterE4);
});

test.describe('Live Coaching', () => {
  test('a Mistake gets one comment and can be taken back; a Best move gets none', async ({ paired, app }) => {
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    await expect(paired.getByRole('button', { name: 'Take the move back' })).toBeVisible();
    await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Mistake on g4' })).toBeVisible();
    await coachIdle(paired);
    await expect(paired.getByLabel('Coach conversation')).toContainText('g4 is graded Mistake');
    let calls = await app.rows<{ job: string; model: string }>('coach_calls');
    expect(calls.map((c) => c.job)).toEqual(['live']);
    expect(calls[0]?.model).toBe('haiku');

    await paired.getByRole('button', { name: 'Take the move back' }).click();
    await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
    await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: GRADE_SYMBOL })).toHaveCount(0);

    await moveAndWaitForReply(paired, 'e2e4', 2);
    // The Player's last graded move keeps its symbol after the Engine replies.
    await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Best on e4' })).toBeVisible();
    calls = await app.rows('coach_calls');
    expect(calls).toHaveLength(1);
  });

  test('on a phone, the choice to take a Mistake back is on screen without scrolling', async ({ paired, app }) => {
    await paired.setViewportSize({ width: 390, height: 844 });
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    const status = paired.getByRole('status', { name: 'Game status' });
    await expect(status).toContainText('Take the move back, or carry on?');
    await expect(status.getByRole('button', { name: 'Take the move back' })).toBeInViewport();
    await expect(status.getByRole('button', { name: 'Carry on' })).toBeInViewport();
    expect(await paired.evaluate(() => window.scrollY)).toBe(0);
    // The Coach's comment comes straight after, before the move list, with at least its first line
    // on screen however long the reply is.
    await coachIdle(paired);
    await expect(paired.getByLabel('Coach conversation')).toContainText('g4 is graded Mistake');
    const comment = (await paired.getByLabel('Coach conversation').boundingBox())!;
    const moves = (await paired.getByRole('list', { name: 'Moves' }).boundingBox())!;
    expect(comment.y).toBeLessThan(moves.y);
    expect(comment.y + 24).toBeLessThanOrEqual(844);
  });

  test('the takeback offer survives a reload, and the Engine waits for the Player’s choice', async ({ paired, app }) => {
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    await expect(paired.getByRole('button', { name: 'Take the move back' })).toBeVisible();
    await coachIdle(paired);

    await paired.reload();
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Take the move back, or carry on?');
    await expect(paired.getByRole('button', { name: 'Take the move back' })).toBeVisible();
    await expect(paired.getByLabel('Coach conversation')).toContainText('g4 is graded Mistake');
    // Long enough for the Engine to have replied if it were going to.
    await paired.waitForTimeout(1500);
    await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(1);
    expect(await app.rows('coach_calls')).toHaveLength(1);

    await paired.getByRole('button', { name: 'Carry on' }).click();
    await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
    // Once answered, the offer stays answered after another reload.
    await paired.reload();
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
    await expect(paired.getByRole('button', { name: 'Take the move back' })).toHaveCount(0);
  });

  test('switched off for this game, a Mistake is still graded but the Coach says nothing', async ({ paired, app }) => {
    await startGame(paired, app.url);
    await paired.getByRole('checkbox', { name: 'Live Coaching in this game' }).uncheck();
    await moveAndWaitForReply(paired, 'g2g4', 2);
    await expect(paired.getByRole('button', { name: 'Move 1. g4, Mistake' })).toBeVisible();
    const symbols = paired.getByRole('group', { name: BOARD }).getByRole('img', { name: GRADE_SYMBOL });
    await expect(symbols).toHaveCount(1);
    await expect(symbols).toHaveAccessibleName('Mistake on g4');
    await moveAndWaitForReply(paired, 'e2e4', 4);
    await expect(paired.getByRole('button', { name: /^Move 2\. e4, \w+/ })).toBeVisible();
    // Only the Player's latest move carries a symbol (none if it is Good).
    await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Mistake on g4' })).toHaveCount(0);
    await expect(symbols).toHaveCount((await paired.getByRole('button', { name: 'Move 2. e4, Good' }).count()) ? 0 : 1);
    expect(await app.rows('coach_calls')).toHaveLength(0);
  });

  test('switched off by default in Settings, new games start without it', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    await paired.getByRole('checkbox', { name: 'Live Coaching on by default in Engine Games' }).uncheck();
    await expect.poll(async () => (await app.rows<{ value: string }>('settings')).map((r) => r.value).join()).toContain('false');
    await startGame(paired, app.url);
    await expect(paired.getByRole('checkbox', { name: 'Live Coaching in this game' })).not.toBeChecked();
    await moveAndWaitForReply(paired, 'g2g4', 2);
    await expect(paired.getByRole('button', { name: 'Move 1. g4, Mistake' })).toBeVisible();
    expect(await app.rows('coach_calls')).toHaveLength(0);
  });

  test('the model chosen in Settings is the one the Coach receives', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    await paired.getByText('Advanced', { exact: true }).click();
    await paired.getByLabel('Model for Live Coaching').selectOption('opus');
    await expect.poll(async () => JSON.stringify(await app.rows('settings'))).toContain('opus');
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    await expect(paired.getByRole('button', { name: 'Take the move back' })).toBeVisible();
    const calls = await app.rows<{ job: string; model: string }>('coach_calls');
    expect(calls.map((c) => [c.job, c.model])).toEqual([['live', 'opus']]);
  });

  test('two Coach-model changes in the same instant are both saved', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    await paired.getByText('Advanced', { exact: true }).click();
    const live = paired.getByLabel('Model for Live Coaching');
    const why = paired.getByLabel('Model for Why Questions');
    await expect(live).toHaveValue('haiku');
    // Both changes happen in one task, so both leave before either answer comes back.
    await paired.evaluate(() => {
      const change = (label: string, value: string): void => {
        const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
        if (!select) throw new Error(`No ${label}`);
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      change('Model for Live Coaching', 'opus');
      change('Model for Why Questions', 'haiku');
    });
    await expect(paired.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const savedModels = async (): Promise<unknown> => {
      const row = (await app.rows<{ key: string; value: string }>('settings')).find((r) => r.key === 'models');
      return row ? JSON.parse(row.value) : {};
    };
    await expect.poll(savedModels).toMatchObject({ live: 'opus', why: 'haiku' });
    await paired.reload();
    await paired.getByText('Advanced', { exact: true }).click();
    await expect(live).toHaveValue('opus');
    await expect(why).toHaveValue('haiku');
  });
});

test('the first Hint gives the idea with no move, the second shows the desktop Engine’s move', async ({ paired, app }) => {
  // Watch what the page asks the desktop, from a fresh connection.
  const sent: { type: string; fen?: string }[] = [];
  paired.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(JSON.parse(String(f.payload)))));
  await paired.reload();
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await startGame(paired, app.url);
  // Even if the Coach names a move in a Hint, it never reaches the board.
  await app.script({ kind: 'reply', reply: { text: 'Think about the centre.', moves: ['e2e4'], arrows: [{ uci: 'e2e4', brush: 'green' }], highlights: ['e4'] } });
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  await expect(paired.getByLabel('Coach conversation')).toContainText('Think about the centre.');
  await expect(paired.getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  const [call] = await app.rows<{ job: string; brief: string }>('coach_calls');
  expect(call?.job).toBe('hint');

  await paired.getByRole('button', { name: 'Show the move' }).click();
  await expect(paired.getByRole('img', { name: /^Arrow \w\d to \w\d \(green\)$/ })).toHaveCount(1);
  await expect(paired.getByLabel('Coach conversation')).toContainText('The Engine’s move:');
  expect(await app.rows('coach_calls')).toHaveLength(1);
  // The move comes from the desktop's Engine, like the facts behind the first Hint (ADR 0007).
  expect(sent).toContainEqual(expect.objectContaining({ type: 'engine.analyse', fen: INITIAL_FEN }));
});

test('Show the move adds the Engine’s move to the Coach log once per position', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await paired.getByRole('button', { name: 'Hint' }).click();
  await coachIdle(paired);
  const engineMove = paired.getByLabel('Coach conversation').getByText(/The Engine’s move:/);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await expect(engineMove).toHaveCount(1);
  await paired.getByRole('button', { name: 'Show the move' }).click();
  await paired.getByRole('button', { name: 'Show the move' }).dblclick();
  // Long enough for another analysis from the desktop to have come back.
  await paired.waitForTimeout(1000);
  await expect(engineMove).toHaveCount(1);
  await expect(paired.getByRole('img', { name: /^Arrow \w\d to \w\d \(green\)$/ })).toHaveCount(1);
});

test('the Winning Chances bar follows an Engine Game from the browser Engine, the Player’s side at the bottom', async ({ paired, app }) => {
  const bar = paired.getByRole('meter', { name: /^Winning Chances bar/ });
  await startGame(paired, app.url);
  await expect(bar).toHaveAccessibleName('Winning Chances bar: White’s winning chances: 53%');
  await moveAndWaitForReply(paired, 'e2e4', 2);
  // The same verdict as the desktop's Engine on the same position (ADR 0007: one Engine build).
  const fen = await fenOf(paired, BOARD);
  const desktop = await CoachClient.connect(app.url, app.token);
  try {
    const top = (await desktop.request('engine.analyse', { fen })).lines[0];
    if (!top) throw new Error(`No Engine line for ${fen}`);
    await expect(bar).toHaveAccessibleName(`Winning Chances bar: ${winningChancesFor(top.score, turnOf(fen), 'white').text}`);
  } finally {
    await desktop.close();
  }
  expect(await app.rows('coach_calls')).toHaveLength(0);

  // Playing Black, the Player's side is at the bottom of the board and of the bar.
  await paired.getByRole('button', { name: 'New game' }).click();
  await paired.getByRole('alertdialog', { name: 'Abandon this game?' }).getByRole('button', { name: 'Yes, start a new game' }).click();
  await startGame(paired, app.url, 'Black');
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await expect(bar).toHaveAccessibleName(/^Winning Chances bar: Black’s winning chances: \d+%$/);
  await expect(bar.getByTestId('bar-fill')).toHaveAttribute('data-side', 'black');
});
