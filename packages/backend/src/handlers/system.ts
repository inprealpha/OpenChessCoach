import { PROTOCOL_VERSION } from '@chess-coach/shared/protocol';
import { AppError } from '../errors.ts';
import { pairUrl, qrSvg } from '../network.ts';
import { getSettings, updateSettings } from '../settings.ts';
import type { HandlerMap } from './index.ts';

export const systemHandlers: HandlerMap<'hello' | 'pairing.info' | 'pairing.reset' | 'settings.get' | 'settings.update'> = {
  hello: async (_req, { app, device }) => ({
    protocol: PROTOCOL_VERSION,
    version: app.version,
    verify: app.verify,
    deviceId: device.id,
    coach: await app.coach.status(),
    temptingMoves: app.temptingMoves.status(),
  }),

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
    };
  },

  'pairing.reset': async (_req, { app, device, setToken }) => {
    const { token } = app.pairing.reset(device.name);
    if (!token) throw new AppError('internal', 'Could not issue a new token.');
    setToken(token);
    app.revalidate();
    app.broadcast({ kind: 'pairing-reset' });
    app.log('Pairing was reset: every other device must scan the new QR code.');
    return { token };
  },

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
