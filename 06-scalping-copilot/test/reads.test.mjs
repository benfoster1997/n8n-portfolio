/**
 * The reads behind the replay (desk/reads.mjs): one read per check, computed
 * in parallel, then the alert sequence applied serially. On the recorded
 * Binance bars (fixtures/btc-m15.json), so the engine sees real shapes.
 * Kept small: about 200 reads in all, so the suite stays quick.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAt, computeReads, alertPass, checkIndices, kindFor, longestGap, loadBarsFile, spreadAt, readsFor, storePath, sliceOf, GAP_BARS,
} from '../desk/reads.mjs';
import { liveRead } from '../desk/live.mjs';
import { withDefaults, gateFor } from '../desk/lib.mjs';
import { outcome } from '../desk/outcome.mjs';
import { getActiveBlackout, getUpcomingEvents, fromDateTable, EVENTS } from '../src/news-calendar.js';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  });
};

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'btc-m15.json');
const REPLAY = join(here, '..', 'desk', 'replay.mjs');
const BARS = loadBarsFile(FIXTURE, 'BTCUSD');
const M15 = 15 * 60000;
const cfg = withDefaults({});
const opts = { pair: 'BTCUSD', cfg, cost: 'fixed', calendar: 'full' };
const kAt = (bars, iso) => bars.findIndex((b) => b.t + M15 === Date.parse(iso));   // the bar CLOSING at iso
// Wednesday 7 Oct to Friday 9 Oct 2026: 96 checks, holding the 13:15 sell of the 7th
// whose still-running trade kept that afternoon's later sell ideas from alerting (live.test.mjs).
const KS = checkIndices(BARS, { fromMs: Date.parse('2026-10-07T00:00Z'), toMs: Date.parse('2026-10-09T23:59Z'), cfg });
const one = await computeReads(BARS, KS, { ...opts, workers: 1 });
const alertsOf = (reads, extra = {}) => alertPass(reads, BARS, { cfg, rule: '1.5R', pair: 'BTCUSD', ...extra }).trades.map((t) => `${t.at} ${t.side} ${t.r.toFixed(4)}`);

console.log('\nworkers');
test('three workers give exactly the reads and alerts one process gives', async () => {
  assert.equal(KS.length, 96);
  // 96 checks at the default of 50 a worker would start only two.
  const stats = {};
  const three = await computeReads(BARS, KS, { ...opts, workers: 3, file: FIXTURE, chunk: 20, minPerWorker: 20, stats });
  assert.equal(stats.workers, 3, 'three worker threads really started');
  assert.deepEqual(three, one, 'every read, field for field, in k order');
  assert.deepEqual(alertsOf(three), alertsOf(one));
  assert.deepEqual(alertsOf(one).map((a) => a.slice(0, 16)), ['2026-10-07T13:15', '2026-10-08T13:45'], 'the alerts live.test.mjs finds with the CLI');
});
test('one read judges every target rule from the same engine run', () => {
  const lean = one.find((r) => r.kind === 'lean');
  assert.ok(lean, 'some check leaned');
  assert.deepEqual(Object.keys(lean.rules), ['level', '1.5R', '2R']);
  for (const r of one) for (const rule of ['level', '1.5R', '2R']) assert.ok(['idea', 'rejected', 'none', 'blocked', 'no-data'].includes(kindFor(r, rule)), kindFor(r, rule));
  assert.ok(one.every((r) => r.nowMs === r.closeMs + 20000 && r.spreadNum === 6));
});

console.log('\nthe alert pass');
test('a predicate is applied before shouldAlert: removing one alert can let a later one through', () => {
  const plain = alertsOf(one);
  const first = one.find((r) => r.closeMs === Date.parse('2026-10-07T13:15Z'));
  const filtered = alertsOf(one, { predicate: (r) => r !== first });
  assert.ok(!filtered.some((a) => a.startsWith('2026-10-07T13:15')), 'the refused read did not alert');
  // With the 13:15 sell gone, the 13:30 idea — blocked before while that sell ran — is sent.
  assert.ok(filtered.some((a) => a.startsWith('2026-10-07T13:30')) && !plain.some((a) => a.startsWith('2026-10-07T13:30')), `a later idea now alerts: ${filtered}`);
  assert.notDeepEqual(filtered, plain.filter((a) => !a.startsWith('2026-10-07T13:15')), 'not the same as deleting the row from the unfiltered list');
});
test('each alert is scored with the spread its own read assumed', () => {
  const wide = one.map((r) => ({ ...r, spreadNum: 60 }));
  const a = alertPass(one, BARS, { cfg, rule: '1.5R', pair: 'BTCUSD' }).trades[1];
  const b = alertPass(wide, BARS, { cfg, rule: '1.5R', pair: 'BTCUSD' }).trades[1];
  assert.equal(a.at, b.at);
  assert.ok(b.r < a.r, `${b.r} < ${a.r}`);
});

test('the alert pass refuses to guess the instrument', () => {
  assert.throws(() => alertPass(one, BARS, { cfg, rule: '1.5R' }), /needs the instrument/);
});

console.log('\nthe features hook');
test('extra() is handed the bars up to k and nothing after: no history, no index', () => {
  const seen = [];
  const hook = (ctx) => { seen.push(ctx); return seen.length; };
  const k = kAt(BARS, '2026-10-07T13:15Z');
  const read = readAt(BARS, k, { ...opts, extra: hook });
  assert.equal(read.extra, 1, 'its return value is stored');
  const c = seen[0];
  assert.deepEqual(Object.keys(c).sort(), ['analysis', 'cfg', 'closed', 'kind', 'nowMs', 'pair', 'read', 'spreadNum', 'tf', 'window']);
  assert.equal(c.closed[c.closed.length - 1].t, BARS[k].t, 'the history ends at bar k');
  assert.equal(c.closed.length, Math.min(1000, k + 1));
  assert.deepEqual(c.window, c.closed.slice(-300), 'the engine\'s window is its last 300 bars');
  assert.ok(Object.isFrozen(c.closed) && Object.isFrozen(c.window));
  assert.equal(c.analysis.price, BARS[k].c, 'the engine\'s own analysis of this moment');
  assert.deepEqual([c.kind, c.tf, c.pair, c.spreadNum, c.nowMs], ['lean', 'M15', 'BTCUSD', 6, BARS[k].t + M15 + 20000]);
  assert.equal('k' in c.read, false, 'no index into the history');
  // Stopped at the gate (the recorded bars moved back a week onto October's NFP): no analysis, same slice.
  const shifted = BARS.map((b) => ({ ...b, t: b.t - 7 * 86400e3 }));
  const kNfp = kAt(shifted, '2026-10-02T12:30Z');
  readAt(shifted, kNfp, { ...opts, extra: hook });
  assert.deepEqual([seen[1].kind, seen[1].analysis], ['blocked', null]);
  assert.equal(seen[1].closed[seen[1].closed.length - 1].t, shifted[kNfp].t);
});

console.log('\nscoring a bar that touches both');
test('the default counts it as the stop; "half" scores the average of the target and −1', () => {
  // A buy at 100 with a 10 stop and a 15 target; the next bar spans 85..120.
  const bars = [{ t: 0, o: 100, h: 100, l: 100, c: 100 }, { t: M15, o: 100, h: 120, l: 85, c: 100 }];
  const rec = { side: 'buy', stopDist: 10, tp1Dist: 15 };
  const base = { spread: 1, comm: 0, closesAtMs: 1e12, tfMinutes: 15 };
  const stop = outcome(bars, 0, rec, base);
  assert.deepEqual([stop.r, stop.how, stop.bothTouched], [-1, 'stop', true]);
  const half = outcome(bars, 0, rec, { ...base, bothTouched: 'half' });
  const target = (15 - 1) / (10 + 1);
  assert.equal(half.how, 'both');
  assert.ok(Math.abs(half.r - (target - 1) / 2) < 1e-12, `${half.r}`);
  const clean = outcome([bars[0], { t: M15, o: 100, h: 120, l: 95, c: 100 }], 0, rec, { ...base, bothTouched: 'half' });
  assert.equal(clean.how, 'target', 'a bar touching the target only is unaffected');
});

console.log('\ngaps in the history');
test('a check whose 1,000 bars are missing more than four in a row is skipped; four is not', () => {
  const k = kAt(BARS, '2026-10-08T13:45Z');
  const cut = (n) => [...BARS.slice(0, 400), ...BARS.slice(400 + n)];
  assert.equal(longestGap(cut(GAP_BARS + 1), 0, k - GAP_BARS - 1, M15), GAP_BARS + 1);
  const five = cut(GAP_BARS + 1), four = cut(GAP_BARS);
  assert.equal(readAt(five, kAt(five, '2026-10-08T13:45Z'), opts).kind, 'gap');
  assert.notEqual(readAt(four, kAt(four, '2026-10-08T13:45Z'), opts).kind, 'gap');
});

console.log('\nthe spread a read assumes');
test('spreadNum reaches the engine and checkPlan, and the read records it', () => {
  const k = kAt(BARS, '2026-10-07T13:15Z');
  const live = (spreadNum) => liveRead({ pair: 'BTCUSD', bars: BARS.slice(0, k + 1), nowMs: BARS[k].t + M15 + 20000, cfg, spreadNum });
  const usual = live(undefined), seven = live(7), wide = live(400);
  assert.equal(usual.kind, 'idea');
  assert.equal(usual.spreadNum, 6, 'the confirmed usual spread by default');
  assert.equal(seven.spreadNum, 7);
  assert.equal(seven.result.cost, 7, 'checkPlan was given the cost from it');
  assert.equal(wide.kind, 'rejected');
  assert.ok(wide.result.problems.some((p) => /needs at least|pays/.test(p)), wide.result.problems.join(' | '));
  assert.equal(readAt(BARS, k, { ...opts, spreadNum: 400 }).rules['1.5R'].kind, 'rejected');
});
test('the scaled cost keeps the spread at the same share of the price', () => {
  assert.equal(spreadAt('BTCUSD', 84400, 'scaled'), 6);
  assert.equal(spreadAt('BTCUSD', 8440, 'scaled'), 0.6);
  assert.equal(spreadAt('BTCUSD', 8440, 'fixed'), 6);
  assert.throws(() => spreadAt('XAUUSD', 4000, 'scaled'), /reference price/);
});
test('the "max" cost charges each check the larger of the fixed and the scaled spread', () => {
  for (const close of [4000, 8440, 84400, 120000]) {
    const max = spreadAt('BTCUSD', close, 'max');
    assert.equal(max, Math.max(spreadAt('BTCUSD', close, 'fixed'), spreadAt('BTCUSD', close, 'scaled')), `at ${close}`);
    assert.ok(max >= spreadAt('BTCUSD', close, 'fixed') && max >= spreadAt('BTCUSD', close, 'scaled'));
  }
  assert.equal(spreadAt('BTCUSD', 8440, 'max'), 6, 'below the reference price, the fixed spread');
  assert.ok(Math.abs(spreadAt('BTCUSD', 168800, 'max') - 12) < 1e-9, 'above it, the scaled one');
  assert.throws(() => spreadAt('XAUUSD', 4000, 'max'), /reference price/, 'gold has no reference to scale by yet');
  assert.throws(() => spreadAt('BTCUSD', 4000, 'dear'), /Unknown cost mode/);
  // The read records what it charged, and the store keeps the modes apart.
  const k = kAt(BARS, '2026-10-07T13:15Z');
  const r = readAt(BARS, k, { ...opts, cost: 'max' });
  assert.equal(r.spreadNum, spreadAt('BTCUSD', BARS[k].c, 'max'));
  const home = mkdtempSync(join(tmpdir(), 'reads-'));
  assert.notEqual(storePath(home, { ...opts, cost: 'max' }), storePath(home, { ...opts, cost: 'scaled' }));
});

console.log('\nthe calendar mode');
test('at the October NFP, "full" stands aside; "rules" and "none" do not, and the read records which event', () => {
  // The recorded bars moved back one week, so Friday 9 Oct 12:30 UTC becomes NFP day, 2 Oct.
  const shifted = BARS.map((b) => ({ ...b, t: b.t - 7 * 86400e3 }));
  const k = kAt(shifted, '2026-10-02T12:30Z');
  const full = readAt(shifted, k, { ...opts, calendar: 'full' });
  const rules = readAt(shifted, k, { ...opts, calendar: 'rules' });
  const none = readAt(shifted, k, { ...opts, calendar: 'none' });
  assert.deepEqual([full.kind, full.blackoutId], ['blocked', 'nfp']);
  assert.equal(rules.blackoutId, null);
  assert.notEqual(none.kind, 'blocked');
  assert.equal(none.blackoutId, null);
  // Bitcoin's gate at a release is a caution that needs the live spread, which the watcher cannot know.
  assert.equal(gateFor('BTCUSD', Date.parse('2026-10-02T12:35Z'), cfg, 'M15', { calendar: 'none' }).needsSpread, false);
  assert.equal(gateFor('BTCUSD', Date.parse('2026-10-02T12:35Z'), cfg).needsSpread, true, 'live, unchanged');
});
test('"rules" keeps the rule-derived events (claims) and drops every dated one, the monthly ADP with them', () => {
  const thu = Date.parse('2026-10-08T12:32Z');   // 08:32 New York, Thursday: jobless claims
  assert.equal(getActiveBlackout(thu, 'BTCUSD', {}, { calendar: 'rules' }).event.id, 'jobless');
  assert.equal(getActiveBlackout(thu, 'BTCUSD', {}, { calendar: 'none' }), null);
  const ids = (calendar) => new Set(getUpcomingEvents(Date.UTC(2026, 0, 1), 24 * 365, null, { calendar }).map((e) => e.id));
  const all = ids('full'), rules = ids('rules');
  for (const id of ['nfp', 'cpi', 'fomc-statement', 'pce', 'fomc-minutes', 'adp-monthly']) assert.ok(all.has(id) && !rules.has(id), id);
  for (const id of ['jobless', 'ism-mfg', 'adp-pulse', 'deribit-expiry']) assert.ok(rules.has(id), id);
  assert.equal(ids('none').size, 0);
  assert.ok(EVENTS.filter(fromDateTable).every((e) => !rules.has(e.id)));
});

console.log('\nthe read store and the held-back years');
test('reads come back from the store exactly as computed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reads-'));
  const ks = KS.slice(40, 52);
  const first = await readsFor(BARS, ks, { ...opts, workers: 1 }, { home });
  const again = await readsFor(BARS, ks, { ...opts, workers: 1 }, { home });
  assert.deepEqual([first.computed, again.fromStore, again.computed], [12, 12, 0]);
  assert.deepEqual(again.reads, first.reads);
  assert.notEqual(storePath(home, { ...opts, calendar: 'rules' }), storePath(home, opts), 'the calendar mode is in the key');
  assert.notEqual(storePath(home, { ...opts, cost: 'scaled' }), storePath(home, opts), 'so is the cost mode');
});
test('reads stored from other bars are recomputed, never served', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reads-'));
  const ks = KS.slice(40, 52);
  // The same bars with less history before them: every read at these closes is made from a different slice.
  const cut = BARS.slice(100);
  assert.equal((await readsFor(cut, ks.map((k) => k - 100), { ...opts, workers: 1 }, { home })).computed, 12);
  const full = await readsFor(BARS, ks, { ...opts, workers: 1 }, { home });
  assert.deepEqual([full.fromStore, full.computed, full.replaced], [0, 12, 12]);
  assert.deepEqual(full.reads, one.slice(40, 52), 'exactly the reads the full bars give');
  const again = await readsFor(BARS, ks, { ...opts, workers: 1 }, { home });
  assert.deepEqual([again.fromStore, again.computed], [12, 0], 'and from then on those are the ones served');
  // One close changed at the same times (a bar repaired): same first bar, same length, different hash.
  const edited = BARS.map((b, i) => (i === 500 ? { ...b, c: b.c + 1 } : b));
  assert.deepEqual([sliceOf(edited, ks[0]).from, sliceOf(edited, ks[0]).n], [sliceOf(BARS, ks[0]).from, sliceOf(BARS, ks[0]).n]);
  assert.equal((await readsFor(edited, ks, { ...opts, workers: 1 }, { home })).replaced, 12);
});
test('the store key holds the bar source, a spread override and the broker; an extra() function is never stored', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reads-'));
  const base = storePath(home, opts);
  assert.notEqual(storePath(home, { ...opts, source: 'file:/somewhere/bars.json' }), base, 'the bar source');
  assert.notEqual(storePath(home, { ...opts, spreadNum: 7 }), base, 'a spread override');
  assert.notEqual(storePath(home, { ...opts, cfg: withDefaults({ broker: { serverOffset: 3 } }) }), base, 'the broker\'s server offset');
  const extra = () => 1;
  assert.throws(() => storePath(home, { ...opts, extra }), /cannot be stored/);
  await assert.rejects(readsFor(BARS, KS.slice(0, 2), { ...opts, extra, workers: 1 }, { home }), /cannot be stored/);
  const off = await readsFor(BARS, KS.slice(0, 2), { ...opts, extra, workers: 1 }, { home, useStore: false });
  assert.deepEqual(off.reads.map((r) => r.extra), [1, 1], 'with the store off it runs');
});
test('a held-back range is refused without --holdout, and every --holdout run is recorded in model.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'replay-'));
  const bars = join(home, 'bars.json');
  writeFileSync(bars, JSON.stringify({ BTCUSD: BARS }));
  const config = join(home, 'config.json');
  writeFileSync(config, '{}');
  const env = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_CONFIG: config, SCALP_DESK_BARS: bars };
  const run = (args) => { try { return execFileSync('node', [REPLAY, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (x) { return `EXIT ${x.status}\n${x.stdout}`; } };
  const range = ['--from', '2026-10-09T13:00', '--to', '2026-10-09T15:00', '--rule', '1.5R', '--workers', '1'];
  assert.match(run([...range, '--cost', 'scaled']), /^EXIT 2\n2025-01-01 onward is held back/);
  assert.match(run(range), /already seen \(decision 26\)/, 'decision 26\'s stretch at the default settings');
  assert.equal(existsSync(join(home, 'model.json')), false, 'no look recorded without --holdout');
  const out = run([...range, '--cost', 'scaled', '--holdout']);
  assert.match(out, /scaled with price/);
  const model = JSON.parse(readFileSync(join(home, 'model.json'), 'utf8'));
  assert.equal(model.looks.length, 1);
  assert.equal(model.looks[0].settings.cost, 'scaled');
  assert.match(run([...range, '--holdout']), /already been looked at 1 time/);
  // Cost 'max' names itself in the header rather than passing for the fixed spread.
  const max = run([...range, '--cost', 'max', '--holdout']);
  assert.match(max, /spread max\(6, 6 × close \/ 84,400\) per check/);
  assert.doesNotMatch(max, /spread 6 ·/);
});

/**
 * The replay in a scratch copy of desk/ and src/, so a stand-in desk/conditions.mjs
 * can be dropped in without touching the real tree (step 1E builds the real one).
 * `bars` are written as the desk's file of bars per instrument.
 */
