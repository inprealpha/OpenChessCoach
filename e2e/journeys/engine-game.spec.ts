// Feature map: Engine Game, Live Coaching and Hints.
import type { Page } from '@playwright/test';
import { INITIAL_FEN, playUci, turnOf } from '../../packages/shared/src/chess.ts';
import { winningChancesFor } from '../../packages/shared/src/winning-chances.ts';
import { CoachClient } from '../../packages/backend/src/client.ts';
import { coachIdle, connection, expect, fenOf, gameMenu, play, resign, square, storedOnDevice, test } from '../fixtures/app.ts';

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

  await gameMenu(paired, 'Resign');
  const confirm = paired.getByRole('alertdialog', { name: 'Resign this game?' });
  await expect(confirm).toBeVisible();
  // Focus goes to the safe choice, so a stray Enter does not end the game.
  await expect(confirm.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep playing' }).click();
  await expect(confirm).toHaveCount(0);
  // Focus goes back to the menu Resign was picked from.
  await expect(paired.getByRole('button', { name: 'Game options' })).toBeFocused();

  await gameMenu(paired, 'Resign');
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  // Escape still keeps playing after a click elsewhere took focus out of the question.
  await gameMenu(paired, 'Resign');
  await paired.getByRole('heading', { name: 'Engine Game' }).click();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await moveAndWaitForReply(paired, 'e4d5', 4);
  expect((await app.rows<{ kind: string }>('games')).filter((g) => g.kind === 'engine')).toHaveLength(0);

  await gameMenu(paired, 'Resign');
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

  // New game sits in the ⋯ Game menu, away from Hint; focus comes back to the menu's button.
  const menu = paired.getByRole('button', { name: 'Game options' });
  const confirm = paired.getByRole('alertdialog', { name: 'Abandon this game?' });
  await gameMenu(paired, 'New game');
  await expect(confirm.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await paired.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(menu).toBeFocused();
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);

  await gameMenu(paired, 'New game');
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
  await expect(board.getByRole('img', { name: /^Arrow .* \(best\)$/ })).toHaveCount(1);
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(board.getByRole('img', { name: /^Arrow / })).toHaveCount(0);
  // Nothing the Coach said during play stays once the game is over: the card says how it went.
  await expect(paired.getByRole('region', { name: 'Coach' })).toHaveCount(0);
  await expect(paired.getByText('The Engine’s move:')).toHaveCount(0);
});

test('the game list and the Review name the Engine by the level the Player chose', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await resign(paired);
  await paired.getByRole('link', { name: 'Review this game' }).click();
  await expect(paired.getByTestId('review-summary')).toContainText('You had White · Lost 0-1 · vs Engine (Beginner)');
  await paired.goto(`${app.url}/#/games`);
  await expect(paired.getByRole('cell', { name: 'Engine (Beginner)', exact: true })).toBeVisible();
});

test('offering a draw early is declined, and the Engine moves first when the Player is Black', async ({ paired, app }) => {
  await startGame(paired, app.url, 'Black');
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(1);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await gameMenu(paired, 'Offer a draw');
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
});

test('a small edge in the opening is no reason for the Engine to agree a draw', async ({ paired, app }) => {
  // After 1. e4 the Player as White is a little better: the Engine still plays on.
  await startGame(paired, app.url, 'White', 'Casual');
  await moveAndWaitForReply(paired, 'e2e4', 2);
  await gameMenu(paired, 'Offer a draw');
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
});

test('the Engine agrees a draw when it is clearly lost, and the game says Draw agreed', async ({ paired, app }) => {
  // 1. e4 e5 2. Qh5 Qg5 3. Qxg5: the Engine, as Black, is a queen down.
  await resumeGame(paired, app.url, 'white', ['e2e4', 'e7e5', 'd1h5', 'd8g5', 'h5g5']);
  await gameMenu(paired, 'Offer a draw');
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
  await expect(status).toContainText('2 moves · no Mistakes');
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
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('2 moves · no Mistakes');
});

