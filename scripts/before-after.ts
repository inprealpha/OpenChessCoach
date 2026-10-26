// One picture for a PR: the before screenshot on the left, the after on the right, each with a
// small label, so a reviewer sees both at full width (.claude/skills/verify/SKILL.md, section 4).
//   node scripts/before-after.ts <before.png> <after.png> <out.png>
// A new screen has no before: pass `-` and the after fills the picture alone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const GAP = 12;

export function sideBySideHtml(before: string | null, after: string): string {
  const panel = (label: string, png: string) =>
    `<figure><img src="data:image/png;base64,${png}"><figcaption>${label}</figcaption></figure>`;
  return `<!doctype html><style>
    body { margin: 0; background: #888; display: inline-flex; gap: ${GAP}px; }
    figure { margin: 0; position: relative; }
    img { display: block; }
    figcaption { position: absolute; bottom: 12px; left: 12px; padding: 3px 10px; border-radius: 4px;
      background: rgb(0 0 0 / 0.55); color: #fff; font: 600 15px system-ui, sans-serif; }
  </style><body>${before ? panel('Before', before) : ''}${panel('After', after)}</body>`;
}

export async function writeSideBySide(beforePath: string, afterPath: string, outPath: string): Promise<void> {
  const before = beforePath === '-' ? null : readFileSync(beforePath).toString('base64');
  const after = readFileSync(afterPath).toString('base64');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(sideBySideHtml(before, after));
    await page.locator('body').screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [before, after, out] = process.argv.slice(2);
  if (!before || !after || !out) {
    console.error('Usage: node scripts/before-after.ts <before.png|-> <after.png> <out.png>');
    process.exit(1);
  }
  await writeSideBySide(before, after, out);
  console.log(out);
}
