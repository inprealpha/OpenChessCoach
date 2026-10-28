import { isPhoneOrTablet } from '@chess-coach/shared/devices';
import { PROTOCOL_VERSION } from '@chess-coach/shared/protocol';
import { AppError } from '../errors.ts';
import { pairUrl, qrSvg } from '../network.ts';
import { askAgain, phoneStatus, remindLater } from '../phone.ts';
import { getSettings, updateSettings } from '../settings.ts';
import type { HandlerMap } from './index.ts';

export const systemHandlers: HandlerMap<
  'hello' | 'pairing.info' | 'pairing.reset' | 'pairing.remindLater' | 'settings.get' | 'settings.update'
> = {
  hello: async (req, { app, device }) => {
    // Only towards a phone or tablet: an iPad that paired as a Mac before the app told them apart
    // counts once it connects. Never away from one, so a tablet whose browser later calls itself a
    // desktop, such as an Android tablet in desktop mode with a trackpad, stays a phone.
    const name = req.deviceName;
    if (typeof name === 'string' && name !== device.name && isPhoneOrTablet(name)) app.pairing.rename(device.id, name);
    return {
      protocol: PROTOCOL_VERSION,
      version: app.version,
      verify: app.verify,
      deviceId: device.id,
      coach: await app.coach.status(),
    };
  },

  'pairing.info': async (_req, { app }) => {
    const url = pairUrl(app.lanUrl, app.pairing.code);
    const tunnel = app.tunnel.state();
    const tunnelPairUrl = tunnel.url ? pairUrl(tunnel.url, app.pairing.code) : null;
    return {
      lanUrl: app.lanUrl,
      pairUrl: url,
      qrSvg: await qrSvg(url),
      tunnel,
      tunnelPairUrl,
      tunnelQrSvg: tunnelPairUrl ? await qrSvg(tunnelPairUrl) : null,
      phone: phoneStatus(app.db, app.clock),
    };
  },

  'pairing.reset': async (_req, { app, device, setToken }) => {
    const hadPhone = phoneStatus(app.db, app.clock).paired;
    const { token } = app.pairing.reset(device.name);
    if (hadPhone) askAgain(app.db);
    if (!token) throw new AppError('internal', 'Could not issue a new token.');
    setToken(token);
    app.revalidate();
    app.broadcast({ kind: 'pairing-reset' });
    app.log('Pairing was reset: every other device must scan the new QR code.');
    return { token };
  },

  'pairing.remindLater': async (req, { app }) => remindLater(app.db, app.clock, req.never === true),

  'settings.get': async (_req, { app }) => getSettings(app.db),

  'settings.update': async (req, { app }) => {
    const before = getSettings(app.db);
    const next = updateSettings(app.db, req);
    if (next.tunnelEnabled !== before.tunnelEnabled) {
      if (next.tunnelEnabled) app.tunnel.start().catch((err: unknown) => app.log(`Tunnel failed: ${String(err)}`));
      else await app.tunnel.stop();
    }
    return next;
  },
};