test('the end-of-game card sums the game up in one line: the Move Grades that need a look, the worst first', async ({ paired, app }) => {
  // Four of the Player's moves graded as given, one never graded (a reload came first), then resign.
  const moves = ['g2g4', 'e7e5', 'f2f4', 'd7d5', 'a2a3', 'b8c6', 'h2h3', 'g8f6', 'b2b3', 'c8e6'];
  await putGameOnDevice(paired, app.url, 'white', moves, ['Mistake', undefined, 'Blunder', undefined, undefined, undefined, 'Blunder', undefined, 'Inaccuracy']);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await resign(paired);
  // Only the Move Grades the game has are counted (ADR 0002); nothing is judged anew.
  await expect(paired.getByRole('status', { name: 'Game status' })).toHaveText('The Engine won by resignation. 5 moves · 2 Blunders, 1 Mistake, 1 Inaccuracy');
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
  // The result, then one line: the moves played and the Move Grades that need a look, as the move list shows them.
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const needLook = (
    [
      ['Blunder', 'Blunders'],
      ['Mistake', 'Mistakes'],
      ['Inaccuracy', 'Inaccuracies'],
    ] as const
  )
    .filter(([one]) => count(one))
    .map(([one, many]) => plural(count(one), one, many));
  await expect(status).toHaveText(`The Engine won by resignation. 2 moves · ${needLook.length ? needLook.join(', ') : 'no Mistakes'}`);
  // One New game, on the card under Review this game; the thumb bar keeps the step buttons.
  const card = status.locator('xpath=..');
  await expect(paired.getByRole('button', { name: 'New game' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'New game' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Review this game' })).toBeVisible();
  const top = async (l: ReturnType<typeof card.getByRole>) => (await l.boundingBox())?.y ?? NaN;
  const order = [await top(status.getByText('The Engine won by resignation.')), await top(status.getByText(/^2 moves · /)), await top(card.getByRole('link', { name: 'Review this game' }))];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // The card's actions sit outside the status region: a screen reader reads the result and the
  // summary once, and not the whole card again when the Review link arrives.
  await expect(status.getByRole('link')).toHaveCount(0);
  await expect(status.getByRole('button')).toHaveCount(0);
  await card.getByRole('link', { name: 'Review this game' }).click();
  await expect(paired.getByRole('button', { name: 'Start the Review' })).toBeVisible();
});

/** Ways a game ends, each with the Move Grades that make its summary line long. */
const ENDINGS = [
  {
    // Eleven moves in, so the move list under the card has rows to scroll to; the Player resigns.
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6', 'e1g1', 'e8g8', 'f1e1', 'a7a6', 'c4b3', 'c5a7', 'h2h3', 'h7h6', 'b1d2', 'f8e8', 'd2f1', 'c8e6'],
    playerGrades: ['Blunder', 'Best', 'Mistake', 'Best', 'Good', 'Inaccuracy', 'Blunder', 'Good', 'Mistake', 'Inaccuracy', 'Best'],
    resign: true,
    headline: 'The Engine won by resignation.',
    summary: '11 moves · 2 Blunders, 2 Mistakes, 2 Inaccuracies',
  },
  {
    // 1. f3 e5 2. g4 Qh4#: over on the board when it is opened.
    moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
    playerGrades: ['Inaccuracy', 'Blunder'],
    resign: false,
    headline: 'The Engine won by checkmate.',
    summary: '2 moves · 1 Blunder, 1 Inaccuracy',
  },
  {
    // Both knights out and back twice: the starting position a third time.
    moves: ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'],
    playerGrades: ['Blunder', 'Mistake', 'Mistake', 'Inaccuracy'],
    resign: false,
    headline: 'Draw by threefold repetition.',
    summary: '4 moves · 1 Blunder, 2 Mistakes, 1 Inaccuracy',
  },
] as const;

/** How the end-of-game card's text is set: the app's fonts, a wider one, and the wider one with the result and the summary forced onto two lines each. */
const CARD_TEXT = {
  'the app’s font': '',
  'a wide font': '* { font-family: "DejaVu Sans", Verdana, sans-serif !important; }',
  'a wide font, the result and the summary on two lines each':
    '* { font-family: "DejaVu Sans", Verdana, sans-serif !important; } .game-status .live > p::after { content: "\\A ·"; white-space: pre; }',
} as const;

// Safari's visible area on current iPhones: an iPhone 13 (390×664), 16 Pro (402×714), 16 Pro Max
// (440×790) and a taller 390×844. The longest results and summaries, in the app's fonts and in a
// wider one (DejaVu Sans, as on a Linux runner, where the card once came out 20 px too tall), and
// with room to spare when a font wraps the result and the summary onto two lines each.
for (const [width, height] of [[390, 664], [402, 714], [440, 790], [390, 844]] as const) {
  for (const [text, css] of Object.entries(CARD_TEXT)) {
    test(`on a phone at ${width}×${height} in ${text}, the end-of-game card sits under the board, all of it in the first screen`, async ({ paired, app }) => {
      await paired.setViewportSize({ width, height });
      if (css)
        await paired.addInitScript((rules) => {
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = rules;
            document.head.append(style);
          });
        }, css);
      for (const ending of ENDINGS) {
        const grades = ending.moves.map((_, i) => (i % 2 ? undefined : ending.playerGrades[i / 2]));
        await putGameOnDevice(paired, app.url, 'white', [...ending.moves], grades);
        const status = paired.getByRole('status', { name: 'Game status' });
        if (ending.resign) {
          await expect(status).toContainText('Your move');
          await resign(paired);
        }
        await expect(status).toContainText(ending.headline);
        await expect(paired.getByRole('link', { name: 'Review this game' })).toBeVisible();
        const card = status.locator('xpath=..');
        for (const part of [
          status.getByText(ending.headline),
          status.getByText(ending.summary),
          card.getByRole('link', { name: 'Review this game' }),
          card.getByRole('button', { name: 'New game' }),
        ]) {
          await expect(part, `${ending.headline} ${part}`).toBeInViewport({ ratio: 1 });
        }
        expect(await paired.evaluate(() => window.scrollY)).toBe(0);
        const board = await paired.getByRole('group', { name: BOARD }).boundingBox();
        const shown = await status.boundingBox();
        expect(shown && board && shown.y > board.y + board.height).toBe(true);
      }
    });
  }
}

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
  await expect(paired.getByText(/^\d+ moves? · /)).toHaveCount(0);
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
  await gameMenu(paired, 'Offer a draw');
  await expect(paired.getByText('The Engine declines the draw.')).toBeVisible();
  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  await expect(paired.getByText('The Engine declines the draw.')).toHaveCount(0);
});

