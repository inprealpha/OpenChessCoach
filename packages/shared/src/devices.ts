// What a paired device is called, from its browser. The web app names itself this way when it
// pairs and each time it connects, and the desktop reads the names back to tell whether the
// Player has paired a phone.

const IPHONE_OR_IPAD = 'iPhone or iPad browser';
const ANDROID = 'Android browser';

/** The device's touch screen: how many touch points it has, and whether touch is its only pointer. */
export interface Touch {
  points: number;
  only: boolean;
}

/**
 * The name a browser pairs under. iPadOS Safari calls itself a Mac, and Chrome on a large Android
 * tablet asks for desktop sites and calls itself Linux: only their touch screens give them away.
 */
export function deviceName(userAgent: string, touch: Touch): string {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touch.points > 1)) return IPHONE_OR_IPAD;
  if (/Android/.test(userAgent) || (/Linux/.test(userAgent) && touch.only)) return ANDROID;
  const system = /Mac/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : '';
  return system ? `${system} browser` : 'Browser';
}

/** Whether a device, by the name it paired under, is a phone or tablet. */
export function isPhoneOrTablet(name: string): boolean {
  return name === IPHONE_OR_IPAD || name === ANDROID;
}
