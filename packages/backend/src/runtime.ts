// Small runtime helpers shared by the start command, verify mode and coachctl.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

/** node:sqlite is stable enough for us but still prints an ExperimentalWarning on Node 22. */
export function quietSqliteWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite')) return;
    (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

/** What to tell someone whose Node.js is older than `min` (package.json's engines), or undefined when it is new enough. */
export function nodeTooOld(version: string = process.versions.node, min: string = minNode()): string | undefined {
  const have = version.split('.').map(Number);
  const need = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b ? undefined : tooOldMessage(version, min);
  }
  return undefined;
}

function tooOldMessage(version: string, min: string): string {
  return `OpenChessCoach needs Node.js ${min} or later, and this terminal has Node.js ${version}. Install the LTS version from https://nodejs.org, open a new terminal and run the command again.`;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The built web app: next to the bundle when packaged, in packages/web/dist in the repo. */
export function webRoot(): string {
  const packaged = join(here, 'web');
  if (existsSync(join(packaged, 'index.html'))) return packaged;
  return join(here, '..', '..', 'web', 'dist');
}

/** The app's own package.json: next to the bundle when packaged, one folder up in the repo. */
function ownPackage(): { version?: string; engines?: { node?: string } } | undefined {
  for (const candidate of [join(here, '..', 'package.json'), join(here, 'package.json')]) {
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string; engines?: { node?: string } };
      if (pkg.name === 'openchesscoach') return pkg;
    }
  }
  return undefined;
}

export function appVersion(): string {
  return ownPackage()?.version ?? '0.0.0';
}

/** The oldest Node.js the app runs on, from package.json's engines (">=22.18" gives "22.18"). */
export function minNode(): string {
  return ownPackage()?.engines?.node?.match(/\d+(\.\d+){0,2}/)?.[0] ?? '22.18';
}

/** What the start command was asked to do, or why its arguments make no sense. */
export type StartOptions =
  | { do: 'start'; port: number; host: string; dataDir?: string; open: boolean }
  | { do: 'help' }
  | { do: 'version' }
  | { do: 'error'; message: string };

const START_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  'data-dir': { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/**
 * Reads the start command's arguments strictly: an unknown option, a missing value or a port that
 * isn't one is an error to show, never ignored, since a typo would otherwise start the whole app.
 */
export function startOptions(argv: readonly string[]): StartOptions {
  const { values, tokens } = nodeParseArgs({ args: [...argv], options: START_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  for (const t of tokens) {
    if (t.kind === 'positional') return { do: 'error', message: `Unexpected argument "${t.value}".` };
    if (t.kind !== 'option') continue;
    const known = START_OPTIONS[t.name as keyof typeof START_OPTIONS] as { type: string } | undefined;
    if (!known) return { do: 'error', message: `Unknown option ${t.rawName}.` };
    // `--port --no-open` takes the next option as the port: that is a missing value, not a port.
    if (known.type === 'string' && (t.value === undefined || (!t.inlineValue && /^-\D/.test(t.value)))) {
      return { do: 'error', message: `${t.rawName} needs a value after it.` };
    }
  }
  if (values.help) return { do: 'help' };
  if (values.version) return { do: 'version' };
  const port = typeof values.port === 'string' ? values.port : '8737';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { do: 'error', message: `--port needs a whole number from 1 to 65535, and "${port}" isn't one.` };
  }
  const dataDir = typeof values['data-dir'] === 'string' ? values['data-dir'] : undefined;
  return {
    do: 'start',
    port: Number(port),
    host: typeof values.host === 'string' ? values.host : '0.0.0.0',
    ...(dataDir !== undefined ? { dataDir } : {}),
    open: !values['no-open'],
  };
}

export interface Args {
  flags: Record<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) flags[key] = inline;
      else if (!booleans.includes(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
