// Puts the Maia-3 model where the app looks for it, with the app's own downloader: the link, the
// checksum and the data folder live only in packages/backend (tempting-moves/download.ts, paths.ts),
// so a new model release needs no change here. prepare.sh runs it.
//   node scripts/sandbox/fetch-model.ts      exits 0 once the checked model file is in place
import { realpathSync } from 'node:fs';
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

// Real paths on both sides: in a folder reached through a symlink, a plain comparison would skip the
// download and still exit 0.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const state = await fetchModel({ log: (line) => process.stdout.write(`${line}\n`) });
    if (state.model === 'ready') {
      process.stdout.write(`${state.detail}: ${state.path}\n`);
    } else {
      process.stdout.write(`The model is not in place (${state.model}). Run node scripts/sandbox/fetch-model.ts again to retry.\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stdout.write(`The model download failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
