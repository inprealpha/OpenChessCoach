// Asking for a phone: a desktop browser asks the Player to pair one until a phone is paired, the
// Player says "later" (asked again after a few days) or "don't ask again".
import { describe, expect, it } from 'vitest';
import { pairDevice } from '../src/client.ts';
import { ASK_AGAIN_MS } from '../src/phone.ts';
import { client, instance, rows } from './helpers.ts';

describe('the phone reminder', () => {
  it('asks while no phone is paired: desktop browsers and coachctl are not phones', async () => {
    const app = await instance({ seed: 'no-phone' });
    await pairDevice(app.url, app.code, 'Windows browser');
    const c = await client(app);
    expect((await c.request('pairing.info', {})).phone).toEqual({ paired: false, remind: true });
  });

  it('stops asking once a phone pairs, and tells every connected screen', async () => {
    const app = await instance({ seed: 'no-phone' });
    const desktop = await client(app);
    await pairDevice(app.url, app.code, 'Android browser');
    await expect.poll(() => desktop.events).toContainEqual({ kind: 'device-paired' });
    expect((await desktop.request('pairing.info', {})).phone).toEqual({ paired: true, remind: false });
  });

  it('keeps asking when a desktop browser pairs', async () => {
    const app = await instance({ seed: 'no-phone' });
    const desktop = await client(app);
    await pairDevice(app.url, app.code, 'Mac browser');
    await expect.poll(() => desktop.events).toContainEqual({ kind: 'device-paired' });
    expect((await desktop.request('pairing.info', {})).phone.remind).toBe(true);
  });

  it('renames a device to the name it now gives when it connects, so an iPad paired as a Mac counts', async () => {
    const app = await instance({ seed: 'no-phone' });
    const ipad = await pairDevice(app.url, app.code, 'Mac browser');
    const desktop = await client(app);
    expect((await desktop.request('pairing.info', {})).phone.paired).toBe(false);
    await (await client(app, ipad)).request('hello', { client: 'web', deviceName: 'iPhone or iPad browser' });
    expect((await desktop.request('pairing.info', {})).phone).toEqual({ paired: true, remind: false });
    // A client that gives no name, such as coachctl, keeps the one it paired under.
    await desktop.request('hello', { client: 'coachctl' });
    const names = rows<{ name: string }>(app, 'SELECT name FROM devices ORDER BY created_at, rowid').map((d) => d.name);
    expect(names).toEqual(['verify-handshake', 'iPhone or iPad browser']);
  });

  it('"later" asks again after a few days', async () => {
    const app = await instance({ seed: 'no-phone' });
    const c = await client(app);
    expect(await c.request('pairing.remindLater', {})).toEqual({ paired: false, remind: false });
    const [later] = rows<{ value: string }>(app, "SELECT value FROM meta WHERE key = 'phone_reminder'");
    expect(later?.value).toBe(new Date(app.clock.now().getTime() + ASK_AGAIN_MS).toISOString());
    app.clock.advance(ASK_AGAIN_MS - 1000);
    expect((await c.request('pairing.info', {})).phone.remind).toBe(false);
    app.clock.advance(1000);
    expect((await c.request('pairing.info', {})).phone.remind).toBe(true);
  });

  it('"don\'t ask again" never asks again', async () => {
    const app = await instance({ seed: 'no-phone' });
    const c = await client(app);
    expect(await c.request('pairing.remindLater', { never: true })).toEqual({ paired: false, remind: false });
    app.clock.advance(365 * 24 * 60 * 60 * 1000);
    expect((await c.request('pairing.info', {})).phone.remind).toBe(false);
  });

  it('asks again after a pairing reset unpairs the phone', async () => {
    const app = await instance();
    const c = await client(app);
    // The default seed has a phone paired.
    expect((await c.request('pairing.info', {})).phone).toEqual({ paired: true, remind: false });
    const { token } = await c.request('pairing.reset', {});
    const fresh = await client(app, token);
    expect((await fresh.request('pairing.info', {})).phone).toEqual({ paired: false, remind: true });
  });
});
