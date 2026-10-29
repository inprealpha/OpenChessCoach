// coachctl: drives a running app the way a client does, for agents and CI. Every command
// prints JSON, takes --help, and names the fix when it fails. Destructive ones take --dry-run.
import { parseArgs, quietSqliteWarning } from '../runtime.ts';
import { CtlError, commands, print } from './commands.ts';

quietSqliteWarning();

const HELP = `Usage: coachctl <command> [options]

Drives a running OpenChessCoach. Output is JSON. Every command takes --help.

Commands:
  doctor            Read-only health check of an instance
  pair              Pair a new device and print its token
  play              Play moves against the Engine (grades each of your moves)
  import-pgn        Import a PGN as an Imported Game
  review            Grade a game and start (or reopen) its Review
  ask-why           Ask the Coach a Why Question about a move
  settings          Print the settings; turn Think deeper on or off
  db get <table>    Read a table back (verify mode)
  screenshot        Save a screenshot of a screen of the web app
  snapshot          Save an accessibility snapshot of a screen of the web app
  coach             Script the fake Coach or set its status (verify mode)
  clock             Set or advance the fake clock (verify mode)
  cleanup           Stop verify-mode runs and delete their data, keeping evidence

Picking the instance (any command):
  --run <runId>     A verify-mode run from .verify/runs (default: the newest running one)
  --url <url>       Any instance, with --token <device token>
  --state-dir <dir> Where run files live (default: .verify)

Start a verify-mode instance with: npm run verify
`;

/**
 * Exits once stdout has taken all the output: into a pipe, `process.exit` straight after a large
 * write would cut it off at 128 KB (`coachctl db get … | jq`).
 */
async function exit(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}

const argv = process.argv.slice(2);
const name = argv[0];
const { flags, positional } = parseArgs(argv.slice(1), ['help', 'dry-run', 'all', 'resign', 'limit', 'unavailable', 'clear', 'ready', 'full-page', 'json']);

if (!name || name === '--help' || name === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
const command = commands[name];
if (!command) {
  print({ ok: false, error: `Unknown command "${name}".`, fix: `Run coachctl --help to see the commands: ${Object.keys(commands).join(', ')}.` });
  process.exit(1);
}
if (flags.help) {
  process.stdout.write(command.help);
  process.exit(0);
}
try {
  const result = await command.run(flags, positional);
  print(result);
  await exit(result.ok === false ? 1 : 0);
} catch (err) {
  if (err instanceof CtlError) print({ ok: false, error: err.message, fix: err.fix });
  else print({ ok: false, error: err instanceof Error ? err.message : String(err), fix: 'Run coachctl doctor to check the instance.' });
  await exit(1);
}
