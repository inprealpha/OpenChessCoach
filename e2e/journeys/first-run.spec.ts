// Feature map: First run and Player Profile.
import { readFileSync } from 'node:fs';
import { CoachClient } from '../../packages/backend/src/client.ts';
import { recordedFetch } from '../../packages/backend/src/verify/recorded-sites.ts';
import { MOVE_GRADES } from '../../packages/shared/src/grader.ts';
import { connection, expect, phoneLater, storedOnDevice, test } from '../fixtures/app.ts';

/** Each Move Grade's symbol, as the board draws it. */
const SYMBOL = { Best: '★', Good: '✓', Inaccuracy: '?!', Mistake: '?', Blunder: '??' };

const lessonIndex = JSON.parse(readFileSync(new URL('../../data/lessons/index.json', import.meta.url), 'utf8')) as { kind: string }[];
const OPENINGS = lessonIndex.filter((l) => l.kind === 'opening').length;

test.describe('a fresh install', () => {
  test.use({ seed: 'empty' });

  test('first run sets the level, reads the rating and saves Goals', async ({ page, app }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await expect(page.getByRole('heading', { name: 'Welcome to your chess Coach' })).toBeVisible();
    // First the phone (phone.spec.ts), then the Player.
    await phoneLater(page);
    // The suggestion counts the opening Lessons the app has, not a number written by hand.
    await expect(page.getByText(`the Opening Lessons teach ${OPENINGS} beginner openings`)).toBeVisible();
    await page.getByRole('radio', { name: /Club/ }).check();
    await page.getByLabel('Site').selectOption('lichess');
    await page.getByLabel('Username').fill('CoachVerify');
    await page.getByLabel('Goal 1').fill('Learn the Caro-Kann');
    await page.getByRole('button', { name: 'Start with the Opening Lessons' }).click();
    // The suggested start opens the Lessons themselves, not the Learn screen above them.
    await expect(page.getByRole('heading', { name: 'Lessons', exact: true })).toBeVisible();

    const [profile] = await app.rows<{ onboarded: number; level: string; rating: number; rating_site: string; goals: string }>('profile');
    expect(profile).toMatchObject({ onboarded: 1, level: 'club', rating: 1612, rating_site: 'lichess' });
    expect(JSON.parse(profile?.goals ?? '[]')).toEqual(['Learn the Caro-Kann']);

    await page.goto(`${app.url}/#/profile`);
    await expect(page.getByTestId('profile-level')).toHaveText('Club');
    await expect(page.getByRole('list', { name: 'Goals' })).toContainText('Learn the Caro-Kann');
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`an unknown username is shown beside the Username box, which takes the focus, and onboards nothing (${viewport.width}px)`, async ({ page, app }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${app.url}/#pair=${app.code}`);
      await phoneLater(page);
      await page.getByRole('radio', { name: /Beginner/ }).check();
      await page.getByLabel('Site').selectOption('lichess');
      await page.getByLabel('Username').fill('NoSuchPlayer');
      await page.getByRole('button', { name: 'Skip to the main menu' }).click();
      // Next to the field it is about, and on screen: not under the buttons, below the fold.
      const account = page.getByRole('group', { name: 'Your online account (optional)' });
      await expect(account.getByRole('alert')).toContainText('Lichess has no player called "NoSuchPlayer"');
      await expect(account.getByRole('alert')).toContainText('set Site to None');
      await expect(account.getByRole('alert')).toBeInViewport();
      await expect(page.getByLabel('Username')).toBeFocused();
      await expect(page.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');
      const [profile] = await app.rows<{ onboarded: number }>('profile');
      expect(profile?.onboarded).toBe(0);

      // Without the account, the Player gets in.
      await page.getByLabel('Site').selectOption('');
      await expect(account.getByRole('alert')).toHaveCount(0);
      await page.getByRole('button', { name: 'Skip to the main menu' }).click();
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
    });
  }

  test('a new Player Profile keeps its empty parts short', async ({ page, app }) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await phoneLater(page);
    await page.getByRole('button', { name: 'Skip to the main menu' }).click();
    // Skip saves the Player Profile, then opens the menu: wait for it, or that late step would
    // take the page back to the menu from the Profile.
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
    await page.goto(`${app.url}/#/profile`);
    const lessons = page.getByRole('region', { name: 'Lesson progress' });
    await expect(lessons).toContainText('No Lessons started yet.');
    await expect(lessons.getByRole('link', { name: 'Browse the Lessons' })).toHaveAttribute('href', '#/lessons');
    await expect(lessons).not.toContainText('not started');
    await expect(lessons).toContainText('No Puzzles tried yet.');
  });
});

