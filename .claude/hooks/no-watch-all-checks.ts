// A Claude Code hook (PreToolUse, Bash; wired in .claude/settings.json): stops a session from
// waiting for every check on a PR. The "Verdict" and "real Coach" statuses stay pending whenever no
// judge is running (on a draft, and after a push until /verdict), so `gh pr checks --watch` would
// wait forever and the session would never wake. scripts/wait-ci.ts waits for CI only.
// Exit 2 blocks the command and shows the session the message on stderr; anything else lets it run.
// settings.json starts it only for commands that mention both "checks" and "--watch".
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MESSAGE =
  'Blocked: `gh pr checks --watch` waits for every check, and the Verdict and real Coach statuses stay ' +
  'pending until a judge runs, so it can wait forever. Wait for CI only, with a time limit: ' +
  '`npm run -s wait:ci -- <pr>` (scripts/wait-ci.ts). To see the state once, `gh pr checks <pr>` without --watch is fine.';

/** The command as the shell runs it: line continuations joined, heredoc bodies and quoted text dropped. */
export function runnable(command: string): string {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** True when the shell command waits for every check of a PR. */
export function watchesAllChecks(command: string): boolean {
  return /\bgh\s+(?:(?:-R|--repo)[=\s]+\S+\s+)?pr\s+checks\b[^;&|\n]*\s--watch\b/.test(runnable(command));
}

const main = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (main) {
  let command = '';
  try {
    command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
  } catch {
    process.exit(0);
  }
  if (watchesAllChecks(command)) {
    console.error(MESSAGE);
    process.exit(2);
  }
}
