// Run files: one JSON file per verify-mode run in .verify/runs/, so coachctl finds the instance
// and cleanup stops only what that run started. Evidence lives apart, in evidence/<runId>/.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SEEDS = ['empty', 'default', 'many-games'] as const;
export type Seed = (typeof SEEDS)[number];

export interface RunFile {
  runId: string;
  status: 'starting' | 'ready' | 'stopped' | 'failed';
  pid: number;
  url: string;
  pairUrl: string;
  code: string;
  token: string;
  dataDir: string;
  evidenceDir: string;
  seed: string;
  startedAt: string;
  logFile: string;
  error?: string;
}

export function stateDir(flag?: string | true): string {
  return resolve(typeof flag === 'string' ? flag : (process.env.CHESS_COACH_VERIFY_DIR ?? '.verify'));
}

export function runsDir(state: string): string {
  return join(state, 'runs');
}

export function evidenceRoot(): string {
  return resolve(process.env.CHESS_COACH_EVIDENCE_DIR ?? 'evidence');
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function runFilePath(state: string, runId: string): string {
  return join(runsDir(state), `${runId}.json`);
}

export function writeRun(path: string, run: RunFile): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(run, null, 2));
  renameSync(`${path}.tmp`, path);
}

export function readRun(path: string): RunFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunFile;
  } catch {
    return undefined;
  }
}

export function listRuns(state: string): RunFile[] {
  const dir = runsDir(state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readRun(join(dir, f)))
    .filter((r): r is RunFile => r !== undefined)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