test('a finished game’s board drops a piece picked up during the game, and a move there is a variation', async ({ paired, app }) => {
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
  // The finished game is explored on a variation of its own (explore.spec.ts); the game stays as it was.
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', playUci(INITIAL_FEN, 'g1f3')?.fenAfter ?? '');
  await paired.getByRole('button', { name: 'Back to the game' }).click();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
});

test('an Engine Game steps through its moves during play and once it is over, with the buttons or the arrow keys', async ({ paired, app }) => {
  await startGame(paired, app.url);
  await moveAndWaitForReply(paired, 'e2e4', 2);
  const live = await fenOf(paired, BOARD);
  const board = paired.getByRole('group', { name: BOARD });
  const afterE4Now = playUci(INITIAL_FEN, 'e2e4')?.fenAfter as string;
  // During play the steps show earlier positions; the game stays where it is.
  await paired.keyboard.press('ArrowLeft');
  await expect(board).toHaveAttribute('data-fen', afterE4Now);
  await expect(awayBar(paired)).toContainText('Looking at move 1');
  await paired.getByRole('button', { name: 'First position' }).click();
  await expect(board).toHaveAttribute('data-fen', INITIAL_FEN);
  // The game's own next move, played on an earlier position, steps to it: no line of the Player's own.
  await play(paired, 'e2e4', BOARD);
  await expect(board).toHaveAttribute('data-fen', afterE4Now);
  await expect(awayBar(paired)).toContainText('Looking at move 1');
  await paired.keyboard.press('End');
  await expect(board).toHaveAttribute('data-fen', live);
  await expect(awayBar(paired)).toHaveCount(0);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button')).toHaveCount(2);
  expect(((await storedOnDevice(paired, 'engineGame')) as { moves: string[] }).moves).toHaveLength(2);
  // Stepping back and on again leaves the game to carry on from its latest position.
  await paired.getByRole('button', { name: 'Previous move' }).click();
  await paired.getByRole('button', { name: 'Next move' }).click();
  await expect(awayBar(paired)).toHaveCount(0);
  await moveAndWaitForReply(paired, 'e4d5', 4);
  const finalFen = await fenOf(paired, BOARD);

  await resign(paired);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
  const afterE4 = afterE4Now;
  await paired.keyboard.press('Home');
  await paired.keyboard.press('ArrowRight');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', afterE4);
  // The Move Grade symbol follows the steps too: 1.e4 is the Engine's best in verify mode.
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: 'Best on e4' })).toBeVisible();
  await paired.keyboard.press('Home');
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', INITIAL_FEN);
  await expect(paired.getByRole('group', { name: BOARD }).getByRole('img', { name: GRADE_SYMBOL })).toHaveCount(0);
  await paired.getByRole('button', { name: 'Last position' }).click();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', finalFen);
  await paired.getByRole('button', { name: /^Move 1\. e4/ }).click();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', afterE4);
});

