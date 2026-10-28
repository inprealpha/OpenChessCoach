// Journey fixtures: a fresh verify-mode instance per test and helpers that drive the web app
// the way a Player does, by accessible name. Database readback goes through the verify route.
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { startVerifyInstance, type VerifyInstance, type VerifyOptions } from '../../packages/backend/src/verify/instance.ts';
import type { ScriptedReply } from '../../packages/backend/src/coach/fake.ts';
import { READABLE_TABLES } from '../../packages/backend/src/db.ts';
import type { Seed } from '../../packages/backend/src/verify/runs.ts';

export interface AppFixture extends VerifyInstance {
  /** Reads a table back from the instance's database. */
  rows<T = Record<string, unknown>>(table: string): Promise<T[]>;
  /** Scripts the fake Coach's next reply. */
  script(body: ScriptedReply): Promise<void>;
}

interface Options {
  seed: Seed;
  appOptions: Omit<VerifyOptions, 'seed'>;
}

export const test = base.extend<Options & { app: AppFixture; paired: Page }>({
  seed: ['default', { option: true }],
  appOptions: [{}, { option: true }],
  app: async ({ seed, appOptions }, use) => {
    const instance = await startVerifyInstance({ seed, chunkDelayMs: 0, ...appOptions });
    const app: AppFixture = Object.assign(instance, {
      // Read straight from the instance's database: a pairing reset revokes the fixture's token.
      async rows<T>(table: string): Promise<T[]> {
        if (!(READABLE_TABLES as readonly string[]).includes(table)) throw new Error(`Unknown table ${table}`);
        return instance.app.db.prepare(`SELECT * FROM ${table}`).all() as T[];
      },
      async script(body: ScriptedReply): Promise<void> {
        instance.coach.script(body);
      },
    });
    await use(app);
    await instance.stop();
  },
  /** A page already paired with the instance, through the pairing link the QR code carries. */
  paired: async ({ page, app }, use) => {
    await page.goto(`${app.url}/#pair=${app.code}`);
    await expect(connection(page)).toHaveText(/Desktop connected/);
    await use(page);
  },
});

export { expect };

export function connection(page: Page): Locator {
  return page.getByRole('status', { name: 'Connection' });
}

/** First run on a desktop asks for the phone first: put it off, which the main menu asks again about in a few days. */
export async function phoneLater(page: Page): Promise<void> {
  await page.getByRole('region', { name: 'Play on your phone' }).getByRole('button', { name: 'I’ll do it later' }).click();
}

export function board(page: Page, name?: string): Locator {
  return name ? page.getByRole('group', { name }) : page.locator('.board[role="group"]');
}

export function square(page: Page, sq: string, boardName?: string): Locator {
  return board(page, boardName).getByRole('button', { name: new RegExp(`^${sq},`) });
}

/** Plays a move in UCI by clicking its two squares, and a promotion piece if needed. */
export async function play(page: Page, uci: string, boardName?: string): Promise<void> {
  await square(page, uci.slice(0, 2), boardName).click();
  await square(page, uci.slice(2, 4), boardName).click();
  const promo = uci[4];
  if (promo) {
    const names: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    await page.getByRole('button', { name: `Promote to ${names[promo]}` }).click();
  }
}

export async function fenOf(page: Page, boardName?: string): Promise<string> {
  return (await board(page, boardName).getAttribute('data-fen')) ?? '';
}

export function coachPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Coach' });
}

/** Waits until the Coach has finished its reply (no entry still streaming). */
export async function coachIdle(page: Page): Promise<void> {
  await expect(coachPanel(page).locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Resigns an Engine Game: Resign, then Yes, resign in the confirmation. */
export async function resign(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('alertdialog', { name: 'Resign this game?' }).getByRole('button', { name: 'Yes, resign' }).click();
}

/**
 * Holds the desktop's Engine: from `hold()` to `release()` it starts no new analysis, so a Review
 * stays where it has got to while a journey reloads the page or drops the connection.
 */
export function engineGate(instance: VerifyInstance): { hold(): void; release(): void } {
  const engine = instance.app.context.desktopEngine;
  const analyse = engine.analyse.bind(engine);
  let held: Promise<void> | undefined;
  let open = () => {};
  engine.analyse = async (fen) => {
    await held;
    return analyse(fen);
  };
  return {
    hold: () => void (held ??= new Promise((resolve) => (open = resolve))),
    release: () => {
      open();
      held = undefined;
    },
  };
}

/** A value from the web app's offline store (IndexedDB), as the device saved it. */
export function storedOnDevice(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (k) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('ai-chess-coach', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('kv').objectStore('kv').get(k);
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  );
}
