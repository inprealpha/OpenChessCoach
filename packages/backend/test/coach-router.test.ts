import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import { INITIAL_FEN } from '@chess-coach/shared/chess';
import { FakeClock } from '../src/clock.ts';
import { openDb } from '../src/db.ts';
import { CoachLimitError, type CoachBack, type CoachCall, type CoachPort } from '../src/coach/port.ts';
import { CoachRouter } from '../src/coach/router.ts';
import { CoachService } from '../src/coach/service.ts';

const BRIEF: Brief = {
  job: 'why',
  level: 'casual',
  sideToMove: 'white',
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  recentMoves: '1. e4',
  candidates: [],
  maxWords: 60,
  allowNote: false,
  hideMoves: false,
};

function stubPort(
  name: CoachPort['name'],
  provider: 'claude' | 'codex' | 'pi' | 'opencode',
  supportsEngineTool: boolean,
  replyText: string,
): CoachPort & { fireBack: (b: CoachBack) => void } {
  let listener: ((b: CoachBack) => void) | undefined;
  return {
    name,
    provider,
    supportsEngineTool,
    async status() {
      return { state: 'ready', provider };
    },
    async ask(_call: CoachCall, onText: (d: string) => void): Promise<CoachRawReply> {
      onText(replyText);
      return { text: replyText, moves: [], arrows: [], highlights: [], note: null };
    },
    watch(fn) {
      listener = fn;
    },
    fireBack(b) {
      listener?.(b);
    },
  };
}

describe('CoachRouter', () => {
  it('delegates to the active provider, switches live, lists all providers, and forwards recovery events', async () => {
    const claude = stubPort('real', 'claude', true, 'From Claude');
    const codex = stubPort('codex', 'codex', false, 'From Codex');

    const router = new CoachRouter({
      providers: { claude, codex },
      initial: 'claude',
      unavailableReasons: { pi: 'Pi is not logged in.', opencode: 'OpenCode CLI not found.' },
    });

    expect(router.provider).toBe('claude');
    expect(router.supportsEngineTool).toBe(true);
    expect((await router.ask({ job: 'why', model: 'haiku', brief: BRIEF }, () => {})).text).toBe('From Claude');

    // Switch to Codex
    router.switchProvider('codex');
    expect(router.provider).toBe('codex');
    expect(router.supportsEngineTool).toBe(false);
    expect((await router.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).text).toBe('From Codex');

    // Switching to an unavailable provider reports unavailable status and throws CoachUnavailableError on ask()
    router.switchProvider('pi');
    expect(await router.status()).toEqual({ state: 'unavailable', provider: 'pi', reason: 'Pi is not logged in.' });
    await expect(router.ask({ job: 'why', model: 'default', brief: BRIEF }, () => {})).rejects.toThrow(/Pi is not logged in/);
    router.switchProvider('codex');

    // List providers includes available and unavailable entries
    const list = await router.listProviders();
    expect(list).toEqual([
      { provider: 'claude', label: 'Claude', available: true, supportsEngineTool: true },
      { provider: 'codex', label: 'Codex', available: true, supportsEngineTool: false },
      { provider: 'pi', label: 'Pi', available: false, reason: 'Pi is not logged in.', supportsEngineTool: true },
      { provider: 'opencode', label: 'OpenCode', available: false, reason: 'OpenCode CLI not found.', supportsEngineTool: false },
    ]);

    // Recovery watch forwards only from the currently active provider
    const backs: CoachBack[] = [];
    router.watch((b) => backs.push(b));
    claude.fireBack({});
    expect(backs).toHaveLength(0);
    codex.fireBack({});
    expect(backs).toHaveLength(1);
  });

  it('names the active provider in usage-limit messages instead of hardcoding Claude', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chess-coach-limit-provider-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb(dir);
    onTestFinished(() => db.close());
    const clock = new FakeClock(new Date('2026-10-12T12:00:00Z'));

    const limitedPort = (name: CoachPort['name'], provider: 'claude' | 'codex' | 'pi' | 'opencode'): CoachPort => ({
      name,
      provider,
      async status() {
        return { state: 'ready', provider };
      },
      async ask() {
        throw new CoachLimitError('limit reached', new Date('2026-10-12T12:15:00Z'));
      },
    });

    const router = new CoachRouter({
      providers: {
        claude: limitedPort('real', 'claude'),
        codex: limitedPort('codex', 'codex'),
        pi: limitedPort('pi', 'pi'),
        opencode: limitedPort('opencode', 'opencode'),
      },
      initial: 'claude',
    });
    const service = new CoachService(db, clock, router);

    const ask = {
      job: 'why' as const,
      fen: INITIAL_FEN,
      recentMoves: [],
      candidates: [{ uci: 'e2e4', san: 'e4', score: { cp: 30 }, pv: ['e2e4'] }],
      question: 'Why e4?',
    };

    for (const [provider, label] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ['pi', 'Pi'],
      ['opencode', 'OpenCode'],
    ] as const) {
      await service.switchProvider(provider);
      await expect(service.ask(ask, () => {})).rejects.toMatchObject({
        code: 'coach-limit',
        message: expect.stringContaining(`Your ${label} usage limit has been reached.`),
      });
      const status = await service.status();
      expect(status).toMatchObject({
        state: 'limit-reached',
        provider,
        reason: expect.stringContaining(`Your ${label} usage limit has been reached.`),
      });
    }
  });
});