function scratchReplay(bars = BARS) {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  for (const d of ['desk', 'src']) cpSync(join(here, '..', d), join(root, d), { recursive: true });
  writeFileSync(join(root, 'bars.json'), JSON.stringify({ BTCUSD: bars }));
  writeFileSync(join(root, 'config.json'), '{}');
  const env = { ...process.env, SCALP_DESK_HOME: join(root, 'home'), SCALP_DESK_CONFIG: join(root, 'config.json'), SCALP_DESK_BARS: join(root, 'bars.json') };
  const run = (args) => {
    try { return execFileSync('node', [join(root, 'desk', 'replay.mjs'), ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (x) { return `EXIT ${x.status}\n${x.stdout}`; }
  };
  const looks = () => (existsSync(join(root, 'model.json')) ? JSON.parse(readFileSync(join(root, 'model.json'), 'utf8')).looks : []);
  return {
    root, run, looks,
    conditions: (code) => writeFileSync(join(root, 'desk', 'conditions.mjs'), code),
    // The real desk/conditions.mjs now exists; this copy can still be made to lack it.
    noConditions: () => rmSync(join(root, 'desk', 'conditions.mjs'), { force: true }),
  };
}
const STUB = "export function conditionReport({ reads, trades, bars, block }) { return `STUB ${reads.length} reads, ${trades.length} trades, bars to ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 16)} (${block})`; }\n";

test('--by-condition on decision 26\'s stretch needs --holdout and is recorded; the hook sees no bar after the last session', () => {
  const r = scratchReplay();
  const range = ['--from', '2026-10-07', '--to', '2026-10-08T23:59', '--rule', '1.5R', '--workers', '1'];
  r.noConditions();
  assert.match(r.run([...range, '--by-condition', '--holdout']), /by condition: not built yet/, 'before the file exists');
  r.conditions(STUB);
  assert.match(r.run(range), /already seen \(decision 26\)/, 'the plain report is still open');
  assert.match(r.run([...range, '--by-condition']), /^EXIT 2\n1 Jan – 11 Oct 2026 is open without --holdout only to the plain report/);
  assert.equal(r.looks().length, 1, 'only the look that asked with --holdout');
  const out = r.run([...range, '--by-condition', '--holdout']);
  // The window closes at 16:00 London (15:00 UTC in October): the last bar the hook may see opens at 14:45,
  // though the recorded bars run on to 11 October.
  assert.match(out, /STUB 64 reads, \d+ trades, bars to 2026-10-08T14:45 \(2026, already seen \(decision 26\)\)/);
  assert.equal(r.looks().length, 2);
  assert.deepEqual(r.looks()[1].flags, ['by-condition']);
});
test('a broken desk/conditions.mjs stops the run instead of reading as "not built yet"', () => {
  const r = scratchReplay();
  const args = ['--from', '2026-10-07', '--to', '2026-10-07T23:59', '--rule', '1.5R', '--workers', '1', '--by-condition', '--holdout'];
  r.conditions("import './no-such-helper.mjs';\nexport const conditionReport = () => 'never';\n");
  const missingImport = r.run(args);
  assert.match(missingImport, /^EXIT 1/);
  assert.doesNotMatch(missingImport, /not built yet|never/);
  r.conditions('export function conditionReport( {\n');
  assert.match(r.run(args), /^EXIT 1/, 'a syntax error too');
});
test('a --holdout run across 1 January 2026 prints 2025 and 2026 apart, never one figure for both', () => {
  // The recorded bars moved back 40 weeks: 7–9 October become 31 December 2025 – 2 January 2026.
  const r = scratchReplay(BARS.map((b) => ({ ...b, t: b.t - 280 * 86400e3 })));
  const out = r.run(['--from', '2025-12-31', '--to', '2026-01-02T23:59', '--rule', '1.5R', '--workers', '1', '--holdout']);
  assert.match(out, /== rule 1\.5R · 2025, held back: 32 checks in the window/);
  assert.match(out, /== rule 1\.5R · 2026, already seen \(decision 26\): 64 checks in the window/);
  assert.doesNotMatch(out, /== rule 1\.5R:/, 'no combined block');
  assert.match(out, /2026 rows were seen while choosing the 1\.5R rule/);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
