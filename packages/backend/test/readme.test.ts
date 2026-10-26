// The README is also the package's page on npmjs.com: the build copies it into the package
// (scripts/build.ts), so what it says has to hold there too.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

describe('the README', () => {
  it('loads its pictures from absolute addresses', () => {
    // npmjs.com resolves a relative path against the repository plus its directory
    // (packages/backend), where docs/images isn't.
    const pictures = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
    expect(pictures.length).toBeGreaterThan(0);
    for (const src of pictures) expect(src).toMatch(/^https:\/\//);
  });

  it("names every option the start command's --help lists", () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    const options = [...(help.split('Options:')[1] ?? '').matchAll(/^ +(--[a-z-]+)/gm)].map((m) => m[1]);
    const line = readme.slice(readme.indexOf('\nOptions: ')).split('\n\n')[0] ?? '';
    expect(options.length).toBeGreaterThan(0);
    expect(options.filter((option) => !line.includes(`\`${option}`))).toEqual([]);
  });
});
