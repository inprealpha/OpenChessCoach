// Entry point of `npx openchesscoach`. The real work is in start.ts, loaded after the SQLite
// warning is silenced (static imports would load node:sqlite first).
import { nodeTooOld, quietSqliteWarning } from './runtime.ts';

// Before anything else: an older Node.js would fail on node:sqlite with an error nobody can act on.
const tooOld = nodeTooOld();
if (tooOld) {
  process.stderr.write(`\n✗ ${tooOld}\n\n`);
  process.exit(1);
}
quietSqliteWarning();
await import('./start.ts');
