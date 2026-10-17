/**
 * Runs every suite and fails the process if any of them do. Suites run side
 * by side (as many at once as there are CPUs), each in its own process, and
 * are reported in name order: the learning layer's suite alone takes about
 * half a minute, and one after another the whole run had passed a minute.
 *
 * A failing suite shows what it printed and what it wrote to stderr (a crash
 * outside a test, such as a fixture that throws at the top level, leaves its
 * stack only there). A suite that has not finished after SUITE_TIMEOUT_MS is
 * killed and reported by name; each suite's start and end are written to
 * stderr as they happen, so a run cut short from outside still shows which
 * suite was left running.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// RUN_ALL_DIR: another folder of suites (test/runner.test.mjs points it at fakes).
const here = process.env.RUN_ALL_DIR || dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS) || 300000;

const runOne = (s) => new Promise((resolve) => {
  process.stderr.write(`running ${s}\n`);
  execFile('node', [join(here, s)], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL' },
    (err, stdout, stderr) => {
      process.stderr.write(`${err ? (err.killed ? 'timed out' : 'failed') : 'finished'} ${s}\n`);
      resolve({ s, err, stdout: stdout || '', stderr: stderr || '' });
    });
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
  const { err, stdout, stderr } = results.get(s);
  process.stdout.write(`\n\u001b[1m${s}\u001b[0m`);
  const m = stdout.match(/(\d+) passed, (\d+) failed/);
  if (m) total += Number(m[1]);
  if (err) {
    failed++;
    console.log(err.killed ? `  TIMED OUT (killed after ${Math.round(SUITE_TIMEOUT_MS / 1000)} s)` : '  FAILED');
    console.log([stdout, stderr].filter((x) => x.trim()).join('\n') || err.message);
  } else console.log(`  ${m ? m[0] : 'ok'}`);
}
console.log(`\n${failed ? '\u001b[31m' : '\u001b[32m'}${total} assertions across ${suites.length} suites, ${failed} failures\u001b[0m\n`);
process.exit(failed ? 1 : 0);
