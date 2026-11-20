import { describe, expect, it } from 'vitest';
import type { Brief } from '@chess-coach/shared/coach/brief';
import type { CoachRawReply } from '@chess-coach/shared/coach/types';
import type { CoachBack, CoachCall, CoachPort } from '../src/coach/port.ts';
import { CoachRouter } from '../src/coach/router.ts';

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
  provider: 'claude' | 'codex' | 'pi',
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
      unavailableReasons: { pi: 'Pi is not logged in.' },
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
    ]);

    // Recovery watch forwards only from the currently active provider
    const backs: CoachBack[] = [];
    router.watch((b) => backs.push(b));
    claude.fireBack({});
    expect(backs).toHaveLength(0);
    codex.fireBack({});
    expect(backs).toHaveLength(1);
  });
});
