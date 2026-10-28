// The app's own device name works out outside a browser too, so a unit test can import code that uses it.
import { expect, it } from 'vitest';

it('imports without matchMedia, as a plain browser that is not a phone', async () => {
  expect(typeof (globalThis as { matchMedia?: unknown }).matchMedia).toBe('undefined');
  const { onPhoneOrTablet, thisDeviceName } = await import('../src/lib/this-device.ts');
  expect(thisDeviceName).toBe('Browser');
  expect(onPhoneOrTablet).toBe(false);
});
