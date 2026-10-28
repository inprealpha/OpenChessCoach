// An Engine that can't start fails loudly instead of leaving its callers waiting.
import { describe, expect, it } from 'vitest';
import { EngineCancelled } from '../src/engine.ts';
import { EngineStartError, UciEngine, type UciTransport } from '../src/uci-engine.ts';

function transport(answer: boolean): UciTransport & { fail(message: string): void } {
  let onLine: (line: string) => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;
  return {
    send: (cmd) => {
      if (!answer) return;
      if (cmd === 'uci') queueMicrotask(() => onLine('uciok'));
      if (cmd === 'isready') queueMicrotask(() => onLine('readyok'));
    },
    listen: (handler) => (onLine = handler),
    onError: (handler) => (onError = handler),
    close: () => undefined,
    fail: (message) => onError(new Error(message)),
  };
}

describe('starting the Engine', () => {
  it('is ready once the Engine answers', async () => {
    await expect(new UciEngine(transport(true), { threads: 1, deterministic: true }).whenReady()).resolves.toBeUndefined();
  });

  it('fails when the Engine never answers', async () => {
    const engine = new UciEngine(transport(false), { threads: 1, deterministic: true, startTimeoutMs: 20 });
    await expect(engine.whenReady()).rejects.toBeInstanceOf(EngineStartError);
  });

  it('fails as soon as the transport reports an error', async () => {
    const t = transport(false);
    const engine = new UciEngine(t, { threads: 4, deterministic: false });
    t.fail('Out of memory');
    await expect(engine.whenReady()).rejects.toThrow('Out of memory');
  });
});

describe('playing a move', () => {
  /** An Engine that answers every search with 1… e5 and records the positions it is given. */
  function recording(): { engine: UciEngine; positions: string[] } {
    const positions: string[] = [];
    let onLine: (line: string) => void = () => undefined;
    const engine = new UciEngine(
      {
        send: (cmd) => {
          if (cmd === 'uci') queueMicrotask(() => onLine('uciok'));
          if (cmd === 'isready') queueMicrotask(() => onLine('readyok'));
          if (cmd.startsWith('position')) positions.push(cmd);
          if (cmd.startsWith('go')) queueMicrotask(() => onLine('bestmove e7e5'));
        },
        listen: (handler) => (onLine = handler),
        close: () => undefined,
      },
      { threads: 1, deterministic: true },
    );
    return { engine, positions };
  }

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

  it('plays from the game’s start and its moves when it has them, so it sees repetitions', async () => {
    const { engine, positions } = recording();
    await expect(engine.bestMove(AFTER_E4, { skill: 20, depth: 4, history: { startFen: START, moves: ['e2e4'] } })).resolves.toBe('e7e5');
    expect(positions).toEqual([`position fen ${START} moves e2e4`]);
  });

  it('plays from the bare position without them', async () => {
    const { engine, positions } = recording();
    await engine.bestMove(AFTER_E4, { skill: 20, depth: 4 });
    await engine.bestMove(START, { skill: 20, depth: 4, history: { startFen: START, moves: [] } });
    expect(positions).toEqual([`position fen ${AFTER_E4}`, `position fen ${START}`]);
  });
});

describe('cancelling a search', () => {
  /** An Engine that answers a search only when told to, and records every command it is sent. */
  function manual(): { engine: UciEngine; sent: string[]; finish: () => void } {
    const sent: string[] = [];
    let onLine: (line: string) => void = () => undefined;
    const engine = new UciEngine(
      {
        send: (cmd) => {
          sent.push(cmd);
          if (cmd === 'uci') queueMicrotask(() => onLine('uciok'));
          if (cmd === 'isready') queueMicrotask(() => onLine('readyok'));
          if (cmd === 'stop') queueMicrotask(() => onLine('bestmove e2e4'));
        },
        listen: (handler) => (onLine = handler),
        close: () => undefined,
      },
      { threads: 1, deterministic: true },
    );
    return { engine, sent, finish: () => onLine('bestmove e2e4') };
  }
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

  it('drops a search that hasn’t started, and stops the one that has, so nobody waits on them', async () => {
    const { engine, sent, finish } = manual();
    await engine.whenReady();
    const stop = new AbortController();
    const running = engine.analyse(START, { multiPv: 1, depth: 10, signal: stop.signal });
    const queued = engine.analyse(AFTER_E4, { multiPv: 1, depth: 10, signal: stop.signal });
    const other = engine.analyse(START, { multiPv: 1, depth: 9 });
    await new Promise((r) => setTimeout(r, 0));
    stop.abort();
    await expect(running).rejects.toBeInstanceOf(EngineCancelled);
    await expect(queued).rejects.toBeInstanceOf(EngineCancelled);
    expect(sent).toContain('stop');
    // The queued search never reached the Engine; the next one, with no signal, still runs.
    expect(sent).not.toContain(`position fen ${AFTER_E4}`);
    await new Promise((r) => setTimeout(r, 0));
    finish();
    await expect(other).resolves.toMatchObject({ fen: START });
  });
});
