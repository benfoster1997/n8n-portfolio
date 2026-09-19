/** Runs every suite and fails the process if any of them do. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0, total = 0;
for (const s of suites) {
  process.stdout.write(`\n\u001b[1m${s}\u001b[0m`);
  try {
    const out = execFileSync('node', [join(here, s)], { encoding: 'utf8' });
    const m = out.match(/(\d+) passed, (\d+) failed/);
    if (m) { total += Number(m[1]); if (Number(m[2])) failed += Number(m[2]); }
    console.log(`  ${m ? m[0] : 'ok'}`);
  } catch (e) {
    failed++;
    console.log('  FAILED');
    console.log(e.stdout || e.message);
  }
}
console.log(`\n${failed ? '\u001b[31m' : '\u001b[32m'}${total} assertions across ${suites.length} suites, ${failed} failures\u001b[0m\n`);
process.exit(failed ? 1 : 0);
