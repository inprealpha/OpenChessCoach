// Feature map: Main menu and navigation. Three big choices (Review your games, Play a game,
// Learn), an import prompt while the Player has no games, the Board as a small link, and Settings
// and the Player Profile as icons in the top right of every screen. A sample Review for a Player
// with no games yet, and the Engine Game in progress to continue.
import { type Page } from '@playwright/test';
import { startVerifyInstance } from '../../packages/backend/src/verify/instance.ts';
import { connection, expect, phoneLater, play, resign, test } from '../fixtures/app.ts';

const menu = (page: Page) => page.getByRole('navigation', { name: 'Main menu' });
const choice = (page: Page, name: string) => menu(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.describe('a Player with no games', () => {
  test.use({ seed: 'empty' });

  test('sees the import prompt and the three big choices, and nothing else competes with them', async ({ page, app }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await phoneLater(page);
    await page.getByRole('button', { name: 'Skip to the main menu' }).click();
    await expect(menu(page)).toBeVisible();

    const prompt = menu(page).getByRole('region', { name: 'Import your games' });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('link', { name: 'Import your games' })).toHaveAttribute('href', '#/games/import');
    for (const name of ['Review your games', 'Play a game', 'Learn']) await expect(choice(page, name)).toBeVisible();
    await expect(menu(page).getByRole('link', { name: 'Import more' })).toHaveCount(0);
    // The import prompt, the three choices and the Board's small link: nothing else.
    await expect(menu(page).getByRole('link')).toHaveText([/^Import your games$/, /^Review your games/, /^Play a game/, /^Learn/, /^Board$/]);
    await expect(page.getByRole('main').getByRole('link')).toHaveCount(5);

    await prompt.getByRole('link', { name: 'Import your games' }).click();
    await expect(page.getByRole('heading', { name: 'Imported Games and Reviews' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Username' })).toBeFocused();
  });

  test('can try a sample Review before importing anything, and trying again opens the same game', async ({ page, app, browser }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await phoneLater(page);
    await page.getByRole('button', { name: 'Skip to the main menu' }).click();
    // A second device on the menu too, so the sample is tried twice.
    const other = await browser.newPage();
    await other.goto(`${app.url}/#pair=${app.code}`);
    await expect(menu(other)).toBeVisible();

    await menu(page).getByRole('region', { name: 'Import your games' }).getByRole('button', { name: 'Try a sample Review' }).click();
    await expect(page).toHaveURL(/#\/review\/\d+$/);
    await expect(page.getByText('bijean vs ikatsca')).toBeVisible();
    await expect(page.getByRole('note')).toHaveText('A sample game: it doesn’t count towards your Player Profile.');
    await page.getByRole('button', { name: 'Start the Review' }).click();
    await expect(page.getByRole('region', { name: 'Key moments' }).getByRole('listitem')).toHaveCount(4);
    const games = await app.rows<{ id: number; player_side: string; source: string }>('games');
    expect(games).toEqual([expect.objectContaining({ player_side: 'white', source: 'sample' })]);
    // Not the Player's game: its Move Grades stay out of the Player Profile.
    expect(await app.rows('grade_counts')).toEqual([]);

    await menu(other).getByRole('button', { name: 'Try a sample Review' }).click();
    await expect(other).toHaveURL(new RegExp(`#/review/${games[0]?.id}$`));
    expect(await app.rows('games')).toHaveLength(1);
    await other.close();

    // The sample isn't the Player's game: the menu still asks for theirs, but no longer offers the sample.
    await page.getByRole('link', { name: 'OpenChessCoach' }).click();
    await expect(menu(page)).toBeVisible();
    const prompt = menu(page).getByRole('region', { name: 'Import your games' });
    await expect(prompt.getByRole('link', { name: 'Import your games' })).toBeVisible();
    await expect(menu(page).getByRole('button', { name: 'Try a sample Review' })).toHaveCount(0);
    await expect(menu(page).getByRole('link', { name: 'Import more' })).toHaveCount(0);
    // Nor did the Player win or lose it.
    await choice(page, 'Review your games').getByRole('link', { name: /^Review your games/ }).click();
    const row = page.getByRole('table', { name: 'Game list' }).getByRole('row').filter({ hasText: 'ikatsca (sample)' });
    await expect(row).toContainText('Black won');
    await expect(row).not.toContainText(/You (won|lost)/);
  });

  test('the sample Review needs the desktop, like the import it is part of', async ({ page }) => {
    const app = await startVerifyInstance({ seed: 'empty' });
    try {
      await page.goto(`${app.url}/#pair=${app.code}`);
      await phoneLater(page);
      await page.getByRole('button', { name: 'Skip to the main menu' }).click();
      // Skip saves the Player Profile, then opens the menu: wait for it, or that late step would
      // take the page back to the menu from the game list.
      await expect(menu(page)).toBeVisible();
      // Open the game list once, so this device keeps it (empty) for offline use.
      await page.goto(`${app.url}/#/games`);
      await expect(page.getByText('No games yet', { exact: false })).toBeVisible();
      await page.goto(`${app.url}/#/menu`);
      await expect(menu(page).getByRole('button', { name: 'Try a sample Review' })).toBeEnabled();
      await app.stop();
      await expect(connection(page)).toHaveText(/Desktop offline/);
      await expect(menu(page).getByRole('button', { name: 'Try a sample Review' })).toBeDisabled();
    } finally {
      await app.stop();
    }
  });

  test('the first-run screen’s suggested start opens the Lessons', async ({ page, app }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await phoneLater(page);
    await page.getByRole('button', { name: 'Start with the Lessons' }).click();
    await expect(page.getByRole('heading', { name: 'Lessons', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/lessons$/);
  });
});

test('with games, the import prompt is gone and Review your games has Import more', async ({ paired }) => {
  await expect(choice(paired, 'Review your games')).toBeVisible();
  await expect(menu(paired).getByRole('region', { name: 'Import your games' })).toHaveCount(0);
  const importMore = choice(paired, 'Review your games').getByRole('link', { name: 'Import more' });
  await expect(importMore).toBeVisible();

  await choice(paired, 'Review your games').getByRole('link', { name: /^Review your games/ }).click();
  await expect(paired.getByRole('table', { name: 'Game list' }).getByRole('row')).toHaveCount(2);

  await paired.goBack();
  await importMore.click();
  await expect(paired).toHaveURL(/#\/games\/import$/);
  await expect(paired.getByRole('textbox', { name: 'Username' })).toBeFocused();
});

test('an Engine Game in progress shows on the menu as Continue your game, until it is over', async ({ paired }) => {
  await expect(choice(paired, 'Play a game')).toBeVisible();
  await expect(choice(paired, 'Play a game').getByRole('link', { name: 'Continue your game' })).toHaveCount(0);

  await choice(paired, 'Play a game').getByRole('link').click();
  await paired.getByRole('radio', { name: 'Beginner' }).check();
  await paired.getByRole('button', { name: 'Start the Engine Game' }).click();
  const moves = paired.getByRole('list', { name: 'Moves' }).getByRole('button');
  for (const [uci, plies] of [['e2e4', 2], ['e4d5', 4]] as const) {
    await play(paired, uci, 'Engine Game board');
    await expect(moves).toHaveCount(plies);
    await expect(paired.getByRole('status', { name: 'Game status' })).toContainText('Your move');
  }

  await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
  const card = choice(paired, 'Play a game');
  await expect(card.getByRole('link', { name: 'Continue your game' })).toBeVisible();
  await expect(card).toContainText('Move 3, you play White');
  await card.getByRole('link', { name: 'Continue your game' }).click();
  await expect(moves).toHaveCount(4);

  await resign(paired);
  await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
  await expect(choice(paired, 'Play a game')).toBeVisible();
  await expect(choice(paired, 'Play a game').getByRole('link', { name: 'Continue your game' })).toHaveCount(0);
});

test('a saved Engine Game that is over on the board, or can’t be replayed, is not offered to continue', async ({ paired, app }) => {
  const errors: string[] = [];
  paired.on('pageerror', (e) => errors.push(e.message));
  const keep = (value: unknown) =>
    paired.evaluate(
      (v) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('ai-chess-coach', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(v, 'engineGame');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        }),
      value,
    );
  const game = (over: Record<string, unknown>) => ({ clientId: 'x', playerSide: 'white', strength: 2, moves: ['e2e4'], grades: [], live: false, startedAt: '2026-10-25T00:00:00.000Z', ...over });
  const card = choice(paired, 'Play a game');

  // A game in progress, as the Engine Game screen keeps it: the menu offers it.
  await keep(game({ playerSide: 'black' }));
  await paired.goto(`${app.url}/#/menu`);
  await paired.reload();
  await expect(card).toContainText('Move 1, you play Black');

  for (const saved of [
    // Checkmate on the board, the app closed before the result was saved.
    game({ moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'] }),
    game({ playerSide: 'red' }),
    game({ moves: ['e2e5', 'e7e5'] }),
  ]) {
    await keep(saved);
    await paired.reload();
    await expect(choice(paired, 'Review your games').getByRole('link', { name: 'Import more' })).toBeVisible();
    // The menu reads the saved game once it opens; give it the time it took above.
    await paired.waitForTimeout(500);
    await expect(card.getByRole('link', { name: 'Continue your game' })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('Play a game opens an Engine Game; Learn offers Lessons and Puzzles; the Board opens from its small link', async ({ paired }) => {
  await choice(paired, 'Play a game').getByRole('link').click();
  await expect(paired.getByRole('heading', { name: 'Engine Game', exact: true })).toBeVisible();

  await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
  await choice(paired, 'Learn').getByRole('link').click();
  await expect(paired.getByRole('heading', { name: 'Learn', exact: true })).toBeVisible();
  const learn = paired.getByRole('navigation', { name: 'Learn' });
  await learn.getByRole('link', { name: /^Lessons/ }).click();
  await expect(paired.getByRole('heading', { name: 'Lessons', exact: true })).toBeVisible();
  await paired.goBack();
  await learn.getByRole('link', { name: /^Puzzles/ }).click();
  await expect(paired.getByRole('heading', { name: 'Puzzles', exact: true })).toBeVisible();

  await paired.getByRole('link', { name: 'OpenChessCoach' }).click();
  await menu(paired).getByRole('link', { name: 'Board', exact: true }).click();
  await expect(paired.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
});

test('each screen names itself in the page title', async ({ paired, app }) => {
  const titles: [string, string][] = [
    ['', 'OpenChessCoach'],
    ['board', 'Board · OpenChessCoach'],
    ['games', 'Your games · OpenChessCoach'],
    // A Review, a Lesson and a set of Puzzles say which, so two open in tabs can be told apart.
    ['review/1', 'Review: bijean vs ikatsca · OpenChessCoach'],
    ['engine-game', 'Engine Game · OpenChessCoach'],
    ['learn', 'Learn · OpenChessCoach'],
    ['lessons', 'Lessons · OpenChessCoach'],
    ['lesson/italian-game', 'Lesson: Italian Game · OpenChessCoach'],
    ['lesson/pins', 'Lesson: Pins · OpenChessCoach'],
    ['lesson/nope', 'Lesson · OpenChessCoach'],
    ['puzzles', 'Puzzles · OpenChessCoach'],
    ['puzzles/forks', 'Puzzles: Forks · OpenChessCoach'],
    ['settings', 'Settings · OpenChessCoach'],
    ['profile', 'Player Profile · OpenChessCoach'],
    // An address that names no screen shows the menu, whatever it is called.
    ['nonsense', 'OpenChessCoach'],
    ['constructor', 'OpenChessCoach'],
    ['toString', 'OpenChessCoach'],
    ['__proto__', 'OpenChessCoach'],
  ];
  for (const [route, title] of titles) {
    await paired.goto(`${app.url}/#/${route}`);
    await expect(paired).toHaveTitle(title);
  }
});

test('no card starts or ends with a blank band', async ({ paired, app }) => {
  for (const route of ['', 'games', 'review/1', 'engine-game', 'learn', 'puzzles', 'settings', 'profile', 'first-run']) {
    await paired.goto(`${app.url}/#/${route}`);
    await expect(paired.getByRole('main').locator('.card').first()).toBeVisible();
    // The card's padding is its spacing: the first and last things shown in it add no margin of their own.
    const extra = await paired.getByRole('main').locator('.card').evaluateAll((cards) =>
      cards.flatMap((card) => {
        const shown = [...card.children].filter((el) => el.getClientRects().length > 0);
        const first = shown[0];
        const last = shown[shown.length - 1];
        const out: string[] = [];
        if (first && getComputedStyle(first).marginTop !== '0px') out.push(`${first.tagName} at the top: ${first.textContent?.trim().slice(0, 30)}`);
        if (last && getComputedStyle(last).marginBottom !== '0px') out.push(`${last.tagName} at the bottom: ${last.textContent?.trim().slice(0, 30)}`);
        return out;
      }),
    );
    expect(extra, `#/${route}`).toEqual([]);
  }
});

test('Settings and the Player Profile open from the icons in the top right of every screen', async ({ paired, app }) => {
  const banner = paired.getByRole('banner');
  for (const route of ['', 'learn', 'lessons', 'puzzles', 'games', 'engine-game', 'board', 'review/1', 'lesson/italian-game', 'settings', 'profile']) {
    await paired.goto(`${app.url}/#/${route}`);
    await banner.getByRole('link', { name: 'Settings' }).click();
    await expect(paired.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

    await paired.goto(`${app.url}/#/${route}`);
    await banner.getByRole('link', { name: 'Player Profile' }).click();
    await expect(paired.getByRole('heading', { name: 'Player Profile', exact: true, level: 1 })).toBeVisible();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the icons and the three choices fit without scrolling sideways', async ({ paired }) => {
    const banner = paired.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Settings' })).toBeInViewport();
    await expect(banner.getByRole('link', { name: 'Player Profile' })).toBeInViewport();
    await expect(choice(paired, 'Learn')).toBeVisible();
    expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
