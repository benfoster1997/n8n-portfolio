/**
 * The reads behind the replay (desk/reads.mjs): one read per check, computed
 * in parallel, then the alert sequence applied serially. On the recorded
 * Binance bars (fixtures/btc-m15.json), so the engine sees real shapes.
 * Kept small: about 200 reads in all, so the suite stays quick.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAt, computeReads, alertPass, checkIndices, kindFor, longestGap, loadBarsFile, spreadAt, readsFor, storePath, GAP_BARS,
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
const alertsOf = (reads, extra = {}) => alertPass(reads, BARS, { cfg, rule: '1.5R', ...extra }).trades.map((t) => `${t.at} ${t.side} ${t.r.toFixed(4)}`);

console.log('\nworkers');
test('three workers give exactly the reads and alerts one process gives', async () => {
  assert.equal(KS.length, 96);
  const three = await computeReads(BARS, KS, { ...opts, workers: 3, file: FIXTURE, chunk: 20 });
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
  const a = alertPass(one, BARS, { cfg, rule: '1.5R' }).trades[1];
  const b = alertPass(wide, BARS, { cfg, rule: '1.5R' }).trades[1];
  assert.equal(a.at, b.at);
  assert.ok(b.r < a.r, `${b.r} < ${a.r}`);
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
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
