// Settings over the protocol: the Coach quality choice, the per-job models it stands for, Think deeper
// and the Review overview.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS, openDb } from '../src/db.ts';
import { getSettings, updateSettings } from '../src/settings.ts';
import { client, instance } from './helpers.ts';

const THRIFTY = { 'review-moment': 'haiku', why: 'haiku', 'lesson-turn': 'haiku', hint: 'haiku', live: 'haiku' };
const BALANCED = { 'review-moment': 'sonnet', why: 'sonnet', 'lesson-turn': 'sonnet', hint: 'haiku', live: 'haiku' };
const BEST = { 'review-moment': 'opus', why: 'opus', 'lesson-turn': 'opus', hint: 'haiku', live: 'haiku' };

/** A database as it was just before the migration that contains `marker`, so reopening runs it and the ones after. */
function before(dir: string, marker: string, setup: (db: ReturnType<typeof openDb>) => void): void {
  const at = MIGRATIONS.findIndex((m) => m.includes(marker));
  if (at < 0) throw new Error(`no migration contains ${marker}`);
  const old = openDb(dir);
  setup(old);
  old.prepare('UPDATE schema_version SET version = ?').run(at);
  old.close();
}

describe('Coach quality', () => {
  it('is Best on a fresh install, with Opus for the explaining jobs and Haiku for the quick ones', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    expect(await c.request('settings.get', {})).toMatchObject({ quality: 'best', models: BEST });
  });

  it('moves an install that saved Sonnet to Opus once, keeping its other choices, and a Player who picks Sonnet again keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-opus-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // Balanced as saved before 0.5.0, with Hints changed by hand to Sonnet.
    before(dir, 'json_set', (old) => old.prepare("INSERT INTO settings (key, value) VALUES ('models', ?)").run(JSON.stringify({ ...BALANCED, hint: 'sonnet' })));
    const db = openDb(dir);
    expect(getSettings(db)).toMatchObject({ quality: 'custom', models: { ...BEST, hint: 'sonnet' } });
    updateSettings(db, { quality: 'balanced' });
    db.close();
    const again = openDb(dir);
    onTestFinished(() => again.close());
    expect(getSettings(again)).toMatchObject({ quality: 'balanced', models: BALANCED });
  });

  it('leaves saved models without the sonnet alias as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-opus-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const mine = { 'review-moment': 'haiku', why: 'claude-sonnet-4-5', 'lesson-turn': 'haiku', hint: 'haiku', live: 'haiku' };
    before(dir, 'json_set', (old) => old.prepare("INSERT INTO settings (key, value) VALUES ('models', ?)").run(JSON.stringify(mine)));
    const db = openDb(dir);
    onTestFinished(() => db.close());
    expect(getSettings(db).models).toEqual(mine);
  });

  it('writes the per-job models of each preset and reads the preset back from them', async () => {
    const c = await client(await instance());
    for (const [quality, models] of [
      ['thrifty', THRIFTY],
      ['best', BEST],
      ['balanced', BALANCED],
    ] as const) {
      expect(await c.request('settings.update', { quality })).toMatchObject({ quality, models });
      expect(await c.request('settings.get', {})).toMatchObject({ quality, models });
    }
  });

  it('reads a mixed set of models back as Custom, and a preset again once they match one', async () => {
    const c = await client(await instance());
    await c.request('settings.update', { quality: 'best' });
    expect(await c.request('settings.update', { models: { live: 'sonnet' } })).toMatchObject({
      quality: 'custom',
      models: { ...BEST, live: 'sonnet' },
    });
    expect(await c.request('settings.update', { models: { live: 'haiku' } })).toMatchObject({ quality: 'best' });
  });

  it('shows Custom for an install whose saved models match no preset, and keeps them', async () => {
    const app = await instance();
    const saved = { 'review-moment': 'opus', why: 'sonnet', 'lesson-turn': 'haiku', hint: 'sonnet', live: 'claude-haiku-4-5' };
    app.app.db.prepare("INSERT INTO settings (key, value) VALUES ('models', ?)").run(JSON.stringify(saved));
    const c = await client(app);
    expect(await c.request('settings.get', {})).toMatchObject({ quality: 'custom', models: saved });
    // Changing something else leaves the models alone.
    expect(await c.request('settings.update', { liveCoachingDefault: false })).toMatchObject({ quality: 'custom', models: saved });
  });

  it('refuses a choice that is not one of the presets', async () => {
    const c = await client(await instance());
    await expect(c.request('settings.update', { quality: 'custom' as never })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.request('settings.update', { quality: 'cheap' as never })).rejects.toMatchObject({ code: 'bad-request' });
    expect(await c.request('settings.get', {})).toMatchObject({ quality: 'best', models: BEST });
  });
});

