// A desktop firewall can keep the phone out, and the desktop can't test that itself (#31): the
// start-up message warns by system, and on Linux names the one command that lets the Wi-Fi in.
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  desktopSystem,
  firewallAdvice,
  isLoopbackHost,
  linuxFirewall,
  openPortCommand,
  subnetOf,
  systemPromptWarning,
  type FirewallProbe,
} from '../src/firewall.ts';

const nic = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  cidr,
  internal,
  family: 'IPv4',
  netmask: '',
  mac: '00:00:00:00:00:00',
});

const INTERFACES = {
  lo: [nic('127.0.0.1', '127.0.0.1/8', true)],
  wlan0: [nic('192.168.1.23', '192.168.1.23/24')],
  eth0: [nic('10.20.30.40', '10.20.30.40/16')],
};

/** A Linux desktop with this ufw config file and this answer from `systemctl is-active firewalld`. */
const probe = (ufwConf: string | null, firewalld: string | null, ufwDefaults = 'DEFAULT_INPUT_POLICY="DROP"\n'): FirewallProbe => ({
  readFile: async (path) => {
    if (path === '/etc/default/ufw') return ufwDefaults;
    if (ufwConf === null) throw new Error('ENOENT');
    return ufwConf;
  },
  run: async () => {
    if (firewalld === null) throw new Error('systemctl not found');
    return `${firewalld}\n`;
  },
});

describe('the desktop system', () => {
  it('is told from the platform, unless verify mode pretends to be another', () => {
    expect(desktopSystem('win32', {})).toBe('windows');
    expect(desktopSystem('darwin', {})).toBe('macos');
    expect(desktopSystem('linux', {})).toBe('linux');
    expect(desktopSystem('freebsd', {})).toBe('other');
    expect(desktopSystem('linux', { CHESS_COACH_DESKTOP_SYSTEM: 'windows' })).toBe('windows');
    expect(desktopSystem('linux', { CHESS_COACH_DESKTOP_SYSTEM: 'amiga' })).toBe('linux');
  });

  it('counts an app that listens only on this desktop as out of every phone\'s reach', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', 'localhost', '::1']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '192.168.1.23', '::']) expect(isLoopbackHost(host)).toBe(false);
  });

  it('warns Windows and macOS Players about the question on Node.js before it is asked', () => {
    expect(systemPromptWarning('windows')).toMatch(/Windows may ask .*Node\.js.*Tick both boxes.*Allow/);
    expect(systemPromptWarning('macos')).toMatch(/Mac asks .*click Allow/);
    expect(systemPromptWarning('linux')).toBeUndefined();
  });
});

describe('a Linux firewall', () => {
  it('is ufw when its config file says it is enabled', async () => {
    expect(await linuxFirewall(probe('# comment\nENABLED=yes\nLOGLEVEL=low\n', 'inactive'))).toBe('ufw');
    expect(await linuxFirewall(probe('ENABLED=no\n', 'inactive'))).toBeNull();
    // Enabled but letting everything in: it turns no phone away.
    expect(await linuxFirewall(probe('ENABLED=yes\n', 'inactive', 'DEFAULT_INPUT_POLICY="ACCEPT"\n'))).toBeNull();
  });

  it('is firewalld when systemd says it is active', async () => {
    expect(await linuxFirewall(probe(null, 'active'))).toBe('firewalld');
    expect(await linuxFirewall(probe(null, 'inactive'))).toBeNull();
    expect(await linuxFirewall(probe(null, null))).toBeNull();
  });
});

describe('the command that lets the Wi-Fi in', () => {
  it('opens only the app port, only to the local network the app is on', () => {
    expect(subnetOf('192.168.1.23', INTERFACES)).toBe('192.168.1.0/24');
    expect(subnetOf('10.20.30.40', INTERFACES)).toBe('10.20.0.0/16');
    expect(subnetOf('127.0.0.1', INTERFACES)).toBeUndefined();
    expect(subnetOf('172.16.0.9', INTERFACES)).toBeUndefined();
    expect(openPortCommand('ufw', '192.168.1.0/24', 8737)).toBe(
      "sudo ufw allow from 192.168.1.0/24 to any port 8737 proto tcp comment 'OpenChessCoach'",
    );
    expect(openPortCommand('firewalld', '192.168.1.0/24', 8737)).toBe(
      'sudo firewall-cmd --permanent --add-rich-rule=\'rule family="ipv4" source address="192.168.1.0/24" port port="8737" protocol="tcp" accept\' && sudo firewall-cmd --reload',
    );
  });

  it('is printed at start-up on Linux with a firewall on, with the real subnet and port', async () => {
    const advice = await firewallAdvice('192.168.1.23', 9000, { system: 'linux', probe: probe('ENABLED=yes', null), interfaces: INTERFACES });
    expect(advice).toContain('(ufw) is on');
    expect(advice).toContain("sudo ufw allow from 192.168.1.0/24 to any port 9000 proto tcp comment 'OpenChessCoach'");
  });

  it('is not printed with no firewall on, off Linux, or off the local network', async () => {
    const on = probe('ENABLED=yes', 'active');
    expect(await firewallAdvice('192.168.1.23', 8737, { system: 'linux', probe: probe(null, 'inactive'), interfaces: INTERFACES })).toBeUndefined();
    expect(await firewallAdvice('192.168.1.23', 8737, { system: 'windows', probe: on, interfaces: INTERFACES })).toBeUndefined();
    expect(await firewallAdvice('127.0.0.1', 8737, { system: 'linux', probe: on, interfaces: INTERFACES })).toBeUndefined();
  });
});
