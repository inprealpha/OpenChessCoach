import type { HandlerMap } from './index.ts';

export const engineHandlers: HandlerMap<'engine.analyse' | 'engine.grade' | 'engine.threat'> = {
  'engine.analyse': async (req, { app }) => app.desktopEngine.analyse(String(req.fen)),
  'engine.grade': async (req, { app }) =>
    app.desktopEngine.grade(String(req.fen), String(req.uci), Number.isInteger(req.ply) && (req.ply as number) > 0 ? (req.ply as number) : 1),
  'engine.threat': async (req, { app }) => ({ threat: (await app.desktopEngine.threat(String(req.fen))) ?? null }),
};
