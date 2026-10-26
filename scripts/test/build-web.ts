// Vitest global setup: coachctl's doctor test checks the web app is served, so build it once when a
// fresh checkout has no build yet, instead of failing as if doctor were broken.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export default function setup(): void {
  if (existsSync(new URL('../../packages/web/dist/index.html', import.meta.url))) return;
  // Vitest sets NODE_ENV=test, which would make a development build without the offline app shell
  // that the Player journeys rely on.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('VITEST')));
  execFileSync('npm', ['run', 'build', '-w', '@chess-coach/web'], { stdio: 'ignore', env });
}
