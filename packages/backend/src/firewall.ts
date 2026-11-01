// A desktop firewall that blocks incoming connections keeps the phone out, and the phone then gets
// no answer at all, so nothing on the phone can explain it (issue #31). The desktop can't test it
// either: a connection to its own Wi-Fi address never goes through its own firewall. So the app
// warns ahead, by system: Windows and macOS ask about Node.js when the app starts listening, and
// on Linux a firewall that is on gets the one command that lets the Wi-Fi in. The web app's
// "Connect another way" is the fallback that works whatever the cause.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { DesktopSystem } from '@chess-coach/shared/protocol';

/**
 * The desktop's system, for the warnings the web app shows. `CHESS_COACH_DESKTOP_SYSTEM` pretends to
 * be another one, so verify mode and the journeys can show what a Windows or Mac Player sees.
 */
export function desktopSystem(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): DesktopSystem {
  const pretend = env.CHESS_COACH_DESKTOP_SYSTEM;
  if (pretend === 'windows' || pretend === 'macos' || pretend === 'linux' || pretend === 'other') return pretend;
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'other';
}

/** What the system will ask about Node.js when the app starts listening, said before it asks. */
export function systemPromptWarning(system: DesktopSystem): string | undefined {
  if (system === 'windows') {
    return 'Windows may ask whether Node.js can use your networks. Tick both boxes (Private and Public) and click Allow access, or your phone can’t open the app.';
  }
  if (system === 'macos') return 'If your Mac asks whether node can accept incoming network connections, click Allow, or your phone can’t open the app.';
  return undefined;
}

export type LinuxFirewall = 'ufw' | 'firewalld';

/** How to look at the desktop without root: read a file, run a command. */
export interface FirewallProbe {
  readFile(path: string): Promise<string>;
  run(command: string, args: string[]): Promise<string>;
}

const systemProbe: FirewallProbe = {
  readFile: (path) => readFile(path, 'utf8'),
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 2000 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
    }),
};

/**
 * The firewall that is on, if any: ufw by its config file (`ufw status` needs root), firewalld by
 * systemd. Null when neither is, or when the desktop can't tell.
 */
export async function linuxFirewall(probe: FirewallProbe = systemProbe): Promise<LinuxFirewall | null> {
  const ufw = await probe.readFile('/etc/ufw/ufw.conf').catch(() => '');
  if (/^\s*ENABLED\s*=\s*"?yes"?\s*$/im.test(ufw)) return 'ufw';
  const firewalld = await probe.run('systemctl', ['is-active', 'firewalld']).catch(() => '');
  if (firewalld.trim() === 'active') return 'firewalld';
  return null;
}

/** The local network an IPv4 address is on, as `192.168.1.0/24`, from the interface that has it. */
export function subnetOf(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal || ni.address !== address || !ni.cidr) continue;
      const bits = Number(ni.cidr.split('/')[1]);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const ip = address.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
      const net = (ip & mask) >>> 0;
      return `${[24, 16, 8, 0].map((shift) => (net >>> shift) & 255).join('.')}/${bits}`;
    }
  }
  return undefined;
}

/** The one command that lets devices on the local network reach the app's port, and nothing else. */
export function openPortCommand(firewall: LinuxFirewall, subnet: string, port: number): string {
  if (firewall === 'ufw') return `sudo ufw allow from ${subnet} to any port ${port} proto tcp comment 'OpenChessCoach'`;
  return `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${subnet}" port port="${port}" protocol="tcp" accept' && sudo firewall-cmd --reload`;
}

/** What the start-up message says about a Linux firewall that is on: why, and the command. */
export function linuxFirewallAdvice(firewall: LinuxFirewall, subnet: string, port: number): string {
  const why =
    firewall === 'ufw'
      ? 'The firewall on this desktop (ufw) is on, and it blocks your phone unless you let your Wi-Fi in.'
      : 'The firewall on this desktop (firewalld) is on, and it may block your phone.';
  return `${why} If your phone can’t open the app, run this once:\n\n    ${openPortCommand(firewall, subnet, port)}\n`;
}

/** The Linux advice for the app's Wi-Fi address, or undefined when no firewall is on or the address isn't on a local network. */
export async function firewallAdvice(
  lanHost: string,
  port: number,
  options: { system?: DesktopSystem; probe?: FirewallProbe; interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]> } = {},
): Promise<string | undefined> {
  if ((options.system ?? desktopSystem()) !== 'linux') return undefined;
  const subnet = subnetOf(lanHost, options.interfaces);
  if (!subnet) return undefined;
  const firewall = await linuxFirewall(options.probe);
  return firewall ? linuxFirewallAdvice(firewall, subnet, port) : undefined;
}
