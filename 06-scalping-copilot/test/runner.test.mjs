/**
 * test/run-all.mjs itself, run on a folder of fake suites: a suite that
 * crashes outside a test shows its stack, and a suite that never ends is
 * killed and named instead of holding the whole run silent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); }
};
const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(here, 'run-all.mjs');

function runOn(files, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-all-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return spawnSync('node', [RUNNER], { encoding: 'utf8', env: { ...process.env, RUN_ALL_DIR: dir, ...env }, timeout: 60000 });
}

console.log('\nthe test runner');
test('a suite that prints and then crashes outside a test: its stack is shown, not just what it printed', () => {
  const r = runOn({
    'a.test.mjs': "console.log('\\nsection');\nconsole.log('  ok   one');\nawait Promise.resolve();\nnull.foo();\n",
    'b.test.mjs': "console.log('  ok   two');\nconsole.log('\\n1 passed, 0 failed');\n",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a\.test\.mjs\S*  FAILED/);
  assert.match(r.stdout, /ok   one/);
  assert.match(r.stdout, /TypeError: Cannot read properties of null/);
  assert.match(r.stdout, /b\.test\.mjs\S*  1 passed, 0 failed/);
});
test('a suite that never ends is killed after the time limit and named; the others still report', () => {
  const r = runOn({
    'h.test.mjs': "console.log('starting');\nsetInterval(() => {}, 1000);\n",
    'ok.test.mjs': "console.log('\\n1 passed, 0 failed');\n",
  }, { SUITE_TIMEOUT_MS: '1500' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /h\.test\.mjs\S*  TIMED OUT/);
  assert.match(r.stdout, /starting/);
  assert.match(r.stdout, /ok\.test\.mjs\S*  1 passed, 0 failed/);
  assert.match(r.stderr, /^running h\.test\.mjs$/m, 'each suite is named on stderr as it starts');
  assert.match(r.stderr, /^timed out h\.test\.mjs$/m);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
