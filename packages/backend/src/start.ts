// The one command the owner runs (ADR 0001): checks Claude Code, serves the app on the LAN,
// prints a QR code that pairs a phone, and opens the desktop browser already paired.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaude } from './claude-check.ts';
import { systemClock } from './clock.ts';
import { RealCoach } from './coach/real.ts';
import { pairUrl, qrTerminal } from './network.ts';
import { defaultDataDir } from './paths.ts';
import { appVersion, startOptions, webRoot } from './runtime.ts';
import { startApp } from './server.ts';

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

  const log = (line: string) => process.stdout.write(`  ${line}\n`);
  const app = await startApp({
    dataDir,
    host,
    port,
    webRoot: webRoot(),
    verify: false,
    coach: new RealCoach(claude.path ? { claudePath: claude.path } : {}),
    clock: systemClock,
    version: appVersion(),
    engine: { depth: 14, multiPv: 5, singleThread: false },
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

  async function printQr(): Promise<void> {
    const url = pairUrl(app.lanUrl, app.pairing.code);
    process.stdout.write(`\nOpenChessCoach ${appVersion()} is running.\n\n`);
    // Already paired, like the browser this command opens: with --no-open, or when no browser
    // opens, it is the link to copy.
    process.stdout.write(`  On this desktop:  ${pairUrl(app.localUrl, app.pairing.code)}\n`);
    process.stdout.write(`  On your Wi-Fi:    ${app.lanUrl}\n`);
    process.stdout.write(`  Pairing code:     ${app.pairing.code}\n\n`);
    process.stdout.write(`Scan this with your phone (same Wi-Fi) to open the app already paired:\n${await qrTerminal(url)}\n`);
    process.stdout.write(`${url}\n\nPress Ctrl+C to stop.\n\n`);
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
