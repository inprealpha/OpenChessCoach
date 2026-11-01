// The one command the owner runs (ADR 0001): checks Claude Code, serves the app on the LAN,
// prints a QR code that pairs a phone, and opens the desktop browser already paired.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaude } from './claude-check.ts';
import { systemClock } from './clock.ts';
import { RealCoach } from './coach/real.ts';
import { desktopThreads } from './engine/node-engine.ts';
import { firewallAdvice, isLoopbackHost, systemPromptWarning } from './firewall.ts';
import { pairUrl, qrTerminal } from './network.ts';
import { defaultDataDir } from './paths.ts';
import { appVersion, startOptions, webRoot } from './runtime.ts';
import { startApp } from './server.ts';
import { ModelDownloader } from './tempting-moves/download.ts';
import { OpusTemptingMoves } from './tempting-moves/opus.ts';
import { TemptingMovesService } from './tempting-moves/service.ts';

const HELP = `Usage: npx openchesscoach@latest [options]

Starts OpenChessCoach on this desktop and prints a QR code to pair your phone.

Options:
  --port <n>          Port to serve on (default 8737)
  --host <address>    Interface to bind (default 0.0.0.0, every interface on this desktop)
  --data-dir <path>   Where your games and Player Profile live (default: ${defaultDataDir()})
  --no-open           Don't open the desktop browser
  --version, -v       Show the version
  --help, -h          Show this help
`;

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

  const claude = await checkClaude();
  if (!claude.ok) {
    process.stderr.write(`\n✗ ${claude.message}\n\n`);
    process.exit(2);
  }
  // Claude Code saying it is logged in isn't enough: a login that expired still says so. One short
  // call finds out now, rather than when the Player first asks the Coach.
  const coach = new RealCoach(claude.path ? { claudePath: claude.path } : {});
  // The package check's stand-in `claude` has no login for Claude to take, so it skips the call.
  const skip = process.env.CHESS_COACH_SKIP_LOGIN_CHECK === '1';
  if (!skip) process.stdout.write('\nChecking your Claude login…\n');
  const login = skip ? ({ state: 'ok' } as const) : await coach.checkLogin();
  if (login.state === 'refused') {
    process.stderr.write(`\n✗ ${login.message} Then start the app again.\n\n`);
    process.exit(2);
  }
  if (login.state === 'limit') {
    const until = login.resetsAt ? ` until ${login.resetsAt.toLocaleString()}` : '';
    process.stdout.write(`  Your Claude login works, but your usage limit is reached${until}. The Coach answers again after that.\n`);
  } else if (login.state === 'unknown') {
    process.stdout.write(`  Couldn’t confirm your Claude login: ${login.message} Starting anyway; the Coach says so if Claude turns the login down.\n`);
  } else if (!skip) {
    process.stdout.write('  Claude Code is logged in and Claude answers.\n');
  }

  const log = (line: string) => process.stdout.write(`  ${line}\n`);
  // The moves a Player would reach for (ADR 0011): Maia-3, downloaded in the background into the
  // data folder; Opus answers until it is ready.
  const temptingMoves = new TemptingMovesService({
    local: { downloader: new ModelDownloader({ dir: join(dataDir, 'models'), log }), threads: desktopThreads() },
    fallback: new OpusTemptingMoves(claude.path ? { claudePath: claude.path } : {}),
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
