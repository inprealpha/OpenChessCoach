import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentTarget, parseShasums, posixLauncher, resolveTargets, TARGETS, windowsLauncher } from '../build-standalone.ts';

const REPO = resolve(import.meta.dirname, '..', '..');

describe('build-standalone helpers', () => {
  it('resolves current, all, and explicit targets', () => {
    expect(resolveTargets('all').map((t) => t.id)).toEqual(TARGETS.map((t) => t.id));
    expect(resolveTargets('win-x64,darwin-arm64').map((t) => t.id)).toEqual(['win-x64', 'darwin-arm64']);
    expect(() => resolveTargets('plan9-mips')).toThrow(/Unknown target/);
    expect(currentTarget('win32', 'x64').id).toBe('win-x64');
    expect(currentTarget('win32', 'arm64').id).toBe('win-arm64');
    expect(currentTarget('darwin', 'arm64').id).toBe('darwin-arm64');
    expect(currentTarget('linux', 'x64').id).toBe('linux-x64');
  });

  it('parses standard and BSD-style SHASUMS256 lines', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const map = parseShasums(`${hashA}  node-v22.18.0-linux-x64.tar.gz\n${hashB} *node-v22.18.0-win-x64.zip\n`);
    expect(map.get('node-v22.18.0-linux-x64.tar.gz')).toBe(hashA);
    expect(map.get('node-v22.18.0-win-x64.zip')).toBe(hashB);
  });

  it('generates launchers that set OPENCHESSCOACH_STANDALONE=1 and run the bundled Node runtime', () => {
    const sh = posixLauncher();
    expect(sh).toContain('OPENCHESSCOACH_STANDALONE=1');
    expect(sh).toContain('exec "$DIR/runtime/node" "$DIR/app/dist/cli.js" "$@"');

    const cmd = windowsLauncher();
    expect(cmd).toContain('OPENCHESSCOACH_STANDALONE=1');
    expect(cmd).toContain('"%DIR%runtime\\node.exe" "%DIR%app\\dist\\cli.js" %*');
    expect(cmd).toContain('\r\n');
  });

  it('installers verify SHA256SUMS.txt and support uninstall', () => {
    const ps1 = readFileSync(resolve(REPO, 'scripts', 'install.ps1'), 'utf8');
    expect(ps1).toContain('SHA256SUMS.txt');
    expect(ps1).toContain('Get-FileHash');
    expect(ps1).toContain('[switch]$Uninstall');

    const sh = readFileSync(resolve(REPO, 'scripts', 'install.sh'), 'utf8');
    expect(sh).toContain('SHA256SUMS.txt');
    expect(sh).toContain('--uninstall');
    expect(sh).toContain('musl');
  });
});