test('the Player Profile edits the level and Goals', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/profile`);
  await expect(paired.getByTestId('profile-level')).toHaveText('Casual');
  await paired.getByRole('button', { name: 'Edit level, account and Goals' }).click();
  await paired.getByLabel('Level', { exact: true }).selectOption('beginner');
  await paired.getByLabel('Goal 1').fill('Stop hanging pieces');
  await paired.getByRole('button', { name: 'Save' }).click();
  await expect(paired.getByTestId('profile-level')).toHaveText('Beginner');
  const [profile] = await app.rows<{ level: string; goals: string }>('profile');
  expect(profile?.level).toBe('beginner');
  expect(JSON.parse(profile?.goals ?? '[]')[0]).toBe('Stop hanging pieces');
});

test('the Player Profile links, changes and removes a Lichess or chess.com account', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/profile`);
  const card = paired.getByRole('region', { name: 'Level, account and Goals' });
  await expect(card).toContainText('Rating: not linked');
  await card.getByRole('button', { name: 'Link an account' }).click();
  const site = card.getByLabel('Site');
  const username = card.getByLabel('Username');
  await expect(site).toBeFocused();

  // An unknown username is refused beside its box, and nothing is saved.
  await site.selectOption('lichess');
  await username.fill('NoSuchPlayer');
  await card.getByRole('button', { name: 'Save' }).click();
  const error = card.getByRole('alert');
  await expect(error).toContainText('NoSuchPlayer');
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  const box = await username.boundingBox();
  const err = await error.boundingBox();
  expect(err && box && err.y - (box.y + box.height)).toBeLessThan(40);
  expect((await app.rows<{ rating: number | null }>('profile'))[0]?.rating).toBeNull();

  await username.fill('CoachVerify');
  await expect(error).toHaveCount(0);
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card).toContainText('Rating: 1612 (Lichess, CoachVerify)');
  expect((await app.rows<{ rating: number; rating_site: string; rating_username: string }>('profile'))[0]).toMatchObject({
    rating: 1612,
    rating_site: 'lichess',
    rating_username: 'CoachVerify',
  });

  // The game list's import by username starts from the linked account.
  await paired.goto(`${app.url}/#/games`);
  const fetchForm = paired.getByRole('form', { name: 'Import by username' });
  await expect(fetchForm.getByLabel('Username')).toHaveValue('CoachVerify');

  // Changing it to another site reads that site's rating and replaces the link.
  await paired.goto(`${app.url}/#/profile`);
  await card.getByRole('button', { name: 'Edit level, account and Goals' }).click();
  await expect(site).toHaveValue('lichess');
  await site.selectOption('chesscom');
  await username.fill('coachverify');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card).toContainText('Rating: 1488 (chess.com, coachverify)');
  expect((await app.rows<{ rating: number; rating_site: string; rating_username: string }>('profile'))[0]).toMatchObject({
    rating: 1488,
    rating_site: 'chesscom',
    rating_username: 'coachverify',
  });

  // Removing the account clears the rating and the link.
  await card.getByRole('button', { name: 'Edit level, account and Goals' }).click();
  await site.selectOption('');
  await expect(username).toBeDisabled();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card).toContainText('Rating: not linked');
  expect((await app.rows<{ rating: number | null; rating_site: string | null }>('profile'))[0]).toMatchObject({ rating: null, rating_site: null });
});

test('on a phone, the Player Profile refuses a username in the wrong format under the Username box, which takes the focus', async ({ paired, app }) => {
  await paired.setViewportSize({ width: 390, height: 844 });
  await paired.goto(`${app.url}/#/profile`);
  const card = paired.getByRole('region', { name: 'Level, account and Goals' });
  await card.getByRole('button', { name: 'Link an account' }).click();
  const account = card.getByRole('group', { name: 'Your online account' });
  const username = account.getByLabel('Username');
  await account.getByLabel('Site').selectOption('lichess');
  // A full name and an email address are the usual mistakes: the site is never asked.
  for (const typed of ['Magnus Carlsen', 'magnus@example.com']) {
    await username.fill(typed);
    await card.getByRole('button', { name: 'Save' }).click();
    const error = account.getByRole('alert');
    await expect(error).toContainText('Usernames only use letters, numbers, - and _.');
    await expect(error).toBeInViewport();
    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    // Only there: not also at the foot of the page, below the fold.
    await expect(paired.getByRole('alert')).toHaveCount(1);
  }
  expect((await app.rows<{ rating: number | null }>('profile'))[0]?.rating).toBeNull();
});

