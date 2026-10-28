// This device's name, as it pairs and as it connects, and whether that makes it a phone or tablet.
// Outside a browser, such as in a unit test, it is a plain "Browser".
import { deviceName, isPhoneOrTablet } from '@chess-coach/shared/devices';

const matches = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;

/** Touch is the only pointer, as on a phone or tablet; a touch-screen laptop has a touchpad too. */
const touchOnly = matches('(any-pointer: coarse)') && !matches('(any-pointer: fine)');

const agent = typeof navigator === 'undefined' ? { userAgent: '', maxTouchPoints: 0 } : navigator;

export const thisDeviceName = deviceName(agent.userAgent, { points: agent.maxTouchPoints ?? 0, only: touchOnly });

/** A phone or tablet never asks the Player to pair one. */
export const onPhoneOrTablet = isPhoneOrTablet(thisDeviceName);
