// coachctl through its JSON output, against a verify-mode instance.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { instance } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/coachctl/main.ts', import.meta.url));
const STATE = mkdtempSync(join(tmpdir(), 'coachctl-state-'));

function ctl(...args: string[]): Promise<{ code: number; json: Record<string, unknown> & { ok: boolean } }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args, '--state-dir', STATE], (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, json: JSON.parse(stdout) });
    });
  });
}

describe('coachctl', () => {
  it('doctor reports healthy on a fresh instance and unhealthy once it stops', async () => {
    const app = await instance();
    const target = ['--url', app.url, '--token', app.token];
    const healthy = await ctl('doctor', ...target);
    expect(healthy.code).toBe(0);
    expect(healthy.json.healthy).toBe(true);
    expect((healthy.json.checks as { name: string }[]).map((c) => c.name)).toEqual(['backend', 'version', 'mode', 'web-app', 'pairing-guard', 'pairing']);

    await app.app.close();
    const down = await ctl('doctor', ...target);
    expect(down.code).toBe(1);
    expect(down.json).toMatchObject({ ok: false, healthy: false });
    expect((down.json.checks as { name: string; fix?: string }[])[0]).toMatchObject({ name: 'backend', ok: false, fix: expect.any(String) });
  });

  it('pairs, imports a PGN, reviews it and reads the rows back', async () => {
    const app = await instance({ seed: 'empty' });
    const paired = await ctl('pair', '--url', app.url, '--code', app.code);
    expect(paired.json).toMatchObject({ ok: true, token: expect.any(String) });
    const target = ['--url', app.url, '--token', paired.json.token as string];

    const file = join(mkdtempSync(join(tmpdir(), 'pgn-')), 'game.pgn');
    writeFileSync(file, '[White "You"]\n[Black "Them"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n');
    const missingSide = await ctl('import-pgn', '--file', file, ...target);
    expect(missingSide.json).toMatchObject({ ok: false, fix: 'Pass --side white or --side black.' });
    const imported = await ctl('import-pgn', '--file', file, '--side', 'white', ...target);
    expect(imported.json).toMatchObject({ ok: true, duplicate: false, game: { id: 1 } });

    const review = await ctl('review', '--game', '1', ...target);
    expect(review.json).toMatchObject({ ok: true, reopened: false });
    const again = await ctl('review', '--game', '1', ...target);
    expect(again.json).toMatchObject({ ok: true, reopened: true, coachCalls: 0 });

    const games = await ctl('db', 'get', 'games', ...target);
    expect(games.json).toMatchObject({ ok: true, count: 1 });
    const devices = await ctl('db', 'get', 'devices', '--where', 'name=coachctl', ...target);
    expect(devices.json.count).toBe(1);
    expect((await ctl('settings', ...target)).json).toMatchObject({ ok: true, settings: { thinkDeeper: false } });
    expect((await ctl('settings', '--think-deeper', 'on', ...target)).json).toMatchObject({ ok: true, settings: { thinkDeeper: true } });
    expect((await ctl('settings', '--think-deeper', 'maybe', ...target)).json).toMatchObject({ ok: false, fix: 'Pass --think-deeper on or --think-deeper off.' });
  });

  it('every command has --help, and errors name the fix', async () => {
    for (const cmd of ['doctor', 'pair', 'play', 'import-pgn', 'review', 'ask-why', 'settings', 'db', 'screenshot', 'snapshot', 'coach', 'clock', 'cleanup']) {
      const out = await new Promise<string>((resolve) => execFile(process.execPath, [MAIN, cmd, '--help'], (_e, stdout) => resolve(stdout)));
      expect(out, cmd).toMatch(/^Usage: coachctl /);
    }
    const unknown = await ctl('dance');
    expect(unknown.json).toMatchObject({ ok: false, fix: expect.stringContaining('coachctl --help') });
    const noRun = await ctl('db', 'get', 'games');
    expect(noRun.json).toMatchObject({ ok: false, error: 'No running verify-mode instance found.', fix: 'Start one with: npm run verify' });
  });

  it('cleanup --dry-run changes nothing', async () => {
    const out = await ctl('cleanup', '--dry-run');
    expect(out.json).toMatchObject({ ok: true, dryRun: true, runs: [] });
  });
});
