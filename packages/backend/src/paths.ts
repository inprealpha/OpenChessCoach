import { homedir } from 'node:os';
import { join } from 'node:path';

/** The owner's data folder, which holds the one SQLite file (ADR 0003). */
export function defaultDataDir(): string {
  if (process.env.CHESS_COACH_DATA_DIR) return process.env.CHESS_COACH_DATA_DIR;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'ai-chess-coach');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'ai-chess-coach');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ai-chess-coach');
}
