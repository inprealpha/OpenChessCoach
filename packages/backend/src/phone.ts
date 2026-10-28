// Most Players play chess on their phone, so a desktop browser asks them to pair one: as the first
// step of first run, and on the main menu for a Player who never did. "Later" asks again after a
// few days; "don't ask again" never does. Pairing a phone ends the asking, and a pairing reset,
// which unpairs every phone, starts it again.
import { isPhoneOrTablet } from '@chess-coach/shared/devices';
import type { PhoneStatus } from '@chess-coach/shared/protocol';
import { type Clock } from './clock.ts';
import { all, getMeta, setMeta, type Db } from './db.ts';

/** How long "later" puts off the question. */
export const ASK_AGAIN_MS = 3 * 24 * 60 * 60 * 1000;

/** The meta key: when to ask again, as an ISO time, or `never`. */
const LATER = 'phone_reminder';

export function phoneStatus(db: Db, clock: Clock): PhoneStatus {
  const names = all<{ name: string }>(db, 'SELECT DISTINCT name FROM devices WHERE revoked_at IS NULL');
  const paired = names.some((d) => isPhoneOrTablet(d.name));
  const later = getMeta(db, LATER);
  const putOff = later === 'never' || (later !== undefined && clock.now().getTime() < Date.parse(later));
  return { paired, remind: !paired && !putOff };
}

export function remindLater(db: Db, clock: Clock, never = false): PhoneStatus {
  setMeta(db, LATER, never ? 'never' : new Date(clock.now().getTime() + ASK_AGAIN_MS).toISOString());
  return phoneStatus(db, clock);
}
