// Stockfish compiled to WebAssembly, running in a Web Worker so the board never freezes (ADR 0003).
import { UciEngine, type UciEngineOptions } from '@chess-coach/shared/uci-engine';

export class BrowserEngine extends UciEngine {
  constructor(options: UciEngineOptions) {
    const file = options.threads > 1 ? 'stockfish-18-lite.js' : 'stockfish-18-lite-single.js';
    const worker = new Worker(`/engine/${file}`);
    super(
      {
        send: (cmd) => worker.postMessage(cmd),
        listen: (handler) => {
          worker.onmessage = (e: MessageEvent) => handler(String(e.data));
        },
        onError: (handler) => {
          worker.onerror = (e: ErrorEvent) => {
            e.preventDefault();
            handler(new Error(e.message || 'The Engine could not load.'));
          };
        },
        close: () => worker.terminate(),
      },
      options,
    );
  }
}
