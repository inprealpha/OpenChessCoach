// Builds self-contained OpenChessCoach archives that bundle the official signed Node.js runtime
// with the built app and its pure-JS runtime dependencies, so people on stock Windows, macOS or
// Linux can run OpenChessCoach without installing Node.js or npm first.
//
//   node scripts/build-standalone.ts --target current
//   node scripts/build-standalone.ts --target all --out-dir dist-standalone
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Target {
  id: 'win-x64' | 'win-arm64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  nodeExt: 'zip' | 'tar.gz';
  archiveExt: 'zip' | 'tar.gz';
}

export const TARGETS: readonly Target[] = [
  { id: 'win-x64', platform: 'win32', arch: 'x64', nodeExt: 'zip', archiveExt: 'zip' },
  { id: 'win-arm64', platform: 'win32', arch: 'arm64', nodeExt: 'zip', archiveExt: 'zip' },
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', nodeExt: 'tar.gz', archiveExt: 'tar.gz' },
  { id: 'darwin-x64', platform: 'darwin', arch: 'x64', nodeExt: 'tar.gz', archiveExt: 'tar.gz' },
  { id: 'linux-x64', platform: 'linux', arch: 'x64', nodeExt: 'tar.gz', archiveExt: 'tar.gz' },
  { id: 'linux-arm64', platform: 'linux', arch: 'arm64', nodeExt: 'tar.gz', archiveExt: 'tar.gz' },
];

export const DEFAULT_NODE_VERSION = '22.18.0';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CACHE_DIR = join(REPO, '.cache', 'node-dist');

export function currentTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Target {
  const found = TARGETS.find((t) => t.platform === platform && t.arch === arch);
  if (!found) throw new Error(`Unsupported host platform/arch: ${platform}/${arch}`);
  return found;
}

export function resolveTargets(spec: string): Target[] {
  if (spec === 'all') return [...TARGETS];
  if (spec === 'current') return [currentTarget()];
  const ids = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const found = TARGETS.find((t) => t.id === id);
    if (!found) throw new Error(`Unknown target "${id}". Expected one of: ${TARGETS.map((t) => t.id).join(', ')}, current, all`);
    return found;
  });
}

export function archiveName(target: Target): string {
  return `openchesscoach-${target.id}.${target.archiveExt}`;
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function parseShasums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m) map.set((m[2] as string).trim(), (m[1] as string).toLowerCase());
  }
  return map;
}

export function posixLauncher(): string {
  return `#!/bin/sh
set -eu
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
export OPENCHESSCOACH_STANDALONE=1
exec "$DIR/runtime/node" "$DIR/app/dist/cli.js" "$@"
`;
}

