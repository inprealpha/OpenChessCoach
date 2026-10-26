// The same Stockfish builds the browser uses, run under Node: single-threaded for coachctl, the
// tests and verify mode, so a position gets the same evaluation in both places, and multi-threaded
// for the desktop's Coach work (ADR 0007).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UciEngine } from '@chess-coach/shared/uci-engine';

const require = createRequire(import.meta.url);

interface StockfishModule {
  listener?: (line: string) => void;
  sendCommand(cmd: string): void;
}

type InitEngine = (path: string) => Promise<StockfishModule>;

type Build = 'lite' | 'lite-single';

const shared = new Map<Build, Promise<UciEngine>>();

/**
 * The process's Engine for a thread count: 1 is the single-threaded build used by coachctl, the
 * tests and verify mode (deterministic); more is the multi-threaded build the desktop uses for
 * Coach work (ADR 0007). A WebAssembly build can only be loaded once per process, so every caller
 * of a build shares it, with the thread count of the first; searches queue one after another.
 * `dispose()` only stops the current search, because the build's "quit" command exits the whole
 * process.
 */
export function createNodeEngine(threads = 1): Promise<UciEngine> {
  const build: Build = threads > 1 ? 'lite' : 'lite-single';
  let engine = shared.get(build);
  if (!engine) {
    engine = load(build, threads);
    shared.set(build, engine);
    // A build that failed to load can be tried again.
    engine.catch(() => shared.delete(build));
  }
  return engine;
}

/** Threads for the desktop's Engine: all but one core, between 1 and 4. */
export function desktopThreads(cores = availableParallelism()): number {
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * In the npm package the loader sits next to the bundle and the engine is the web app's own copy
 * (the full stockfish package is far too big to install with npx); in the repo both come from
 * node_modules.
 */
function stockfish(build: Build): { init: InitEngine; engine: string } {
  const packaged = fileURLToPath(new URL('./stockfish/index.cjs', import.meta.url));
  if (existsSync(packaged)) {
    const file = build === 'lite' ? 'stockfish-18-lite.js' : 'stockfish-18-lite-single.js';
    return { init: require(packaged) as InitEngine, engine: fileURLToPath(new URL(`./web/engine/${file}`, import.meta.url)) };
  }
  return { init: require('stockfish') as InitEngine, engine: build };
}

async function load(build: Build, threads: number): Promise<UciEngine> {
  const { init, engine } = stockfish(build);
  // The build prints a banner while loading, and its loader replaces the global fetch; keep
  // stdout clean for coachctl's JSON and put fetch back.
  const log = console.log;
  const globalFetch = globalThis.fetch;
  console.log = () => undefined;
  let sf: StockfishModule;
  try {
    sf = await init(engine);
  } finally {
    console.log = log;
    globalThis.fetch = globalFetch;
  }
  let handler: ((line: string) => void) | undefined;
  sf.listener = (line) => handler?.(line);
  const uci = new UciEngine(
    {
      send: (cmd) => sf.sendCommand(cmd),
      listen: (h) => {
        handler = h;
      },
      close: () => sf.sendCommand('stop'),
    },
    { threads, deterministic: threads === 1 },
  );
  await uci.whenReady();
  return uci;
}
