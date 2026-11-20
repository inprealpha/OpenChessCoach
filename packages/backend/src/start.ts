// The one command the owner runs (ADR 0001): checks Coach backends (Claude, Codex, Pi), serves the
// app on the LAN, prints a QR code that pairs a phone, and opens the desktop browser already paired.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoachProvider } from '@chess-coach/shared/protocol';
import { checkClaude } from './claude-check.ts';
import { systemClock } from './clock.ts';
import { CodexCoach } from './coach/codex.ts';
import { PiCoach } from './coach/pi.ts';
import type { CoachPort } from './coach/port.ts';
import { RealCoach } from './coach/real.ts';
import { CoachRouter, PROVIDER_LABELS } from './coach/router.ts';
import { checkCodex } from './codex-check.ts';
import { desktopThreads } from './engine/node-engine.ts';
import { firewallAdvice, isLoopbackHost, systemPromptWarning } from './firewall.ts';
import { pairUrl, qrTerminal } from './network.ts';
import { defaultDataDir } from './paths.ts';
import { checkPi } from './pi-check.ts';
import { appVersion, startOptions, webRoot } from './runtime.ts';
import { startApp } from './server.ts';
import { getSettings, updateSettings } from './settings.ts';
import { ModelDownloader } from './tempting-moves/download.ts';
import { OpusTemptingMoves } from './tempting-moves/opus.ts';
import type { TemptingMovesPort } from './tempting-moves/port.ts';
import { TemptingMovesService } from './tempting-moves/service.ts';

const HELP = `Usage: npx openchesscoach@latest [options]

Starts OpenChessCoach on this desktop and prints a QR code to pair your phone.

Options:
  --port <n>          Port to serve on (default 8737)
  --host <address>    Interface to bind (default 0.0.0.0, every interface on this desktop)
  --data-dir <path>   Where your games and Player Profile live (default: ${defaultDataDir()})
  --coach <backend>   Coach backend to use: claude, codex, or pi (auto-detected when omitted)
  --no-open           Don't open the desktop browser
  --version, -v       Show the version
  --help, -h          Show this help
`;

const NOOP_TEMPTING_MOVES: TemptingMovesPort = {
  name: 'opus',
  suggest: async () => ({ moves: [] }),
};

