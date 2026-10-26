// Builds the npm package: one bundle per command, with the shared chess code inlined, the
// built web app next to them, and the licences. Run after building the web app:
//   npm run build -w @chess-coach/web && npm run build -w openchesscoach
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'rolldown';

const pkg = new URL('../', import.meta.url);
const repo = new URL('../../../', import.meta.url);
const dist = new URL('dist/', pkg);
const web = new URL('packages/web/dist/', repo);

if (!existsSync(new URL('index.html', web))) {
  process.stderr.write('The web app is not built. Run: npm run build -w @chess-coach/web\n');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// One file per command, so paths relative to the bundle (the web app, package.json) hold. The app
// itself is its own file, loaded by cli.js only after node:sqlite's warning is silenced.
const external = [/^node:/, '@anthropic-ai/claude-agent-sdk', 'ws', 'qrcode', 'stockfish', '@playwright/test', 'playwright'];
const entries = [
  ['cli', 'src/cli.ts'],
  ['start', 'src/start.ts'],
  ['coachctl', 'src/coachctl/main.ts'],
] as const;
for (const [name, entry] of entries) {
  await build({
    input: new URL(entry, pkg).pathname,
    platform: 'node',
    // Runtime dependencies stay as imports; Playwright is optional (coachctl screenshot and snapshot).
    external,
    plugins: [
      {
        name: 'start-stays-separate',
        resolveId: (source) => (name === 'cli' && source === './start.ts' ? { id: './start.js', external: true } : null),
      },
    ],
    logLevel: 'warn',
    output: {
      file: new URL(`${name}.js`, dist).pathname,
      format: 'esm',
      ...(name === 'start' ? {} : { banner: '#!/usr/bin/env node' }),
      codeSplitting: false,
    },
  });
}

cpSync(web, new URL('web/', dist), { recursive: true });
// coachctl runs the web app's single-threaded Stockfish under Node, through the stockfish
// package's small loader. The engine files are plain scripts, not ES modules.
const stockfishPkg = new URL('node_modules/stockfish/', repo);
mkdirSync(new URL('stockfish/', dist));
cpSync(new URL('index.js', stockfishPkg), new URL('stockfish/index.cjs', dist));
cpSync(new URL('Copying.txt', stockfishPkg), new URL('stockfish/COPYING.txt', dist));
writeFileSync(new URL('web/engine/package.json', dist), '{ "type": "commonjs" }\n');
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
  if (existsSync(new URL(file, repo))) cpSync(new URL(file, repo), new URL(file, pkg));
}
process.stdout.write(`Built ${dist.pathname}\n`);
