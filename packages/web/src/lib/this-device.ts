// This device's name, as it pairs and as it connects, and whether that makes it a phone or tablet.
import { deviceName, isPhoneOrTablet } from '@chess-coach/shared/devices';

/** Touch is the only pointer, as on a phone or tablet; a touch-screen laptop has a touchpad too. */
const touchOnly = matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;

export const thisDeviceName = deviceName(navigator.userAgent, { points: navigator.maxTouchPoints, only: touchOnly });

/** A phone or tablet never asks the Player to pair one. */
export const onPhoneOrTablet = isPhoneOrTablet(thisDeviceName);