export function windowsLauncher(): string {
  return [
    '@echo off',
    'setlocal',
    'set "DIR=%~dp0"',
    'set "OPENCHESSCOACH_STANDALONE=1"',
    '"%DIR%runtime\\node.exe" "%DIR%app\\dist\\cli.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCmd(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchShasums(nodeVersion: string): Promise<Map<string, string>> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `SHASUMS256-v${nodeVersion}.txt`);
  if (existsSync(cachePath)) return parseShasums(readFileSync(cachePath, 'utf8'));
  const url = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  const text = (await fetchBuffer(url)).toString('utf8');
  writeFileSync(cachePath, text);
  return parseShasums(text);
}

async function ensureNodeArchive(target: Target, nodeVersion: string, shasums: Map<string, string>): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const filename = `node-v${nodeVersion}-${target.id}.${target.nodeExt}`;
  const expected = shasums.get(filename);
  if (!expected) throw new Error(`No SHA-256 entry for ${filename} in nodejs.org SHASUMS256.txt`);
  const localPath = join(CACHE_DIR, filename);
  if (existsSync(localPath)) {
    if (sha256File(localPath) === expected) return localPath;
    rmSync(localPath, { force: true });
  }
  const url = `https://nodejs.org/dist/v${nodeVersion}/${filename}`;
  process.stdout.write(`Downloading ${url}\n`);
  const data = await fetchBuffer(url);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${filename}: expected ${expected}, got ${actual}`);
  writeFileSync(localPath, data);
  return localPath;
}

function extractNodeBinary(archivePath: string, target: Target, nodeVersion: string, runtimeDir: string): void {
  mkdirSync(runtimeDir, { recursive: true });
  const topDir = `node-v${nodeVersion}-${target.id}`;
  const tmp = mkdtempSync(join(tmpdir(), 'occ-node-extract-'));
  try {
    if (target.nodeExt === 'zip') {
      if (process.platform === 'win32') {
        execFileSync('tar', ['-xf', archivePath, '-C', tmp, `${topDir}/node.exe`, `${topDir}/LICENSE`], { stdio: 'pipe' });
      } else {
        try {
          execFileSync('unzip', ['-q', '-o', archivePath, `${topDir}/node.exe`, `${topDir}/LICENSE`, '-d', tmp], { stdio: 'pipe' });
        } catch {
          execFileSync('python3', ['-c', 'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); [z.extract(n, sys.argv[2]) for n in sys.argv[3:]]', archivePath, tmp, `${topDir}/node.exe`, `${topDir}/LICENSE`], { stdio: 'pipe' });
        }
      }
      copyFileSync(join(tmp, topDir, 'node.exe'), join(runtimeDir, 'node.exe'));
      copyFileSync(join(tmp, topDir, 'LICENSE'), join(runtimeDir, 'NODE_LICENSE'));
    } else {
      execFileSync('tar', ['-xzf', archivePath, '-C', tmp, `${topDir}/bin/node`, `${topDir}/LICENSE`], { stdio: 'pipe' });
      const dest = join(runtimeDir, 'node');
      copyFileSync(join(tmp, topDir, 'bin', 'node'), dest);
      chmodSync(dest, 0o755);
      copyFileSync(join(tmp, topDir, 'LICENSE'), join(runtimeDir, 'NODE_LICENSE'));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function extractPackage(workDir: string, tarballPath?: string): string {
  const pkgDir = join(workDir, 'app-base');
  mkdirSync(pkgDir, { recursive: true });

  let tgz = tarballPath;
  if (!tgz) {
    const packed = runCmd(npmBin(), ['pack', '-w', 'packages/backend', '--pack-destination', workDir], REPO)
      .trim()
      .split(/\r?\n/)
      .pop();
    if (!packed) throw new Error('npm pack did not print a tarball filename');
    tgz = join(workDir, packed.trim());
  }

  const extractDir = join(workDir, 'packed');
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', extractDir], { stdio: 'pipe' });
  cpSync(join(extractDir, 'package'), pkgDir, { recursive: true });

  // Strip devDependencies (including the workspace-only @chess-coach/shared, already bundled into dist/)
  // so `npm install --omit=dev` only resolves published runtime dependencies.
  const pkgPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  delete pkg.devDependencies;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkgDir;
}

function installTargetDeps(appDir: string, target: Target): void {
  // Pass --os and --cpu so optional platform-specific packages (such as
  // @anthropic-ai/claude-agent-sdk-<os>-<arch>) match the target, not the build host.
  runCmd(
    npmBin(),
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      `--os=${target.platform}`,
      `--cpu=${target.arch}`,
    ],
    appDir,
  );
}

function createArchive(bundleParent: string, target: Target, outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });
  if (target.archiveExt === 'tar.gz') {
    execFileSync('tar', ['-czf', outFile, '-C', bundleParent, 'openchesscoach'], { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    execFileSync('tar', ['-a', '-c', '-f', outFile, '-C', bundleParent, 'openchesscoach'], { stdio: 'pipe' });
    return;
  }
  try {
    execFileSync('zip', ['-r', '-q', outFile, 'openchesscoach'], { cwd: bundleParent, stdio: 'pipe' });
  } catch {
    execFileSync(
      'python3',
      [
        '-c',
        `import os, sys, zipfile
out, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
  for dirpath, _, filenames in os.walk(root):
    for f in sorted(filenames):
      full = os.path.join(dirpath, f)
      z.write(full, os.path.relpath(full, os.path.dirname(root)))`,
        outFile,
        join(bundleParent, 'openchesscoach'),
      ],
      { stdio: 'pipe' },
    );
  }
}

interface CliOptions {
  target: string;
  outDir: string;
  nodeVersion: string;
  tarball?: string;
  skipBuild: boolean;
  useLocalNode: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    target: 'current',
    outDir: resolve(REPO, 'dist-standalone'),
    nodeVersion: process.env.OPENCHESSCOACH_NODE_VERSION ?? DEFAULT_NODE_VERSION,
    skipBuild: false,
    useLocalNode: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--target') opts.target = argv[++i] ?? 'current';
    else if (a === '--out-dir' || a === '--out') opts.outDir = resolve(argv[++i] ?? 'dist-standalone');
    else if (a === '--node-version') opts.nodeVersion = argv[++i] ?? DEFAULT_NODE_VERSION;
    else if (a === '--tarball') opts.tarball = resolve(argv[++i] ?? '');
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--use-local-node') opts.useLocalNode = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const targets = resolveTargets(opts.target);

  if (!opts.skipBuild && !opts.tarball) {
    process.stdout.write('Building web app and backend package...\n');
    runCmd(npmBin(), ['run', 'build'], REPO);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'occ-standalone-build-'));
  try {
    process.stdout.write('Staging app package...\n');
    const pkgBaseDir = extractPackage(workDir, opts.tarball);

    const needsDownload = targets.some((t) => !(opts.useLocalNode && t.platform === process.platform && t.arch === process.arch));
    const shasums = needsDownload ? await fetchShasums(opts.nodeVersion) : new Map<string, string>();

    mkdirSync(opts.outDir, { recursive: true });
    const sums: string[] = [];

    for (const target of targets) {
      const bundleParent = join(workDir, `stage-${target.id}`);
      const bundleRoot = join(bundleParent, 'openchesscoach');
      const targetAppDir = join(bundleRoot, 'app');
      mkdirSync(bundleRoot, { recursive: true });
      cpSync(pkgBaseDir, targetAppDir, { recursive: true });
      process.stdout.write(`Installing production dependencies for ${target.id}...\n`);
      installTargetDeps(targetAppDir, target);

      const runtimeDir = join(bundleRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      if (opts.useLocalNode && target.platform === process.platform && target.arch === process.arch) {
        const dest = join(runtimeDir, target.platform === 'win32' ? 'node.exe' : 'node');
        copyFileSync(process.execPath, dest);
        if (target.platform !== 'win32') chmodSync(dest, 0o755);
      } else {
        const nodeArchive = await ensureNodeArchive(target, opts.nodeVersion, shasums);
        extractNodeBinary(nodeArchive, target, opts.nodeVersion, runtimeDir);
      }

      if (target.platform === 'win32') {
        writeFileSync(join(bundleRoot, 'openchesscoach.cmd'), windowsLauncher());
      } else {
        const launcher = join(bundleRoot, 'openchesscoach');
        writeFileSync(launcher, posixLauncher());
        chmodSync(launcher, 0o755);
      }

      const name = archiveName(target);
      const outFile = join(opts.outDir, name);
      createArchive(bundleParent, target, outFile);
      const hash = sha256File(outFile);
      sums.push(`${hash}  ${name}`);
      process.stdout.write(`Built ${outFile} (${hash.slice(0, 12)}...)\n`);
    }

    // Copy installers alongside archives so release uploads are self-contained.
    for (const script of ['install.sh', 'install.ps1']) {
      const src = join(REPO, 'scripts', script);
      if (existsSync(src)) {
        const dst = join(opts.outDir, script);
        copyFileSync(src, dst);
        sums.push(`${sha256File(dst)}  ${script}`);
      }
    }

    writeFileSync(join(opts.outDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
    process.stdout.write(`Wrote ${join(opts.outDir, 'SHA256SUMS.txt')}\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
