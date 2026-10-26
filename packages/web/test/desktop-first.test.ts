// Coach work uses the desktop's Engine, and the browser's only when the desktop can't be reached (ADR 0007).
import { describe, expect, it } from 'vitest';
import { desktopFirst } from '../src/lib/engine/desktop-first.ts';

const failing = (code: string) => () => Promise.reject(Object.assign(new Error(`desktop said ${code}`), { code }));
const browser = () => Promise.resolve('browser');

describe('desktop first, else the browser', () => {
  it('uses the desktop’s answer when it is connected', async () => {
    expect(await desktopFirst(true, () => Promise.resolve('desktop'), browser)).toBe('desktop');
  });

  it('uses the browser without asking when the desktop is not connected', async () => {
    let asked = false;
    const desktop = () => {
      asked = true;
      return Promise.resolve('desktop');
    };
    expect(await desktopFirst(false, desktop, browser)).toBe('browser');
    expect(asked).toBe(false);
  });

  it('falls back to the browser when the desktop drops out or its Engine is unavailable', async () => {
    expect(await desktopFirst(true, failing('offline'), browser)).toBe('browser');
    expect(await desktopFirst(true, failing('engine-unavailable'), browser)).toBe('browser');
  });

  it('lets any other desktop error through instead of hiding it behind the browser’s answer', async () => {
    await expect(desktopFirst(true, failing('bad-request'), browser)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(desktopFirst(true, failing('internal'), browser)).rejects.toMatchObject({ code: 'internal' });
    await expect(desktopFirst(true, () => Promise.reject(new Error('boom')), browser)).rejects.toThrow('boom');
  });
});