test.describe('a site that is slow to answer', () => {
  const recorded = recordedFetch();
  let lookups = 0;
  let siteAnswers = Promise.resolve();
  test.use({
    appOptions: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        lookups++;
        await siteAnswers;
        return recorded(input as RequestInfo, init);
      }) as typeof fetch,
    },
  });
  /** Holds every site request until the returned function is called. */
  function holdTheSite(): () => void {
    let answer = (): void => {};
    lookups = 0;
    siteAnswers = new Promise((resolve) => (answer = resolve));
    return answer;
  }

  test('the Player Profile waits while the desktop asks the site: one lookup, and nothing to cancel that would land later', async ({ paired, app }) => {
    const answer = holdTheSite();
    await paired.goto(`${app.url}/#/profile`);
    const card = paired.getByRole('region', { name: 'Level, account and Goals' });
    await card.getByRole('button', { name: 'Link an account' }).click();
    await card.getByLabel('Site').selectOption('chesscom');
    await card.getByLabel('Username').fill('coachverify');
    await card.getByRole('button', { name: 'Save' }).dblclick();
    await expect(card.getByRole('button', { name: 'Checking chess.com…' })).toBeDisabled();
    // The desktop can't be called back once asked, so Cancel waits for the answer too.
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    answer();
    await expect(card).toContainText('Rating: 1488 (chess.com, coachverify)');
    expect(lookups).toBe(1);
  });
});

