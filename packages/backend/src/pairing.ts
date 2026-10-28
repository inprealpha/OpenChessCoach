// Pairing (ADR 0001): a secret pairing code buys a long-lived device token, and every
// WebSocket connection must present a valid token. Resetting revokes every token and the code.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Clock, iso } from './clock.ts';
import { getMeta, one, setMeta, type Db } from './db.ts';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export interface Device {
  id: string;
  name: string;
}

export class PairingRefused extends Error {}

export class Pairing {
  private readonly db: Db;
  private readonly clock: Clock;
  private failures: number[] = [];

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
    if (!getMeta(db, 'pairing_code')) setMeta(db, 'pairing_code', newCode());
  }

  get code(): string {
    return getMeta(this.db, 'pairing_code') as string;
  }

  /** Exchanges the pairing code for a device token. */
  pair(code: string, deviceName: string): { token: string; deviceId: string } {
    const now = this.clock.now().getTime();
    this.failures = this.failures.filter((t) => now - t < LOCKOUT_MS);
    if (this.failures.length >= MAX_FAILURES) {
      throw new PairingRefused('Too many wrong pairing codes. Wait a minute and scan the QR code again.');
    }
    if (!sameCode(normaliseCode(code), this.code)) {
      this.failures.push(now);
      throw new PairingRefused('That pairing code is wrong or has been reset. Scan the current QR code.');
    }
    return this.issue(deviceName);
  }

  /** Returns the device for a valid token, or undefined. */
  verify(token: string | null | undefined): Device | undefined {
    if (!token) return undefined;
    const row = one<{ id: string; name: string }>(
      this.db,
      'SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL',
      hashToken(token),
    );
    if (!row) return undefined;
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(iso(this.clock), row.id);
    return row;
  }

  /** Gives a device the name it now goes by, such as an iPad that paired as a Mac before the app told them apart. */
  rename(deviceId: string, deviceName: string): void {
    this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(deviceName.slice(0, 80) || 'Device', deviceId);
  }

  /** Revokes every token and makes a new pairing code. Returns a fresh token for the device that asked, if any. */
  reset(keepDeviceName?: string): { token: string | undefined } {
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(iso(this.clock));
    setMeta(this.db, 'pairing_code', newCode());
    this.failures = [];
    return { token: keepDeviceName ? this.issue(keepDeviceName).token : undefined };
  }

  private issue(deviceName: string): { token: string; deviceId: string } {
    const token = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(deviceId, deviceName.slice(0, 80) || 'Device', hashToken(token), iso(this.clock));
    return { token, deviceId };
  }
}

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