describe('Think deeper', () => {
  it('is on on a fresh install, and turning it off or on leaves the models alone (#32)', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: true });
    await c.request('settings.update', { quality: 'best' });
    expect(await c.request('settings.update', { thinkDeeper: false })).toMatchObject({ thinkDeeper: false, quality: 'best', models: BEST });
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: false });
    // Changing something else leaves it off.
    expect(await c.request('settings.update', { quality: 'thrifty' })).toMatchObject({ thinkDeeper: false, models: THRIFTY });
    expect(await c.request('settings.update', { thinkDeeper: true })).toMatchObject({ thinkDeeper: true, models: THRIFTY });
  });

  it('stores only the settings the Player changed, so an untouched one follows its default', async () => {
    const app = await instance({ seed: 'empty' });
    const c = await client(app);
    await c.request('settings.update', { quality: 'thrifty' });
    expect(app.app.db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([{ key: 'models' }]);
  });

  it('turns on once for an install that saved the old default, and stays off when the Player turns it off again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-deeper-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // Before #32, saving any setting stored every setting, so "off" was stored with the rest.
    before(dir, "key = 'thinkDeeper'", (old) => old.prepare("INSERT INTO settings (key, value) VALUES ('thinkDeeper', 'false'), ('liveCoachingDefault', 'false')").run());
    const db = openDb(dir);
    expect(getSettings(db)).toMatchObject({ thinkDeeper: true, liveCoachingDefault: false });
    updateSettings(db, { thinkDeeper: false });
    db.close();
    const again = openDb(dir);
    onTestFinished(() => again.close());
    expect(getSettings(again)).toMatchObject({ thinkDeeper: false });
  });

  it('is on or off, nothing else', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    for (const value of ['no', 1, null]) {
      await expect(c.request('settings.update', { thinkDeeper: value as never })).rejects.toMatchObject({ code: 'bad-request' });
    }
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: true });
  });
});

describe('the Review overview', () => {
  it('is on on a fresh install, and turning it off or on leaves the models alone', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    expect(await c.request('settings.get', {})).toMatchObject({ reviewOverview: true });
    await c.request('settings.update', { quality: 'best' });
    expect(await c.request('settings.update', { reviewOverview: false })).toMatchObject({ reviewOverview: false, quality: 'best', models: BEST });
    expect(await c.request('settings.get', {})).toMatchObject({ reviewOverview: false });
    // Changing something else leaves it off.
    expect(await c.request('settings.update', { quality: 'thrifty' })).toMatchObject({ reviewOverview: false, models: THRIFTY });
    expect(await c.request('settings.update', { reviewOverview: true })).toMatchObject({ reviewOverview: true, models: THRIFTY });
  });

  it('is on or off, nothing else, and has no model of its own: the presets set the Review moments’ model', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    for (const value of ['no', 1, null]) {
      await expect(c.request('settings.update', { reviewOverview: value as never })).rejects.toMatchObject({ code: 'bad-request' });
    }
    await expect(c.request('settings.update', { models: { 'review-overview': 'opus' } as never })).rejects.toMatchObject({ code: 'bad-request' });
    expect(await c.request('settings.get', {})).toMatchObject({ reviewOverview: true, quality: 'best', models: BEST });
  });
});