test('the game list fills its import with the linked account once the Player Profile arrives, unless the Player typed one', async ({ paired, app }) => {
  const desktop = await CoachClient.connect(app.url, app.token);
  await desktop.request('profile.update', { rating: { site: 'chesscom', username: 'coachverify' } });
  await desktop.close();
  // Hold the Player Profile back after a reload, as a desktop that is slow to answer would.
  let holding = true;
  const held: (() => void)[] = [];
  await paired.routeWebSocket(/\/ws\b/, (ws) => {
    const server = ws.connectToServer();
    const profileGets = new Set<string>();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id: string; type: string };
      if (msg.type === 'profile.get') profileGets.add(msg.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { id?: string };
      if (holding && msg.id && profileGets.has(msg.id)) held.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  const form = paired.getByRole('form', { name: 'Import by username' });
  await paired.goto(`${app.url}/#/games`);
  await paired.reload();
  await expect(connection(paired)).toHaveText(/Desktop connected/);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await form.getByLabel('Username').fill('someone');
  holding = false;
  for (const send of held.splice(0)) send();
  // The app keeps the Player Profile on this device once it has it.
  await expect.poll(() => storedOnDevice(paired, 'profile')).toMatchObject({ ratingSource: { site: 'chesscom', username: 'coachverify' } });
  await expect(form.getByLabel('Username')).toHaveValue('someone');
  await expect(form.getByLabel('Site')).toHaveValue('lichess');

  // Left alone, the import starts from the linked account, however the game list was opened.
  await paired.reload();
  await expect(form.getByLabel('Site')).toHaveValue('chesscom');
  await expect(form.getByLabel('Username')).toHaveValue('coachverify');
});

test('a Review adds Move Grade counts and a Coach note, and the Player can delete the note', async ({ paired, app }) => {
  await paired.goto(`${app.url}/#/review/1`);
  await paired.getByRole('button', { name: 'Start the Review' }).click();
  await expect(paired.getByRole('region', { name: 'Key moments' }).getByRole('listitem').first()).toBeVisible({ timeout: 90_000 });

  await paired.goto(`${app.url}/#/profile`);
  const grades = paired.getByRole('region', { name: 'Move Grades by opening' });
  await expect(grades).toContainText('Italian Game');
  // On a phone every column fits its card, with nothing to scroll inside it or on the page: the headers
  // shrink to the Move Grade symbols, and keep the Move Grades' names for screen readers.
  for (const width of [390, 320]) {
    await paired.setViewportSize({ width, height: 844 });
    await expect
      .poll(() => grades.evaluate((card) => card.querySelector('table')!.getBoundingClientRect().right - card.getBoundingClientRect().right))
      .toBeLessThanOrEqual(0);
    expect(await paired.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const g of MOVE_GRADES) {
      await expect(grades.getByRole('columnheader', { name: g, exact: true }).getByText(SYMBOL[g], { exact: true })).toBeVisible();
    }
    await expect(grades.getByText('★ Best · ✓ Good · ?! Inaccuracy · ? Mistake · ?? Blunder')).toBeVisible();
  }
  // On a wide screen the headers name the Move Grades in full.
  await paired.setViewportSize({ width: 1200, height: 900 });
  for (const g of MOVE_GRADES) await expect(grades.getByRole('columnheader', { name: g, exact: true })).toHaveText(g, { useInnerText: true });
  await expect(grades.getByText('★ Best · ✓ Good · ?! Inaccuracy · ? Mistake · ?? Blunder')).toBeHidden();
  const notes = await app.rows<{ text: string }>('coach_notes');
  expect(notes).toHaveLength(1);
  const note = notes[0]?.text ?? '';
  await paired.getByRole('button', { name: `Delete note: ${note}` }).click();
  await expect(paired.getByRole('button', { name: `Delete note: ${note}` })).toHaveCount(0);
  expect(await app.rows('coach_notes')).toHaveLength(0);
});

test.describe('Settings: Coach quality', () => {
  const BEST = { 'review-moment': 'opus', why: 'opus', 'lesson-turn': 'opus', hint: 'haiku', live: 'haiku' };
  const savedModels = async (app: { rows: <T>(t: string) => Promise<T[]> }): Promise<unknown> => {
    const row = (await app.rows<{ key: string; value: string }>('settings')).find((r) => r.key === 'models');
    return row ? JSON.parse(row.value) : undefined;
  };

  test('is Balanced by default; choosing Best sets every job’s model, shown under Advanced', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    const quality = paired.getByRole('group', { name: 'Coach quality' });
    await expect(quality.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
    await expect(quality).toContainText('Haiku for every job. Uses the least of your Claude limits');
    await expect(quality).toContainText('Uses your Claude limits fastest');
    await expect(quality.getByRole('radio', { name: /^Custom/ })).toHaveCount(0);
    // The per-job models are tucked away until the Player opens Advanced.
    await expect(paired.getByLabel('Model for Reviews')).toBeHidden();

    await quality.getByRole('radio', { name: /^Best/ }).check();
    await expect.poll(() => savedModels(app)).toEqual(BEST);
    // The confirmation shows beside the choice, not at the foot of a long page.
    await expect(quality.getByRole('status')).toHaveText('Saved.');
    await expect(quality.getByRole('status')).toBeInViewport();
    await paired.getByText('Advanced', { exact: true }).click();
    await expect(paired.getByLabel('Model for Reviews')).toHaveValue('opus');
    await expect(paired.getByLabel('Model for Reviews').locator('option:checked')).toHaveText('Strongest, latest Opus');
    await expect(paired.getByLabel('Model for Hints').locator('option:checked')).toHaveText('Fastest, latest Haiku');

    // One job changed by hand: the choice reads Custom, and a preset puts every job back.
    await paired.getByLabel('Model for Hints').selectOption('sonnet');
    await expect(quality.getByRole('radio', { name: /^Custom/ })).toBeChecked();
    await quality.getByRole('radio', { name: /^Best/ }).check();
    await expect(paired.getByLabel('Model for Hints')).toHaveValue('haiku');
    await expect.poll(() => savedModels(app)).toEqual(BEST);
  });

  test('Think deeper warns that on Haiku it can add mistakes: shown for Thrifty, not for Balanced or Best', async ({ paired, app }) => {
    await paired.goto(`${app.url}/#/settings`);
    const quality = paired.getByRole('group', { name: 'Coach quality' });
    const warning = paired.getByRole('region', { name: 'Think deeper' }).getByTestId('think-deeper-haiku');
    // Balanced, the default, runs Why Questions and Reviews on Sonnet.
    await expect(quality.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
    await expect(warning).toHaveCount(0);
    await quality.getByRole('radio', { name: /^Thrifty/ }).check();
    await expect(warning).toContainText('On Haiku, Think deeper makes answers fuller but can add mistakes.');
    await quality.getByRole('radio', { name: /^Best/ }).check();
    await expect(warning).toHaveCount(0);
  });

  test('an install whose models match no preset shows Custom and keeps them', async ({ paired, app }) => {
    const mine = { 'review-moment': 'opus', why: 'sonnet', 'lesson-turn': 'haiku', hint: 'sonnet', live: 'claude-haiku-4-5' };
    app.app.db.prepare("INSERT INTO settings (key, value) VALUES ('models', ?)").run(JSON.stringify(mine));
    await paired.goto(`${app.url}/#/settings`);
    const quality = paired.getByRole('group', { name: 'Coach quality' });
    await expect(quality.getByRole('radio', { name: /^Custom/ })).toBeChecked();
    for (const name of ['Thrifty', 'Balanced', 'Best']) await expect(quality.getByRole('radio', { name: new RegExp(`^${name}`) })).not.toBeChecked();
    await paired.getByText('Advanced', { exact: true }).click();
    await expect(paired.getByLabel('Model for Reviews')).toHaveValue('opus');
    await expect(paired.getByLabel('Model for Live Coaching')).toHaveValue('claude-haiku-4-5');
    expect(await savedModels(app)).toEqual(mine);
  });
});
