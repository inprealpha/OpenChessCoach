// The verify-mode process that `npm run verify` starts in the background. It runs one instance
// and records itself in its run file; SIGTERM stops it and removes its data folder.
import { parseArgs, quietSqliteWarning } from '../runtime.ts';

quietSqliteWarning();
const { pairUrl } = await import('../network.ts');
const { startVerifyInstance } = await import('./instance.ts');
const { readRun, writeRun } = await import('./runs.ts');
type Seed = import('./runs.ts').Seed;

const { flags } = parseArgs(process.argv.slice(2));
const runFile = String(flags['run-file']);
const run = readRun(runFile);
if (!run) {
  process.stderr.write(`No run file at ${runFile}.\n`);
  process.exit(2);
}

try {
  const instance = await startVerifyInstance({
    seed: run.seed as Seed,
    dataDir: run.dataDir,
    ...(flags.port ? { port: Number(flags.port) } : {}),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  writeRun(runFile, {
    ...run,
    status: 'ready',
    pid: process.pid,
    url: instance.url,
    pairUrl: pairUrl(instance.url, instance.code),
    code: instance.code,
    token: instance.token,
  });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await instance.stop({ keepData: true });
    writeRun(runFile, { ...(readRun(runFile) ?? run), status: 'stopped' });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch (err) {
  writeRun(runFile, { ...run, status: 'failed', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
