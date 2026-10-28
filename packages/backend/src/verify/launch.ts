// `npm run verify`: starts a disposable verify-mode instance in the background and prints it as
// JSON once a pairing handshake has succeeded. Stop it with `npm run coachctl -- cleanup`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, webRoot } from '../runtime.ts';
import { evidenceRoot, newRunId, readRun, runFilePath, SEEDS, stateDir, writeRun } from './runs.ts';

const HELP = `Usage: npm run verify -- [options]

Starts a disposable copy of the app in verify mode: fake Coach, fake clock, Engine at a fixed
depth, a fresh data folder with seeded data and a free port. Prints JSON once a device has paired.

Options:
  --seed <name>       ${SEEDS.join(' or ')} (default: default). "empty" shows the first-run screen;
                      "many-games" adds 60 games, more than one page of the game list;
                      "no-phone" has no phone paired, so the main menu asks for one.
  --port <n>          Port to use (default: a free one, never the owner's 8737)
  --state-dir <path>  Where run files go (default: .verify)
  --help              Show this help

Next: npm run coachctl -- doctor
`;

function fail(error: string, fix: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error, fix }, null, 2)}\n`);
  process.exit(1);
}

const { flags } = parseArgs(process.argv.slice(2), ['help']);
if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const seed = typeof flags.seed === 'string' ? flags.seed : 'default';
if (!(SEEDS as readonly string[]).includes(seed)) fail(`Unknown seed "${seed}".`, `Use --seed ${SEEDS.join(' or --seed ')}.`);
if (!existsSync(join(webRoot(), 'index.html'))) fail('The web app is not built.', 'Run: npm run build -w @chess-coach/web');

const state = stateDir(flags['state-dir']);
const runId = newRunId();
const runFile = runFilePath(state, runId);
const evidenceDir = join(evidenceRoot(), runId);
mkdirSync(evidenceDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), `chess-coach-${runId}-`));
const logFile = join(state, 'runs', `${runId}.log`);
writeRun(runFile, {
  runId,
  status: 'starting',
  pid: 0,
  url: '',
  pairUrl: '',
  code: '',
  token: '',
  dataDir,
  evidenceDir,
  seed,
  startedAt: new Date().toISOString(),
  logFile,
});

const serve = fileURLToPath(new URL('./serve.ts', import.meta.url));
const out = openSync(logFile, 'a');
const child = spawn(process.execPath, [serve, '--run-file', runFile, ...(flags.port ? ['--port', String(flags.port)] : [])], {
  detached: true,
  stdio: ['ignore', out, out],
});
child.unref();

const deadline = Date.now() + 30_000;
for (;;) {
  const run = readRun(runFile);
  if (run?.status === 'ready') {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          runId,
          url: run.url,
          pairUrl: run.pairUrl,
          code: run.code,
          token: run.token,
          pid: run.pid,
          dataDir,
          evidenceDir,
          runFile,
          next: 'npm run coachctl -- doctor',
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }
  if (run?.status === 'failed') fail(`The instance failed to start: ${run.error}`, `See the log at ${logFile}.`);
  if (child.exitCode !== null) fail(`The instance exited with code ${child.exitCode}.`, `See the log at ${logFile}.`);
  if (Date.now() > deadline) fail('The instance did not become ready within 30 seconds.', `See the log at ${logFile}, then run: npm run coachctl -- cleanup --run ${runId}`);
  await new Promise((r) => setTimeout(r, 100));
}