test('the arrow keys leave the board alone while the Game options menu is open', async ({ paired, app }) => {
  // Found by the break-it pass: ← with the menu open stepped the board back behind it.
  await resumeGame(paired, app.url, 'white', ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const live = await fenOf(paired, BOARD);
  await paired.getByRole('button', { name: 'Game options' }).click();
  await expect(paired.getByRole('menu', { name: 'Game options' })).toBeVisible();
  for (const key of ['ArrowLeft', 'Home', 'ArrowUp']) await paired.keyboard.press(key);
  await expect(paired.getByRole('menu', { name: 'Game options' })).toBeVisible();
  await expect(paired.getByRole('group', { name: BOARD })).toHaveAttribute('data-fen', live);
  await expect(paired.getByRole('group', { name: 'Away from the game' })).toHaveCount(0);
  // Closed, the keys step again.
  await paired.keyboard.press('Escape');
  await paired.keyboard.press('ArrowLeft');
  await expect(paired.getByRole('group', { name: 'Away from the game' })).toContainText('Looking at move 2');
});

/** The bar at the top of the panel while the board is away from the game's latest position. */
function awayBar(page: Page) {
  return page.getByRole('group', { name: 'Away from the game' });
}

/**
 * Holds the browser's Engine: while held, the commands to its Worker wait, and `release` sends them
 * in order. A journey can then look back or try a line while the Engine is still to reply.
 */
async function holdBrowserEngine(page: Page): Promise<{ release: () => Promise<void> }> {
  await page.evaluate(() => {
    const w = window as unknown as { engineHeld: [Worker, unknown[]][] | null };
    w.engineHeld = [];
    const post = Worker.prototype.postMessage as (this: Worker, ...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if (w.engineHeld) w.engineHeld.push([this, args]);
      else post.apply(this, args);
    } as Worker['postMessage'];
    (window as unknown as { releaseEngine: () => void }).releaseEngine = () => {
      const held = w.engineHeld ?? [];
      w.engineHeld = null;
      for (const [worker, args] of held) post.apply(worker, args);
    };
  });
  return { release: () => page.evaluate(() => (window as unknown as { releaseEngine: () => void }).releaseEngine()) };
}

/** The position after the given moves from the start. */
function fenAfter(moves: string[]): string {
  return moves.reduce((fen, uci) => playUci(fen, uci)?.fenAfter ?? fen, INITIAL_FEN);
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

const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];

test('if the Engine moves while the Player looks back, the board stays put and the bar says what it played', async ({ paired, app }) => {
  await resumeGame(paired, app.url, 'white', ITALIAN);
  await paired.getByRole('button', { name: 'Threat' }).click();
  const engine = await holdBrowserEngine(paired);
  await play(paired, 'f1c4', BOARD);
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine is thinking');
  // Back to the position after 1… e5, while the Engine is still to reply to 3. Bc4.
  for (let i = 0; i < 3; i++) await paired.keyboard.press('ArrowLeft');
  const looked = fenAfter(ITALIAN.slice(0, 2));
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board).toHaveAttribute('data-fen', looked);
  await expect(awayBar(paired)).toHaveText(/^Looking at move 1\s*Back to the game$/);
  await engine.release();
  await expect(paired.getByRole('button', { name: /^Move 3… / })).toBeVisible();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  // The board stays where the Player is looking; the bar says what the Engine played.
  await expect(board).toHaveAttribute('data-fen', looked);
  const reply = ((await storedOnDevice(paired, 'engineGame')) as { moves: string[] }).moves;
  expect(reply.slice(0, 5)).toEqual([...ITALIAN, 'f1c4']);
  const san = playUci(fenAfter(reply.slice(0, 5)), reply[5] as string)?.san;
  await expect(awayBar(paired)).toContainText(`Looking at move 1 · The Engine has played 3… ${san}`);
  // Away from the position to play from: no Hint, no Show threat and no arrows.
  await expect(paired.getByRole('button', { name: 'Hint' })).toHaveCount(0);
  await expect(paired.getByRole('button', { name: 'Threat' })).toHaveCount(0);
  await expect(board.getByRole('img', { name: /^(Threat: |Arrow |Engine’s best)/ })).toHaveCount(0);
  await expect(paired.getByText('Press Hint for a nudge')).toHaveCount(0);
  // On a phone the bar keeps to one row: which move it is, and the way back.
  await paired.setViewportSize({ width: 390, height: 664 });
  await expect(awayBar(paired).getByText('Looking at move 1')).toBeInViewport({ ratio: 1 });
  await expect(awayBar(paired).getByRole('button', { name: 'Back to the game' })).toBeInViewport({ ratio: 1 });
  await expect(awayBar(paired).getByText(/The Engine has played/)).toBeHidden();
  await paired.setViewportSize({ width: 1200, height: 900 });

  await awayBar(paired).getByRole('button', { name: 'Back to the game' }).click();
  await expect(board).toHaveAttribute('data-fen', fenAfter(reply));
  await expect(awayBar(paired)).toHaveCount(0);
  await expect(paired.getByRole('button', { name: 'Hint' })).toBeVisible();
  await expect(board.getByRole('img', { name: /^Threat: / })).toHaveCount(1);
});