async function main(): Promise<void> {
  const options = startOptions(process.argv.slice(2));
  if (options.do === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (options.do === 'version') {
    process.stdout.write(`OpenChessCoach ${appVersion()}\n`);
    return;
  }
  if (options.do === 'error') {
    process.stderr.write(`\n✗ ${options.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const { port, host } = options;
  const dataDir = options.dataDir ?? defaultDataDir();

  const [claude, codex, pi] = await Promise.all([checkClaude(), checkCodex(), checkPi()]);

  const providers: Partial<Record<CoachProvider, CoachPort>> = {};
  const unavailableReasons: Partial<Record<CoachProvider, string>> = {};
  let claudeCoach: RealCoach | undefined;

  if (claude.ok) {
    claudeCoach = new RealCoach(claude.path ? { claudePath: claude.path } : {});
    providers.claude = claudeCoach;
  } else {
    unavailableReasons.claude = claude.message;
  }
  if (codex.ok) {
    providers.codex = new CodexCoach(codex.path ? { codexPath: codex.path } : {});
  } else {
    unavailableReasons.codex = codex.message;
  }
  if (pi.ok) {
    providers.pi = new PiCoach();
  } else {
    unavailableReasons.pi = pi.message;
  }

  let initial: CoachProvider | undefined = options.coach;
  if (initial) {
    if (!providers[initial]) {
      process.stderr.write(`\n✗ ${unavailableReasons[initial] ?? `${PROVIDER_LABELS[initial]} is not available.`}\n\n`);
      process.exit(2);
    }
  } else {
    initial = (['claude', 'codex', 'pi'] as const).find((p) => Boolean(providers[p]));
    if (!initial) {
      process.stderr.write(
        `\n✗ No Coach backend is logged in on this desktop.\n\n` +
          `  Claude: ${unavailableReasons.claude}\n` +
          `  Codex:  ${unavailableReasons.codex}\n` +
          `  Pi:     ${unavailableReasons.pi}\n\n`,
      );
      process.exit(2);
    }
  }

  const coach = new CoachRouter({ providers, initial, unavailableReasons });

  const log = (line: string) => process.stdout.write(`  ${line}\n`);
  // The moves a Player would reach for (ADR 0011): Maia-3, downloaded in the background into the
  // data folder; Opus answers until it is ready when Claude is available.
  const temptingMoves = new TemptingMovesService({
    local: { downloader: new ModelDownloader({ dir: join(dataDir, 'models'), log }), threads: desktopThreads() },
    fallback: claude.ok ? new OpusTemptingMoves(claude.path ? { claudePath: claude.path } : {}) : NOOP_TEMPTING_MOVES,
    log,
  });
  // Said before the app starts listening, which is when Windows or macOS asks about Node.js (#31).
  const listenOnLan = !isLoopbackHost(host);
  const warning = listenOnLan ? systemPromptWarning() : undefined;
  if (warning) process.stdout.write(`\n${warning}\n`);
  /** On Linux, the command that lets the Wi-Fi through a firewall that is on: looked for once, printed under each QR code. */
  let firewall: Promise<string | undefined> | undefined;
  const app = await startApp({
    dataDir,
    host,
    port,
    webRoot: webRoot(),
    verify: false,
    coach,
    clock: systemClock,
    version: appVersion(),
    engine: { depth: 14, multiPv: 5, singleThread: false },
    temptingMoves,
    log,
    onEvent: (event) => {
      if (event.kind === 'tunnel' && event.tunnel.status === 'running' && event.tunnel.url) {
        const url = pairUrl(event.tunnel.url, app.pairing.code);
        qrTerminal(url).then((qr) => {
          process.stdout.write(`\nAway-from-home address: ${event.tunnel.url}\nScan to pair over the tunnel:\n${qr}\n`);
        });
      }
      if (event.kind === 'pairing-reset') void printQr();
    },
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`\n✗ Port ${port} is already in use. Is the coach already running? Otherwise start it with --port <another port>.\n\n`);
      process.exit(1);
    }
    throw err;
  });

  // Align the active router provider with saved Settings when --coach wasn't forced on the CLI.
  const saved = getSettings(app.db);
  let activeProvider: CoachProvider = initial;
  if (options.coach) {
    activeProvider = options.coach;
    if (saved.coachProvider !== options.coach) updateSettings(app.db, { coachProvider: options.coach });
  } else if (providers[saved.coachProvider]) {
    activeProvider = saved.coachProvider;
    if (saved.coachProvider !== initial) await app.coach.switchProvider(saved.coachProvider);
  } else {
    updateSettings(app.db, { coachProvider: initial });
  }

  // Only check Claude's login when Claude is actually the effective active backend (not when
  // saved Settings or --coach selected Codex or Pi).
  const skip = process.env.CHESS_COACH_SKIP_LOGIN_CHECK === '1';
  const shouldCheckClaude = activeProvider === 'claude' && claudeCoach !== undefined;
  if (shouldCheckClaude) {
    process.stdout.write(skip ? '\nSkipping the Claude login check (CHESS_COACH_SKIP_LOGIN_CHECK=1).\n' : '\nChecking your Claude login…\n');
  } else {
    process.stdout.write(`\nUsing ${PROVIDER_LABELS[activeProvider]} as the Coach backend.\n`);
  }
  const login =
    activeProvider === 'claude' && claudeCoach && !skip ? await claudeCoach.checkLogin() : ({ state: 'ok' } as const);
  if (login.state === 'refused') {
    process.stderr.write(`\n✗ ${login.message} Then start the app again.\n\n`);
    await app.close();
    process.exit(2);
  }
  if (login.state === 'limit') {
    const until = login.resetsAt ? ` until ${login.resetsAt.toLocaleString()}` : '';
    process.stdout.write(`  Your Claude login works, but your usage limit is reached${until}. The Coach answers again after that.\n`);
  } else if (login.state === 'unknown') {
    const why = /[.!?]$/.test(login.message) ? login.message : `${login.message}.`;
    process.stdout.write(`  Couldn’t confirm your Claude login: ${why} Starting anyway; the Coach says so if Claude turns the login down.\n`);
  } else if (shouldCheckClaude && !skip) {
    process.stdout.write('  Claude Code is logged in and Claude answers.\n');
  }

  writeFileSync(
    join(dataDir, 'instance.json'),
    JSON.stringify({ pid: process.pid, port: app.port, url: app.localUrl, lanUrl: app.lanUrl, version: appVersion(), dataDir }, null, 2),
  );
  // Only once the app is up: the download waits a little more, then runs in the background.
  temptingMoves.start();

  async function printQr(): Promise<void> {
    const url = pairUrl(app.lanUrl, app.pairing.code);
    process.stdout.write(`\nOpenChessCoach ${appVersion()} is running.\n\n`);
    // Already paired, like the browser this command opens: with --no-open, or when no browser
    // opens, it is the link to copy.
    process.stdout.write(`  On this desktop:  ${pairUrl(app.localUrl, app.pairing.code)}\n`);
    process.stdout.write(`  On your Wi-Fi:    ${app.lanUrl}\n`);
    process.stdout.write(`  Pairing code:     ${app.pairing.code}\n\n`);
    process.stdout.write(`Scan this with your phone (same Wi-Fi) to open the app already paired:\n${await qrTerminal(url)}\n`);
    process.stdout.write(`${url}\n\n`);
    firewall ??= listenOnLan ? firewallAdvice(new URL(app.lanUrl).hostname, app.port) : Promise.resolve(undefined);
    const advice = await firewall;
    if (advice) process.stdout.write(`${advice}\n`);
    if (listenOnLan) {
      process.stdout.write('Phone can’t open it? The page on this desktop offers another way after a couple of minutes,\nand Settings has it under Away from home.\n\n');
    }
    process.stdout.write('Press Ctrl+C to stop.\n\n');
  }
  await printQr();

  if (options.open) openBrowser(pairUrl(app.localUrl, app.pairing.code));

  const stop = async () => {
    process.stdout.write('\nStopping…\n');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => process.stdout.write(`  Open ${url} in your browser.\n`));
    child.unref();
  } catch {
    process.stdout.write(`  Open ${url} in your browser.\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
