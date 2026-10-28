// onnxruntime's WebAssembly build, run under Node: one 12 MB .wasm file that is the same on every
// platform, so the npm package needs no native module (ADR 0011). Three files: ort.node.min.js,
// ort-wasm-simd-threaded.mjs and ort-wasm-simd-threaded.wasm.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Ort from 'onnxruntime-web';

export type OrtModule = typeof Ort;

let loaded: Promise<OrtModule> | undefined;

/**
 * The runtime, loaded once per process. In the npm package its three files sit next to the bundle
 * (`ort/`, copied by the build); in the repo they come from node_modules.
 */
export function loadOrt(threads: number): Promise<OrtModule> {
  loaded ??= load(threads);
  // A runtime that failed to load can be tried again.
  loaded.catch(() => (loaded = undefined));
  return loaded;
}

async function load(threads: number): Promise<OrtModule> {
  const dir = ortDir();
  // The Node build, through Node's own require: test runners that wrap import() would run the ES
  // module builds through their loader, where they can't find their files.
  const ort = createRequire(import.meta.url)(join(dir, 'ort.node.min.js')) as OrtModule;
  // Node's fetch can't read files, so the runtime gets the .wasm file's bytes, and the URL of the
  // small module that starts it (and its worker threads).
  ort.env.wasm.wasmBinary = readFileSync(join(dir, 'ort-wasm-simd-threaded.wasm'));
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(dir, 'ort-wasm-simd-threaded.mjs')).href };
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  return ort;
}

function ortDir(): string {
  const packaged = fileURLToPath(new URL('./ort/', import.meta.url));
  if (existsSync(join(packaged, 'ort.node.min.js'))) return packaged;
  const require = createRequire(import.meta.url);
  // The package exports the .wasm file itself; the other two files sit beside it in dist/.
  return dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
}