test('a move on an earlier position during play starts the Player’s own line: the game is unchanged and the line shows no Move Grades or Winning Chances', async ({ paired, app }) => {
  await resumeGame(paired, app.url, 'white', ITALIAN);
  await recordSearches(paired);
  const engine = await holdBrowserEngine(paired);
  await play(paired, 'f1c4', BOARD);
  for (let i = 0; i < 3; i++) await paired.keyboard.press('ArrowLeft');
  // 2. d4 exd4 instead of the game's 2. Nf3 Nc6, while the Engine is still to reply to 3. Bc4.
  await play(paired, 'd2d4', BOARD);
  await play(paired, 'e5d4', BOARD);
  const board = paired.getByRole('group', { name: BOARD });
  await expect(board).toHaveAttribute('data-fen', fenAfter(['e2e4', 'e7e5', 'd2d4', 'e5d4']));
  await expect(awayBar(paired)).toContainText('Your own line from move 2');
  await engine.release();
  // The game's Engine still replies, and the board stays on the Player's line.
  await expect(paired.getByRole('button', { name: /^Move 3… / })).toBeVisible();
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await expect(board).toHaveAttribute('data-fen', fenAfter(['e2e4', 'e7e5', 'd2d4', 'e5d4']));
  // No Move Grades and no Winning Chances on the line until the Player asks for them.
  const variation = paired.getByRole('list', { name: /^Variation from / });
  await expect(variation.getByRole('button')).toHaveCount(2);
  await expect(variation.getByRole('button', { name: 'Variation move 2. d4', exact: true })).toBeVisible();
  await expect(variation.getByRole('button', { name: 'Variation move 2… exd4', exact: true })).toBeVisible();
  await expect(board.getByRole('img', { name: GRADE_SYMBOL })).toHaveCount(0);
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveAccessibleName('Winning Chances bar: press Analyze to see them');
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ }).getByTestId('bar-percent')).toHaveCount(0);
  // The browser's Engine searched none of the line's positions, and the Coach was never called.
  const lineFens = [fenAfter(['e2e4', 'e7e5', 'd2d4']), fenAfter(['e2e4', 'e7e5', 'd2d4', 'e5d4'])];
  expect((await searches(paired)).filter((f) => lineFens.includes(f))).toEqual([]);
  expect(await app.rows('coach_calls')).toHaveLength(0);
  // The game and its saved record are unchanged: the Player's moves are not in it.
  const saved = (await storedOnDevice(paired, 'engineGame')) as { moves: string[]; grades: (string | null)[] };
  expect(saved.moves).toHaveLength(6);
  expect(saved.moves.slice(0, 5)).toEqual([...ITALIAN, 'f1c4']);
  await expect(paired.getByRole('list', { name: 'Moves' }).getByRole('button', { name: /^Move / })).toHaveCount(6);

  await awayBar(paired).getByRole('button', { name: 'Back to the game' }).click();
  await expect(board).toHaveAttribute('data-fen', fenAfter(saved.moves));
  await expect(variation).toHaveCount(0);
  // The game carries on from its latest position.
  await moveAndWaitForReply(paired, 'e1g1', 8);
});

