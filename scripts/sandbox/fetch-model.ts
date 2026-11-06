// Puts the Maia-3 model where the app looks for it, with the app's own downloader: the link, the
// checksum and the data folder live only in packages/backend (tempting-moves/download.ts, paths.ts),
// so a new model release needs no change here. prepare.sh runs it.
//   node scripts/sandbox/fetch-model.ts      exits 0 once the checked model file is in place
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../../packages/backend/src/paths.ts';
import { ModelDownloader, type DownloaderOptions, type ModelState } from '../../packages/backend/src/tempting-moves/download.ts';

/** One try, now and without retries. A model already in place and checked is not downloaded again. */
export async function fetchModel(options: Partial<DownloaderOptions> = {}): Promise<ModelState & { path: string }> {
  const downloader = new ModelDownloader({ dir: join(defaultDataDir(), 'models'), ...options, startDelayMs: 0, retryDelaysMs: [] });
  await downloader.attempt();
  // Clears the retry the downloader schedules when another copy of the app holds the download lock.
  await downloader.stop();
  return { ...downloader.state(), path: downloader.path };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const state = await fetchModel({ log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`${state.model}: ${state.detail} (${state.path})\n`);
  process.exitCode = state.model === 'ready' ? 0 : 1;
}
