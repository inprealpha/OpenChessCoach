// Checks on a PR's description, for the labels `.github/workflows/pr-labels.yml` sets (ADR 0006):
//   no-evidence        the Evidence section is empty
//   no-testing-record  the "How this was made" section doesn't say which model made the change,
//                      how it was tested (at least one ticked box) and what was not tested
// HTML comments never count, so the template's own hints are not an answer.
//
//   node scripts/pr-description.ts < body.md     print the labels the PR needs, one per line,
//                                                 and what is missing to stderr
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NO_EVIDENCE = 'no-evidence';
export const NO_TESTING_RECORD = 'no-testing-record';

/** The text with every HTML comment removed, including comments over several lines and one left open. */
export function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** The text under a `## <heading>` line, up to the next `## ` heading, or undefined when there is no such heading. */
export function section(body: string, heading: string): string | undefined {
  const lines = withoutComments(body).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## /.test(l) && l.slice(3).trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export function hasEvidence(body: string): boolean {
  return (section(body, 'Evidence') ?? '').trim() !== '';
}

/** What the "How this was made" section is missing, in plain words; empty when it is complete. */
export function testingRecordProblems(body: string): string[] {
  const text = section(body, 'How this was made');
  if (text === undefined) return ['There is no "How this was made" section.'];
  const problems: string[] = [];
  if (!/^[ \t]*Made (?:with|by)[ \t]+\S/im.test(text)) problems.push('The "Made with" line is missing or empty.');
  if (!/^[ \t]*[-*][ \t]+\[[xX]\][ \t]+\S/m.test(text)) problems.push('No testing method is ticked.');
  if (!/^[ \t]*Not tested:[ \t]*\S/im.test(text)) problems.push('The "Not tested" line is missing or empty; write "nothing" if nothing was left out.');
  return problems;
}

/** The labels the PR's description earns. */
export function labelsFor(body: string): string[] {
  return [...(hasEvidence(body) ? [] : [NO_EVIDENCE]), ...(testingRecordProblems(body).length ? [NO_TESTING_RECORD] : [])];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const body = readFileSync(0, 'utf8');
  if (!hasEvidence(body)) console.error('The Evidence section is empty.');
  for (const problem of testingRecordProblems(body)) console.error(problem);
  for (const label of labelsFor(body)) console.log(label);
}
