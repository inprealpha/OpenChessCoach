import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';

/** The desktop's address on the local network, preferring private IPv4 ranges. */
export function lanAddress(): string {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) candidates.push(ni.address);
    }
  }
  const preferred = candidates.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return preferred ?? candidates[0] ?? '127.0.0.1';
}

export function pairUrl(base: string, code: string): string {
  return `${base.replace(/\/$/, '')}/#pair=${code}`;
}

export async function qrTerminal(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
}
