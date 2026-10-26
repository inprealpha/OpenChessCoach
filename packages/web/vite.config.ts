import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);

/** Copies the Stockfish WebAssembly builds next to the app (ADR 0003). */
function stockfish(): Plugin {
  const copy = () => {
    const bin = join(dirname(require.resolve('stockfish/package.json')), 'bin');
    const out = join(import.meta.dirname, 'public', 'engine');
    mkdirSync(out, { recursive: true });
    for (const f of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm', 'stockfish-18-lite.js', 'stockfish-18-lite.wasm']) {
      copyFileSync(join(bin, f), join(out, f));
    }
  };
  return { name: 'copy-stockfish', buildStart: copy };
}

/** Writes dist/sw.js with every built file in its precache list, so the app opens with the desktop unreachable. */
function serviceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir.startsWith('/') ? config.build.outDir : join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name !== 'sw.js') files.push(`/${relative(outDir, full).split('\\').join('/')}`);
        }
      };
      walk(outDir);
      files.sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const template = readFileSync(join(import.meta.dirname, 'src', 'sw-template.js'), 'utf8');
      const sw = template
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__FILES__', JSON.stringify(['/', ...files.filter((f) => f !== '/index.html')]));
      // A placeholder left in would stop the service worker from ever installing.
      if (/__(VERSION|FILES)__/.test(sw)) throw new Error('sw-template.js must use __VERSION__ and __FILES__ exactly once each.');
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

const backend = process.env.COACH_BACKEND ?? 'http://127.0.0.1:8737';

export default defineConfig({
  plugins: [stockfish(), svelte(), serviceWorker()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': backend,
      '/__verify': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
