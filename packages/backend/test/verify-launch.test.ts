// npm run verify (verify/launch.ts) as a process: which Coach a run uses. --real-coach is for a preview
// where the Coach is the change (.claude/skills/sandbox/SKILL.md); every other run keeps the fake one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LAUNCH = fileURLToPath(new URL('../src/verify/launch.ts', import.meta.url));
const CTL = fileURLToPath(new URL('../src/coachctl/main.ts', import.meta.url));
const node = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args], { encoding: 'utf8', env });

describe('npm run verify', () => {
  it('records which Coach a run uses: the fake one, or the real one with --real-coach', () => {
    for (const [args, coach] of [[[], 'fake'], [['--real-coach'], 'real']] as const) {
      const state = mkdtempSync(join(tmpdir(), 'verify-launch-'));
      // No Claude login here (an empty home), so the real Coach can't spend anything.
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: state, CHESS_COACH_EVIDENCE_DIR: join(state, 'evidence') };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      const run = JSON.parse(node(LAUNCH, [...args, '--state-dir', state], env)) as { ok: boolean; runId: string; runFile: string; coach: string };
      try {
        expect(run.ok).toBe(true);
        expect(run.coach).toBe(coach);
        expect(JSON.parse(readFileSync(run.runFile, 'utf8')).coach).toBe(coach);
      } finally {
        node(CTL, ['cleanup', '--run', run.runId, '--state-dir', state], env);
      }
    }
  }, 90_000);
});
