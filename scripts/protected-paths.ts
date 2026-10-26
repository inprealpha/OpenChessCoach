// Path lists for PR review rules. `.github/protected-paths.txt` generates CODEOWNERS and
// labels PRs that need the owner's review; `.github/coach-paths.txt` labels PRs that touch the Coach.
//   node scripts/protected-paths.ts                     rewrite .github/CODEOWNERS
//   node scripts/protected-paths.ts --check             fail if CODEOWNERS is out of date
//   node scripts/protected-paths.ts --match protected|coach <files...>   print the files that match
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OWNER = '@inprealpha';
const root = new URL('../', import.meta.url);

export function readList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Whether a repo-relative file path falls under a list entry. */
export function matches(file: string, entry: string): boolean {
  if (entry.endsWith('/')) return file.startsWith(entry);
  if (entry.includes('*')) {
    const re = new RegExp(`^${entry.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return re.test(file);
  }
  return file === entry;
}

export function matching(files: readonly string[], list: readonly string[]): string[] {
  return files.filter((f) => list.some((e) => matches(f, e)));
}

export function codeowners(list: readonly string[]): string {
  const lines = [
    '# Generated from .github/protected-paths.txt by scripts/protected-paths.ts. Do not edit by hand.',
    '# GitHub cannot enforce these yet: agents open PRs under the owner\'s own account.',
    ...list.map((e) => `/${e} ${OWNER}`),
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const protectedList = readList(readFileSync(new URL('.github/protected-paths.txt', root), 'utf8'));
  const coachList = readList(readFileSync(new URL('.github/coach-paths.txt', root), 'utf8'));
  const args = process.argv.slice(2);
  const target = new URL('.github/CODEOWNERS', root);
  if (args[0] === '--check') {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // missing counts as out of date
    }
    if (current !== codeowners(protectedList)) {
      process.stderr.write('.github/CODEOWNERS is out of date with .github/protected-paths.txt. Run: node scripts/protected-paths.ts\n');
      process.exit(1);
    }
    process.stdout.write(`CODEOWNERS matches ${protectedList.length} protected paths.\n`);
  } else if (args[0] === '--match') {
    const list = args[1] === 'coach' ? coachList : protectedList;
    const files = args.length > 2 ? args.slice(2) : readFileSync(0, 'utf8').split('\n').filter(Boolean);
    for (const f of matching(files, list)) process.stdout.write(`${f}\n`);
  } else {
    writeFileSync(target, codeowners(protectedList));
    process.stdout.write(`Wrote .github/CODEOWNERS with ${protectedList.length} paths.\n`);
  }
}
