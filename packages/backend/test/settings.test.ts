// Settings over the protocol: the Coach quality choice, the per-job models it stands for, Think deeper
// and the Review overview.
import { describe, expect, it } from 'vitest';
import { client, instance } from './helpers.ts';

const THRIFTY = { 'review-moment': 'haiku', why: 'haiku', 'lesson-turn': 'haiku', hint: 'haiku', live: 'haiku' };
const BALANCED = { 'review-moment': 'sonnet', why: 'sonnet', 'lesson-turn': 'sonnet', hint: 'haiku', live: 'haiku' };
const BEST = { 'review-moment': 'opus', why: 'opus', 'lesson-turn': 'opus', hint: 'haiku', live: 'haiku' };

describe('Coach quality', () => {
  it('is Balanced on a fresh install, with Sonnet for the explaining jobs and Haiku for the quick ones', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    expect(await c.request('settings.get', {})).toMatchObject({ quality: 'balanced', models: BALANCED });
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
    expect(await c.request('settings.get', {})).toMatchObject({ quality: 'balanced', models: BALANCED });
  });
});

describe('Think deeper', () => {
  it('is off on a fresh install, and turning it on or off leaves the models alone', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: false });
    await c.request('settings.update', { quality: 'best' });
    expect(await c.request('settings.update', { thinkDeeper: true })).toMatchObject({ thinkDeeper: true, quality: 'best', models: BEST });
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: true });
    // Changing something else leaves it on.
    expect(await c.request('settings.update', { quality: 'thrifty' })).toMatchObject({ thinkDeeper: true, models: THRIFTY });
    expect(await c.request('settings.update', { thinkDeeper: false })).toMatchObject({ thinkDeeper: false, models: THRIFTY });
  });

  it('is on or off, nothing else', async () => {
    const c = await client(await instance({ seed: 'empty' }));
    for (const value of ['no', 1, null]) {
      await expect(c.request('settings.update', { thinkDeeper: value as never })).rejects.toMatchObject({ code: 'bad-request' });
    }
    expect(await c.request('settings.get', {})).toMatchObject({ thinkDeeper: false });
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
    expect(await c.request('settings.get', {})).toMatchObject({ reviewOverview: true, quality: 'balanced', models: BALANCED });
  });
});
