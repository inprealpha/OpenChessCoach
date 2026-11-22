import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it.skipIf(process.platform === 'win32')('install.sh updates the login profile for bash on macOS and .bashrc on Linux', () => {
    const work = mkdtempSync(join(tmpdir(), 'occ-install-rc-'));
    try {
      const stage = join(work, 'stage', 'openchesscoach');
      mkdirSync(stage, { recursive: true });
      const bin = join(stage, 'openchesscoach');
      writeFileSync(bin, '#!/bin/sh\necho ok\n');
      chmodSync(bin, 0o755);
      const archive = join(work, 'occ.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', join(work, 'stage'), 'openchesscoach'], { stdio: 'pipe' });

      const runInstall = (home: string) =>
        execFileSync('bash', [resolve(REPO, 'scripts', 'install.sh'), '--archive', archive], {
          env: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
          stdio: 'pipe',
        });

      const homeFresh = join(work, 'home-fresh');
      mkdirSync(homeFresh, { recursive: true });
      runInstall(homeFresh);

      if (process.platform === 'darwin') {
        expect(existsSync(join(homeFresh, '.bash_profile'))).toBe(true);
        expect(readFileSync(join(homeFresh, '.bash_profile'), 'utf8')).toContain('.local/bin');
        expect(existsSync(join(homeFresh, '.bashrc'))).toBe(false);

        const homeWithBashLogin = join(work, 'home-bash-login');
        mkdirSync(homeWithBashLogin, { recursive: true });
        writeFileSync(join(homeWithBashLogin, '.bash_login'), '# existing bash_login\n');
        writeFileSync(join(homeWithBashLogin, '.profile'), '# existing profile\n');
        runInstall(homeWithBashLogin);
        expect(existsSync(join(homeWithBashLogin, '.bash_profile'))).toBe(false);
        expect(readFileSync(join(homeWithBashLogin, '.bash_login'), 'utf8')).toContain('.local/bin');
        expect(readFileSync(join(homeWithBashLogin, '.profile'), 'utf8')).not.toContain('.local/bin');

        const homeWithProfile = join(work, 'home-profile');
        mkdirSync(homeWithProfile, { recursive: true });
        writeFileSync(join(homeWithProfile, '.profile'), '# existing profile\n');
        runInstall(homeWithProfile);
        expect(existsSync(join(homeWithProfile, '.bash_profile'))).toBe(false);
        expect(readFileSync(join(homeWithProfile, '.profile'), 'utf8')).toContain('.local/bin');
      } else {
        expect(existsSync(join(homeFresh, '.bashrc'))).toBe(true);
        expect(readFileSync(join(homeFresh, '.bashrc'), 'utf8')).toContain('.local/bin');
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
