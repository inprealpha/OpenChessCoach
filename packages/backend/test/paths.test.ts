import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataDir } from '../src/paths.ts';

describe('defaultDataDir', () => {
  it('uses XDG_DATA_HOME on Linux when non-empty and falls back to ~/.local/share when unset or empty', () => {
    const home = '/home/alice';
    expect(defaultDataDir('linux', {}, home)).toBe(join(home, '.local', 'share', 'ai-chess-coach'));
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '' }, home)).toBe(join(home, '.local', 'share', 'ai-chess-coach'));
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/srv/data' }, home)).toBe(join('/srv/data', 'ai-chess-coach'));
  });

  it('honors CHESS_COACH_DATA_DIR only when non-empty', () => {
    const home = '/home/alice';
    expect(defaultDataDir('linux', { CHESS_COACH_DATA_DIR: '/custom/dir' }, home)).toBe('/custom/dir');
    expect(defaultDataDir('linux', { CHESS_COACH_DATA_DIR: '' }, home)).toBe(join(home, '.local', 'share', 'ai-chess-coach'));
  });
});
