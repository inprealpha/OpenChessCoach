import { homedir } from 'node:os';
import { join } from 'node:path';

/** The owner's data folder, which holds the one SQLite file (ADR 0003). */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.CHESS_COACH_DATA_DIR) return env.CHESS_COACH_DATA_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ai-chess-coach');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'ai-chess-coach');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'ai-chess-coach');
}
