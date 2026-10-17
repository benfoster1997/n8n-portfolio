/**
 * Runs every suite and fails the process if any of them do. Suites run side
 * by side (as many at once as there are CPUs), each in its own process, and
 * are reported in name order: the learning layer's suite alone takes about
 * half a minute, and one after another the whole run had passed a minute.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

const runOne = (s) => new Promise((resolve) => {
  execFile('node', [join(here, s)], { encoding: 'utf8', maxBuffer: 64 << 20 }, (err, stdout) => resolve({ s, err, stdout: stdout || '' }));
});

// The slowest first, so the pool is not left waiting on it at the end.
const order = [...suites].sort((a, b) => (b === 'learn.test.mjs') - (a === 'learn.test.mjs'));
const results = new Map();
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, Math.min(availableParallelism(), suites.length)) }, async () => {
  while (next < order.length) {
    const s = order[next++];
    results.set(s, await runOne(s));
  }
}));

let failed = 0, total = 0;
for (const s of suites) {
  const { err, stdout } = results.get(s);
  process.stdout.write(`\n\u001b[1m${s}\u001b[0m`);
  const m = stdout.match(/(\d+) passed, (\d+) failed/);
  if (m) total += Number(m[1]);
  if (err) {
    failed++;
    console.log('  FAILED');
    console.log(stdout || err.message);
  } else console.log(`  ${m ? m[0] : 'ok'}`);
}
console.log(`\n${failed ? '\u001b[31m' : '\u001b[32m'}${total} assertions across ${suites.length} suites, ${failed} failures\u001b[0m\n`);
process.exit(failed ? 1 : 0);
