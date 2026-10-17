/**
 * The method that decides alerts has a version (desk/live.mjs METHOD_VERSION),
 * and this test holds the code to it (LEARNING-PLAN.md rule 1: one method per
 * committed sample). It hashes the files that decide whether an alert is sent
 * and how it is scored, and fails when they change, so nobody changes the
 * method without deciding, on purpose, whether an alert could move:
 *  - it could → bump METHOD_VERSION. That ends a committed sample (the
 *    journal's next record is under another method), and the desk says so
 *    (`journal`). Pin the new hash under the new version.
 *  - it cannot (a comment, a rename, a refactor proved identical) → replace
 *    the hash of the current version, with a note saying why.
 *
 * What is hashed:
 *  - whole files: the engine (src/signal-engine.js, src/indicators.js), the
 *    checks and the gate's rules (src/shot.js), sessions and windows
 *    (src/sessions.js, src/timezone.js, src/timeframes.js), the instruments
 *    (src/instruments.js), the watcher (desk/live.mjs) and the scoring
 *    (desk/outcome.mjs);
 *  - single functions where the file is mostly wording: desk/lib.mjs's gateFor
 *    and costFor (and serverOffsetFor and timeframeFor, which they call), the
 *    two src/risk.js functions the engine imports, and src/data-feeds.js's
 *    closedBars (which bars count as closed). Their source text is hashed, so
 *    an edit to a reply's words elsewhere in those files does not trip it.
 *
 * Deliberately NOT hashed: src/news-calendar.js. Adding next year's release
 * dates extends the data, not the rule — and a corrected date moves only the
 * blackout of that one day, which is what the table is for. A change to how
 * blackouts are DERIVED (the rule-based events, the blackout windows) is a
 * method change all the same; whoever makes one bumps the version by hand.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_VERSION } from '../desk/live.mjs';
import * as lib from '../desk/lib.mjs';
import * as feeds from '../src/data-feeds.js';
import * as risk from '../src/risk.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The files that decide alerts, whole. */
const METHOD_FILES = Object.freeze([
  'src/signal-engine.js', 'src/indicators.js', 'src/shot.js', 'src/sessions.js', 'src/timezone.js',
  'src/timeframes.js', 'src/instruments.js', 'desk/live.mjs', 'desk/outcome.mjs',
]);
/** Functions that decide alerts in files that are otherwise mostly wording. */
const METHOD_FUNCTIONS = Object.freeze([
  ['desk/lib.mjs', lib, ['gateFor', 'costFor', 'serverOffsetFor', 'timeframeFor']],
  ['src/data-feeds.js', feeds, ['closedBars']],
  ['src/risk.js', risk, ['breakEvenWinRate', 'rMultiple']],
]);

/**
 * Every version of the method that decided alerts, with the hash of its code.
 * Old entries stay, so the history reads.
 */
const EXPECTED_METHOD_HASH = {
  // 1 — 17 Oct 2026, at integration: the method decision 26 measured (1.5R when
  // no level stands in the way), with the volumeBucket fix, the watcher reading
  // at most 999 closed bars (CLOSED_BARS), and the footer "no live record yet".
  1: '1a2d1afbc43080e4ea677f8a85921585d59e0ef065db59f3fae61128fc25fd8f',
};

function methodHash() {
  const h = createHash('sha256');
  for (const f of METHOD_FILES) h.update(f).update('\0').update(readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  for (const [file, mod, names] of METHOD_FUNCTIONS) {
    for (const n of names) {
      assert.equal(typeof mod[n], 'function', `${file} exports ${n}`);
      h.update(`${file}#${n}`).update('\0').update(mod[n].toString().replace(/\r\n/g, '\n')).update('\0');
    }
  }
  return h.digest('hex');
}

console.log('\nthe method that decides alerts');
test('METHOD_VERSION is a whole number of at least 1', () => {
  assert.ok(Number.isInteger(METHOD_VERSION) && METHOD_VERSION >= 1);
});
test('the files that decide alerts are pinned to METHOD_VERSION', () => {
  const hash = methodHash();
  const want = EXPECTED_METHOD_HASH[METHOD_VERSION];
  assert.ok(want, `METHOD_VERSION ${METHOD_VERSION} has no pinned hash. It was bumped: that ends a committed sample, and the desk must say so. Pin ${hash} under ${METHOD_VERSION} with a note on what changed.`);
  assert.equal(hash, want, 'The files that decide alerts changed. If any alert could change, bump METHOD_VERSION in desk/live.mjs — that ends a committed sample, and the desk must say so. If no alert can change, update EXPECTED_METHOD_HASH with a note saying why.');
});
test('the news calendar is left out on purpose, and every file hashed exists', () => {
  assert.ok(!METHOD_FILES.includes('src/news-calendar.js'));
  for (const f of METHOD_FILES) assert.ok(readFileSync(join(root, f), 'utf8').length > 0, f);
});
test('a change to a function\'s wording-free logic in lib.mjs is seen; a reply\'s words elsewhere in it are not', () => {
  // The hash reads gateFor's own source text, not lib.mjs as a whole.
  assert.match(lib.gateFor.toString(), /^function gateFor\(/);
  assert.doesNotMatch(lib.gateFor.toString(), /formatBrief|Today's plan/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