test('Analyze on the Player’s own line shows its Move Grades, the Engine’s best move as an arrow, and makes one Coach call', async ({ paired, app }) => {
  await resumeGame(paired, app.url, 'white', ITALIAN);
  await paired.keyboard.press('ArrowLeft');
  await paired.keyboard.press('ArrowLeft');
  // 2. d4 exd4 instead of the game's 2. Nf3 Nc6.
  await play(paired, 'd2d4', BOARD);
  await play(paired, 'e5d4', BOARD);
  const board = paired.getByRole('group', { name: BOARD });
  const variation = paired.getByRole('list', { name: /^Variation from / });
  await awayBar(paired).getByRole('button', { name: 'Analyze' }).click();
  await coachIdle(paired);
  // The browser Engine's Move Grades on the line, the symbol of the move shown on its square.
  await expect(variation.getByRole('button', { name: /^Variation move 2\. d4, (Best|Good|Inaccuracy|Mistake|Blunder)$/ })).toBeVisible();
  await expect(variation.getByRole('button', { name: /^Variation move 2… exd4, (Best|Good|Inaccuracy|Mistake|Blunder)$/ })).toBeVisible();
  // The Engine's best move here in green, with the board's legend, and the Winning Chances back.
  await expect(board.getByRole('img', { name: /^Engine’s best: / })).toHaveCount(1);
  await expect(paired.getByRole('meter', { name: /^Winning Chances bar/ })).toHaveAccessibleName(/^Winning Chances bar: White’s winning chances: \d+%$/);
  // One Coach call, a Why Question about the line's move shown, with the line's moves.
  const calls = await app.rows<{ job: string; brief: string }>('coach_calls');
  expect(calls.map((c) => c.job)).toEqual(['why']);
  expect(calls[0]?.brief).toContain('exd4');
  await expect(paired.getByLabel('Coach conversation')).toContainText('Why exd4?');
  // Analyze is done for this position: it asks no more, and moving on the line never calls the Coach.
  await expect(awayBar(paired).getByRole('button', { name: 'Analyze' })).toHaveCount(0);
  await play(paired, 'd1d4', BOARD);
  await expect(variation.getByRole('button', { name: /^Variation move 3\. Qxd4, (Best|Good|Inaccuracy|Mistake|Blunder)$/ })).toBeVisible();
  expect(await app.rows('coach_calls')).toHaveLength(1);
  // Back to the game puts the Coach's word on the line away with it.
  await awayBar(paired).getByRole('button', { name: 'Back to the game' }).click();
  await expect(board.getByRole('img', { name: /^Engine’s best: / })).toHaveCount(0);
  await expect(paired.getByLabel('Coach conversation').getByText('Why exd4?')).toBeHidden();
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

  test('once the game ends, nothing the Coach said during play is left in the panel', async ({ paired, app }) => {
    await paired.setViewportSize({ width: 402, height: 714 });
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    await coachIdle(paired);
    await paired.getByRole('button', { name: 'Take the move back' }).click();
    await expect(paired.getByLabel('Coach conversation')).toContainText('Move taken back. Have another look.');
    await resign(paired);
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
    // The card says how the game went, and the thumb bar keeps only the steps.
    await expect(paired.getByRole('region', { name: 'Coach' })).toHaveCount(0);
    await expect(paired.getByText(/Move taken back|g4 is graded/)).toHaveCount(0);
    await expect(paired.getByRole('link', { name: 'Review this game' })).toBeInViewport({ ratio: 1 });
    await paired.reload();
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('The Engine won by resignation.');
    await expect(paired.getByText(/Move taken back|g4 is graded/)).toHaveCount(0);
  });

  // Safari's visible area on current iPhones too: a short sheet must still show the choice, not the move list under it.
  for (const [width, height] of [[402, 714], [440, 790]] as const) {
    test(`on an iPhone at ${width}×${height}, the choice to take a Mistake back shows in the resting sheet`, async ({ paired, app }) => {
      await paired.setViewportSize({ width, height });
      // A few moves in, so the move list under the choice has rows to scroll to.
      await startGame(paired, app.url);
      await moveAndWaitForReply(paired, 'e2e4', 2);
      await coachIdle(paired);
      // Ba6 gives the bishop away: a Blunder.
      await play(paired, 'f1a6', BOARD);
      const status = paired.getByRole('status', { name: 'Game status' });
      await expect(status).toContainText('Take the move back, or carry on?');
      await coachIdle(paired);
      await expect(status.getByRole('button', { name: 'Take the move back' })).toBeInViewport({ ratio: 1 });
      await expect(status.getByRole('button', { name: 'Carry on' })).toBeInViewport({ ratio: 1 });
      expect(await paired.evaluate(() => window.scrollY)).toBe(0);
    });
  }

  test('on a phone, the choice to take a Mistake back is on screen without scrolling', async ({ paired, app }) => {
    await paired.setViewportSize({ width: 390, height: 844 });
    await startGame(paired, app.url);
    await play(paired, 'g2g4', BOARD);
    const status = paired.getByRole('status', { name: 'Game status' });
    await expect(status).toContainText('Take the move back, or carry on?');
    await expect(status.getByRole('button', { name: 'Take the move back' })).toBeInViewport();
    await expect(status.getByRole('button', { name: 'Carry on' })).toBeInViewport();
    expect(await paired.evaluate(() => window.scrollY)).toBe(0);
    // The Coach's comment is docked at the foot of the screen, with at least its first line on
    // screen however long the reply is, and the board stays in view above it.
    await coachIdle(paired);
    await expect(paired.getByLabel('Coach conversation')).toContainText('g4 is graded Mistake');
    const comment = (await paired.getByLabel('Coach conversation').boundingBox())!;
    expect(comment.y + 24).toBeLessThanOrEqual(844);
    await expect(paired.getByRole('group', { name: BOARD })).toBeInViewport();
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
  await expect(paired.getByRole('img', { name: /^Arrow \w\d to \w\d \(best\)$/ })).toHaveCount(1);
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
  await expect(paired.getByRole('img', { name: /^Arrow \w\d to \w\d \(best\)$/ })).toHaveCount(1);
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
  await gameMenu(paired, 'New game');
  await paired.getByRole('alertdialog', { name: 'Abandon this game?' }).getByRole('button', { name: 'Yes, start a new game' }).click();
  await startGame(paired, app.url, 'Black');
  await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  await expect(bar).toHaveAccessibleName(/^Winning Chances bar: Black’s winning chances: \d+%$/);
  await expect(bar.getByTestId('bar-fill')).toHaveAttribute('data-side', 'black');
});
