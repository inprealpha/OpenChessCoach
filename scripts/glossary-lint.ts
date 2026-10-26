// The glossary lint: Player-facing text must use CONTEXT.md's terms, not the ones it says
// to avoid. It reads every "_Avoid_:" line, then scans the web app's markup and strings and the
// backend's messages to the Player. Allowed uses live in glossary-allowlist.json, each with a reason.
//   node scripts/glossary-lint.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  term: string;
  text: string;
}

export interface AllowEntry {
  term: string;
  /** Regular expression for the allowed phrase; the term is allowed only inside a match. */
  phrase: string;
  reason: string;
}

/** Every term CONTEXT.md lists after "_Avoid_:". */
export function avoidedTerms(context: string): string[] {
  const terms = new Set<string>();
  for (const line of context.split('\n')) {
    const m = line.match(/^_Avoid_:\s*(.+)$/);
    if (!m) continue;
    for (const t of (m[1] as string).split(',')) if (t.trim()) terms.add(t.trim().toLowerCase());
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

/** The Player-facing text in a file: markup text and attribute values, and string literals that read as sentences. */
export function playerFacingText(file: string, source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  // A web page: its markup only, with <style> and <script> blanked so line numbers hold.
  if (file.endsWith('.html')) {
    const markup = source.replace(/<(style|script)[\s>][\s\S]*?<\/\1>/g, (block) => block.replace(/[^\n]/g, ' '));
    return markupText(markup, 0, source);
  }
  if (file.endsWith('.svelte')) {
    const markupStart = source.search(/<\/script>/);
    const style = source.search(/<style[\s>]/);
    const markup = source.slice(markupStart < 0 ? 0 : markupStart + 9, style < 0 ? undefined : style);
    const offset = markupStart < 0 ? 0 : markupStart + 9;
    out.push(...markupText(markup, offset, source));
  }
  for (const m of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const text = (m[2] as string).replace(/\$\{[^}]*\}/g, ' ');
    if (!/^[A-Z‘“"]/.test(text.trim()) || !/[a-z]+ [a-z]+/i.test(text)) continue;
    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA)\b/.test(text)) continue;
    out.push({ line: lineOf(m.index ?? 0), text });
  }
  return out;
}

export function lint(files: { file: string; source: string }[], terms: string[], allow: AllowEntry[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const { file, source } of files) {
    for (const { line, text } of playerFacingText(file, source)) {
      let rest = text;
      for (const a of allow) rest = rest.replace(new RegExp(a.phrase, 'gi'), (match) => (new RegExp(`\\b${escape(a.term)}\\b`, 'i').test(match) ? ' ' : match));
      for (const term of terms) {
        if (new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`, 'i').test(rest)) {
          const key = `${file}:${line}:${term}`;
          if (!seen.has(key)) findings.push({ file, line, term, text: text.trim().slice(0, 120) });
          seen.add(key);
          rest = rest.replace(new RegExp(escape(term), 'gi'), ' ');
        }
      }
    }
  }
  return findings;
}

/** Text between tags, outside {expressions}, and the attributes a Player reads. */
function markupText(markup: string, offset: number, source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  for (const m of markup.matchAll(/>([^<]+)</g)) {
    const text = (m[1] as string).replace(/\{[^}]*\}/g, ' ').trim();
    if (/[a-z]/i.test(text)) out.push({ line: lineOf(offset + (m.index ?? 0)), text });
  }
  for (const m of markup.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"{]+)"/g)) {
    out.push({ line: lineOf(offset + (m.index ?? 0)), text: m[1] as string });
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The files whose strings the Player reads. */
export const SCANNED = [
  'packages/web/src',
  'packages/backend/src/handlers',
  'packages/backend/src/imports',
  'packages/backend/src/games.ts',
  'packages/backend/src/pairing.ts',
  'packages/backend/src/profile.ts',
  'packages/backend/src/reviews.ts',
  'packages/backend/src/settings.ts',
  'packages/backend/src/server.ts',
  'packages/backend/src/start.ts',
  'packages/backend/src/claude-check.ts',
  'packages/backend/src/coach/fake.ts',
  'packages/backend/src/coach/service.ts',
  'packages/shared/src/pgn.ts',
  'site/index.html',
];

function walk(root: string, path: string): string[] {
  const full = join(root, path);
  try {
    return readdirSync(full, { withFileTypes: true }).flatMap((e) => walk(root, join(path, e.name)));
  } catch {
    return /\.(ts|svelte|html)$/.test(path) ? [path] : [];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const terms = avoidedTerms(readFileSync(join(root, 'CONTEXT.md'), 'utf8'));
  const allow = JSON.parse(readFileSync(join(root, 'scripts', 'glossary-allowlist.json'), 'utf8')) as AllowEntry[];
  const files = SCANNED.flatMap((p) => walk(root, p)).map((file) => ({ file: relative(root, join(root, file)), source: readFileSync(join(root, file), 'utf8') }));
  const findings = lint(files, terms, allow);
  for (const f of findings) process.stderr.write(`${f.file}:${f.line}: "${f.term}" is a term CONTEXT.md says to avoid: ${f.text}\n`);
  if (findings.length) {
    process.stderr.write(`\n${findings.length} glossary problem(s). Use the CONTEXT.md term, or add an allowlist entry with a reason to scripts/glossary-allowlist.json.\n`);
    process.exit(1);
  }
  process.stdout.write(`Glossary lint: ${files.length} files, ${terms.length} avoided terms, no problems.\n`);
}
