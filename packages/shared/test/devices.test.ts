// Device names: the desktop tells a paired phone or tablet from a desktop browser by its name alone.
import { describe, expect, it } from 'vitest';
import { deviceName, isPhoneOrTablet } from '../src/devices.ts';

const UA = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for desktop sites by default, so it calls itself a Mac.
  ipadOrMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  // Also what Chrome on a large Android tablet sends: it asks for desktop sites by default.
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

/** A phone or tablet's touch screen, a touch laptop's, and a desktop without one. */
const PHONE = { points: 5, only: true };
const TOUCH_LAPTOP = { points: 10, only: false };
const DESKTOP = { points: 0, only: false };

describe('deviceName', () => {
  it('names phones and tablets by their system', () => {
    expect(deviceName(UA.iPhone, PHONE)).toBe('iPhone or iPad browser');
    expect(deviceName(UA.android, PHONE)).toBe('Android browser');
  });

  it('tells an iPad that calls itself a Mac by its touch screen', () => {
    expect(deviceName(UA.ipadOrMac, PHONE)).toBe('iPhone or iPad browser');
    expect(deviceName(UA.ipadOrMac, DESKTOP)).toBe('Mac browser');
  });

  it('tells an Android tablet that calls itself Linux by touch being its only pointer', () => {
    expect(deviceName(UA.linux, PHONE)).toBe('Android browser');
    // A Linux laptop with a touch screen also has a touchpad.
    expect(deviceName(UA.linux, TOUCH_LAPTOP)).toBe('Linux browser');
    expect(deviceName(UA.linux, DESKTOP)).toBe('Linux browser');
  });

  it('names desktop browsers by their system', () => {
    expect(deviceName(UA.windows, DESKTOP)).toBe('Windows browser');
    expect(deviceName(UA.windows, TOUCH_LAPTOP)).toBe('Windows browser');
    expect(deviceName('', DESKTOP)).toBe('Browser');
  });
});

describe('isPhoneOrTablet', () => {
  it('is true only for the names a phone or tablet pairs under', () => {
    for (const ua of [UA.iPhone, UA.android, UA.linux]) expect(isPhoneOrTablet(deviceName(ua, PHONE))).toBe(true);
    for (const ua of [UA.windows, UA.linux, UA.ipadOrMac]) expect(isPhoneOrTablet(deviceName(ua, DESKTOP))).toBe(false);
    // The names coachctl and the readiness handshake pair under.
    expect(isPhoneOrTablet('coachctl')).toBe(false);
    expect(isPhoneOrTablet('verify-handshake')).toBe(false);
  });
});
