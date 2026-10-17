/**
 * The learner's dataset (desk/dataset.mjs) and its features hook
 * (desk/features-extra.mjs): one row per window check, in the pinned ROW
 * FORMAT, with labels scored exactly as outcome() scores them.
 *
 * The fixture is NOT development-year data. fixtures/btc-m15.json holds real
 * Binance bars from 1–11 October 2026: inside the held-back window, in the
 * stretch already seen while choosing the 1.5R rule (decision 26). Moved back
 * 104 weeks, to October 2024 (the same weekdays and clock changes), the period
 * guards no longer see them as held back, so the tests below do compute labels
 * on already-seen 2026 bars. The rule for this file: no test may print or
 * aggregate their R (a sum, a mean, a count of targets or stops). Assertions
 * that a label equals outcome(), that net is not above gross, or that some buy
 * reached its target are allowed; nothing that reports how they did.
 * Synthetic bars (a steady climb, a hole) carry the tests that need a known
 * result. No network: bars are handed in. Kept small — about 400 reads in all,
 * most of them the cheap 'no-data' ones.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRows, readRows, rowsPath, readOptions, rowFor, planLevels, parseWhen, parseArgs, periodOfMs, ROW_KEYS, RULE,
  manifestPath, readManifest, rowsKey, rowsKeyFor, LABELS, lockPath, replaceRefusal,
} from '../desk/dataset.mjs';
import { loadDataset, compactRow, filterData, readsFromRows } from '../desk/learn.mjs';
import { extra, standardStop, noiseStop, STOP_ATR_MULTIPLE } from '../desk/features-extra.mjs';
import { readsFor, readAt, alertPass, loadBarsFile, spreadAt, kindFor, storeKey, longestGap, GAP_BARS } from '../desk/reads.mjs';
import { FEATURE_NAMES, FEATURES_VERSION, featuresAt, analysisForFeatures, conditionOf } from '../desk/features.mjs';
import { outcome } from '../desk/outcome.mjs';
import { withDefaults, costFor } from '../desk/lib.mjs';
import { windowState } from '../src/sessions.js';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
  });
};

const here = dirname(fileURLToPath(import.meta.url));
const DATASET = join(here, '..', 'desk', 'dataset.mjs');
const M15 = 15 * 60000;
const WEEKS_104 = 728 * 86400e3;
const BARS = loadBarsFile(join(here, 'fixtures', 'btc-m15.json'), 'BTCUSD').map((b) => ({ ...b, t: b.t - WEEKS_104 }));
const cfg = withDefaults({});
const scratch = (p) => mkdtempSync(join(tmpdir(), p));
const ALL = { fromMs: BARS[0].t, toMs: BARS[BARS.length - 1].t + M15 };
// One London session, Wednesday 9 October 2024: 32 checks (closes 08:00 to 15:45), all with an engine read.
const DAY = { fromMs: Date.parse('2024-10-09T07:00Z'), toMs: Date.parse('2024-10-09T15:00Z') };
const base = { pair: 'BTCUSD', cfg, cost: 'scaled', calendar: 'rules' };

const collect = async (path) => { const out = []; for await (const r of readRows(path)) out.push(r); return out; };
const closeOf = (o) => windowState(o.closeMs, cfg.window).closesAtMs;

// The shared build: every check in the recorded bars, in this process.
const HOME = scratch('dataset-');
const built = await buildRows({ ...base, bars: BARS, ...ALL, workers: 1, home: HOME });
const ROWS = await collect(built.path);
// The very reads it was made from, served by the read store (nothing recomputed).
const served = await readsFor(BARS, ROWS.map((r) => BARS.findIndex((b) => b.t === r.t)), readOptions({ ...base, workers: 1 }), { home: HOME });
const READS = served.reads;
const COMM = costFor('BTCUSD', 0, cfg).comm;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isNumOrNull = (x) => x === null || isNum(x);
const HOWS = ['target', 'stop', 'window', 'both'];

console.log('\nthe row format');
test('every row holds exactly the pinned keys, in order, with the pinned types', () => {
  assert.equal(built.rows, ROWS.length);
  assert.equal(ROWS.length, 204, 'every weekday check of the recorded bars');
  assert.equal(served.computed, 0, 'the reads came back from the store');
  const kinds = new Set();
  for (const r of ROWS) {
    assert.deepEqual(Object.keys(r), ROW_KEYS);
    kinds.add(r.kind);
    assert.ok(isNum(r.t) && r.closeMs === r.t + M15);
    assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([r.pair, r.tf, r.cost, r.calendar, r.fv], ['BTCUSD', 'M15', 'scaled', 'rules', FEATURES_VERSION]);
    assert.ok(['idea', 'rejected', 'none', 'blocked', 'gap', 'no-data', 'stale'].includes(r.kind), r.kind);
    assert.ok([null, 'long', 'short'].includes(r.lean));
    assert.equal(r.lean !== null, r.kind === 'idea' || r.kind === 'rejected', 'a lean exactly where the engine leaned');
    assert.ok(isNum(r.spreadNum) && r.spreadNum > 0);
    assert.ok(r.blackoutId === null || typeof r.blackoutId === 'string');
    assert.equal(typeof r.alerted, 'boolean');
    assert.equal(typeof r.gapAhead, 'boolean');
    if (r.gapAhead) {
      assert.equal(r.b, null, 'label (b) is not scored across a hole');
      if (r.a) assert.deepEqual([r.a.gross, r.a.net], [null, null], 'label (a) keeps its levels, not a result');
    }
    const noBars = ['gap', 'no-data', 'stale'].includes(r.kind);
    if (noBars) {
      assert.deepEqual([r.f, r.cond, r.atr, r.stopStd, r.a, r.b], [null, null, null, null, null, null]);
    } else {
      assert.deepEqual(Object.keys(r.f), [...FEATURE_NAMES]);
      assert.ok(Object.values(r.f).every(isNumOrNull));
      assert.ok(isNum(r.atr) && r.atr > 0 && isNum(r.stopStd) && r.stopStd > 0);
      assert.ok(r.b || r.gapAhead, 'label (b) on every row with features, unless a hole lies ahead');
    }
    if (r.lean) {
      assert.deepEqual(r.cond, conditionOf(r.f, { side: r.lean === 'long' ? 'buy' : 'sell' }));
      assert.equal(r.cond.side, r.lean === 'long' ? 'buy' : 'sell');
    } else assert.equal(r.cond, null);
    if (r.a) {
      assert.deepEqual(Object.keys(r.a), ['side', 'stopDist', 'tp1Dist', 'confidence', 'netR', 'gross', 'net']);
      assert.equal(r.a.side, r.lean === 'long' ? 'buy' : 'sell');
      for (const o of [r.a.gross, r.a.net]) {
        if (o === null && r.gapAhead) continue;
        assert.deepEqual(Object.keys(o), ['r', 'how', 'bars', 'mfe', 'mae']);
        assert.ok(isNum(o.r) && HOWS.includes(o.how) && o.bars >= 1 && o.mfe >= 0 && o.mae >= 0);
      }
    }
    if (r.b) {
      assert.deepEqual(Object.keys(r.b), ['stopDist', 'tp1Dist', 'long', 'short']);
      assert.equal(r.b.stopDist, r.stopStd);
      assert.ok(Math.abs(r.b.tp1Dist - 1.5 * r.stopStd) < 1e-9);
      for (const s of [r.b.long, r.b.short]) {
        assert.deepEqual(Object.keys(s), ['gross', 'net']);
        for (const o of [s.gross, s.net]) { assert.deepEqual(Object.keys(o), ['r', 'how']); assert.ok(isNum(o.r) && HOWS.includes(o.how)); }
      }
    }
  }
  for (const k of ['idea', 'rejected', 'none', 'no-data', 'blocked']) assert.ok(kinds.has(k), `the recorded bars hold a ${k} row`);
});
test('rows are in time order, one per check, dated on London\'s calendar', () => {
  for (let i = 1; i < ROWS.length; i++) assert.ok(ROWS[i].closeMs > ROWS[i - 1].closeMs);
  const r = ROWS.find((x) => x.closeMs === Date.parse('2024-10-09T07:00Z'));
  assert.equal(r.day, '2024-10-09', '08:00 London');
});

console.log('\nlabel (a): the watcher\'s own trade');
test('only on idea and rejected rows, and exactly outcome() on the read\'s 1.5R levels, gross and net', () => {
  let ideas = 0, rejected = 0;
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i], read = READS[i];
    assert.equal(read.closeMs, r.closeMs);
    if (r.kind !== 'idea' && r.kind !== 'rejected') { assert.equal(r.a, null, r.kind); continue; }
    assert.ok(r.a, `${r.kind} at ${r.day} has label (a)`);
    const res = read.rules[RULE];
    if (r.kind === 'idea') {
      ideas++;
      assert.equal(r.a.stopDist, res.stopDistance);
      assert.equal(r.a.tp1Dist, Math.abs(res.takeProfit1 - res.entry));
      assert.equal(r.a.side, res.decision);
    } else {
      rejected++;
      const price = BARS[read.k].c;
      assert.equal(r.a.side, res.plan.side, 'a rejected idea\'s side is its plan\'s');
      assert.equal(r.a.stopDist, Math.abs(price - res.plan.stopLoss));
      assert.equal(r.a.tp1Dist, Math.abs(res.plan.takeProfit1 - price));
    }
    assert.deepEqual([r.a.confidence, r.a.netR], [res.confidence ?? null, res.netR ?? null]);
    const rec = { side: r.a.side, stopDist: r.a.stopDist, tp1Dist: r.a.tp1Dist };
    const at = { closesAtMs: closeOf(r), tfMinutes: 15, bothTouched: 'half' };
    const g = outcome(BARS, read.k, rec, { ...at, spread: 0, comm: 0 });
    const n = outcome(BARS, read.k, rec, { ...at, spread: r.spreadNum, comm: COMM });
    assert.deepEqual(r.a.gross, { r: g.r, how: g.how, bars: g.bars, mfe: g.mfe, mae: g.mae });
    assert.deepEqual(r.a.net, { r: n.r, how: n.how, bars: n.bars, mfe: n.mfe, mae: n.mae });
  }
  assert.ok(ideas >= 5 && rejected >= 30, `${ideas} ideas, ${rejected} rejected`);
});
test('planLevels refuses a plan with no stop or target rather than scoring nothing', () => {
  const read = READS.find((r) => kindFor(r, RULE) === 'rejected');
  const broken = { ...read, rules: { [RULE]: { ...read.rules[RULE], plan: { ...read.rules[RULE].plan, stopLoss: null } } } };
  assert.equal(planLevels(broken, BARS), null);
  assert.equal(rowFor(broken, BARS, { ...base, comm: COMM }).a, null);
});

console.log('\nlabel (b): the standard long and short');
test('its stop is max(1.2 x ATR, the engine\'s noise-scaled minimum) and its target 1.5 of that', () => {
  assert.equal(STOP_ATR_MULTIPLE, 1.2);
  // Bitcoin's minimum is 0.15% of price, scaled by √3 on M15.
  assert.ok(Math.abs(noiseStop('BTCUSD', 60000, 'M15') - 60000 * 0.0015 * Math.sqrt(3)) < 1e-9);
  assert.equal(standardStop('BTCUSD', 60000, 200, 'M15'), 240, 'the ATR stop when it is wider');
  assert.equal(standardStop('BTCUSD', 60000, 50, 'M15'), noiseStop('BTCUSD', 60000, 'M15'), 'the floor when ATR is small');
  assert.equal(standardStop('BTCUSD', 60000, 0, 'M15'), noiseStop('BTCUSD', 60000, 'M15'), 'a frozen feed (ATR 0) gets the noise floor, as max() does');
  for (const atr of [NaN, null, -1, Infinity]) assert.equal(standardStop('BTCUSD', 60000, atr, 'M15'), null, `no stop from ATR ${atr}`);
  assert.equal(standardStop('BTCUSD', 0, 100, 'M15'), null);
  for (const r of ROWS.filter((x) => x.f)) assert.equal(r.stopStd, standardStop('BTCUSD', BARS.find((b) => b.t === r.t).c, r.atr, 'M15'));
});
test('it is outcome() for a buy and a sell at that stop, gross and net, on every row with features', () => {
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i];
    if (!r.b) continue;
    const at = { closesAtMs: closeOf(r), tfMinutes: 15, bothTouched: 'half' };
    for (const [key, side] of [['long', 'buy'], ['short', 'sell']]) {
      const rec = { side, stopDist: r.b.stopDist, tp1Dist: r.b.tp1Dist };
      const g = outcome(BARS, READS[i].k, rec, { ...at, spread: 0, comm: 0 });
      const n = outcome(BARS, READS[i].k, rec, { ...at, spread: r.spreadNum, comm: COMM });
      assert.deepEqual(r.b[key], { gross: { r: g.r, how: g.how }, net: { r: n.r, how: n.how } });
    }
  }
});

/** A steady climb (or its mirror image), 1,100 bars ending at Wednesday 13 March 2024's session. */
function monotone(dir) {
  const n = 1100, step = 40, end = Date.parse('2024-03-13T16:00Z');
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = end - (n - i) * M15;
    const o = 60000 + dir * i * step, c = o + dir * step;
    out.push({ t, o, c, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, v: 100 });
  }
  return out;
}
test('on a series that only rises the long reaches its target and the short its stop; on its mirror, the reverse', async () => {
  const session = { fromMs: Date.parse('2024-03-13T08:00Z'), toMs: Date.parse('2024-03-13T13:00Z') };
  const up = await collect((await buildRows({ ...base, bars: monotone(1), ...session, home: scratch('mono-'), useStore: false })).path);
  const down = await collect((await buildRows({ ...base, bars: monotone(-1), ...session, home: scratch('mono-'), useStore: false })).path);
  assert.equal(up.length, 21);
  assert.equal(down.length, up.length);
  for (let i = 0; i < up.length; i++) {
    const u = up[i].b, d = down[i].b;
    assert.ok(u && d, 'label (b) on every row');
    assert.deepEqual([u.long.gross.how, u.short.gross.how, d.long.gross.how, d.short.gross.how], ['target', 'stop', 'stop', 'target']);
    assert.equal(u.long.gross.r, 1.5, 'gross: the target is exactly 1.5 times the risk');
    assert.equal(u.short.gross.r, -1);
    assert.equal(d.short.gross.r, 1.5);
    assert.equal(d.long.gross.r, -1);
  }
});
test('gross and net mirror exactly between a buy and a sell on mirrored bars', () => {
  // The pure scorer, with the same stop on both: a buy on the climb and a sell on its mirror image.
  const upBars = monotone(1), downBars = upBars.map((b) => ({ t: b.t, o: 200000 - b.o, c: 200000 - b.c, h: 200000 - b.l, l: 200000 - b.h }));
  const k = 1050, at = { spread: 0, comm: 0, closesAtMs: Date.parse('2024-03-13T16:00Z'), tfMinutes: 15, bothTouched: 'half' };
  for (const stopDist of [100, 300, 2000]) {
    const a = outcome(upBars, k, { side: 'buy', stopDist, tp1Dist: 1.5 * stopDist }, at);
    const b = outcome(downBars, k, { side: 'sell', stopDist, tp1Dist: 1.5 * stopDist }, at);
    assert.deepEqual([a.r, a.how, a.bars], [b.r, b.how, b.bars], `stop ${stopDist}`);
  }
});

test('a trade whose path crosses a hole in the bars is not scored: gapAhead, label (a)\'s levels kept without a result, b null', async () => {
  // The steady climb with 12:00–15:00 UTC removed (13 bars, more than GAP_BARS):
  // the reads before the hole see no gap behind them, but the trades from the
  // later checks could only end on the bars after it.
  const session = { fromMs: Date.parse('2024-03-13T08:00Z'), toMs: Date.parse('2024-03-13T13:00Z') };
  const hole = [Date.parse('2024-03-13T12:00Z'), Date.parse('2024-03-13T15:15Z')];
  const whole = monotone(1);
  const holed = whole.filter((b) => b.t < hole[0] || b.t >= hole[1]);
  assert.equal(whole.length - holed.length, 13);
  const plain = await collect((await buildRows({ ...base, bars: whole, ...session, home: scratch('gap-'), useStore: false })).path);
  const rows = await collect((await buildRows({ ...base, bars: holed, ...session, home: scratch('gap-'), useStore: false })).path);
  assert.ok(plain.every((r) => r.gapAhead === false && r.b), 'with no hole, every row is scored');
  assert.equal(rows.length, 17, 'checks closing 08:00 to 12:00 (the later bars are missing)');
  const at = { spread: 0, comm: 0, tfMinutes: 15, bothTouched: 'half' };
  let flagged = 0, scored = 0;
  for (const r of rows) {
    const o = plain.find((x) => x.closeMs === r.closeMs);
    assert.deepEqual([r.kind, r.f, r.stopStd], [o.kind, o.f, o.stopStd], 'the hole is ahead: the read itself is unchanged');
    // Where label (b)'s trades would end on the holed bars, and whether they cross the hole.
    const k = holed.findIndex((b) => b.t === r.t);
    const ends = ['buy', 'sell'].map((side) => outcome(holed, k, { side, stopDist: o.stopStd, tp1Dist: 1.5 * o.stopStd }, { ...at, closesAtMs: closeOf(r) }));
    const crosses = ends.some((e) => longestGap(holed, k, e ? k + e.bars : holed.length - 1, M15) > GAP_BARS);
    if (crosses) assert.equal(r.gapAhead, true, `${r.closeMs}: label (b) would cross the hole`);
    if (r.gapAhead) {
      flagged++;
      assert.equal(r.b, null);
      assert.deepEqual(r.a, o.a ? { ...o.a, gross: null, net: null } : null, 'label (a): the same levels as without the hole, gross and net null');
    } else { scored++; assert.ok(r.b); }
  }
  assert.ok(flagged > 0 && scored > 0, `${flagged} withheld, ${scored} scored: the early checks end before the hole, the late ones would not`);
  assert.equal(rows[rows.length - 1].gapAhead, true, 'the check at noon cannot end before the hole');
  assert.equal(rows[0].gapAhead, false, 'the 08:00 check ends long before it');
  assert.match(LABELS.gapAhead, new RegExp(`${GAP_BARS} missing bars`));
});
test('an idea with a hole ahead keeps label (a)\'s levels, so desk/learn.mjs loads the rows, rebuilds its read, and trains without it', async () => {
  // The recorded bars with 13 bars removed straight after an idea's check.
  const idea = ROWS.find((r) => r.kind === 'idea' && r.a && r.a.gross);
  const k = BARS.findIndex((b) => b.t === idea.t);
  const holed = [...BARS.slice(0, k + 1), ...BARS.slice(k + 14)];
  const range = { fromMs: Date.parse(`${idea.day}T00:00Z`), toMs: idea.closeMs + 3600e3 };
  const home = scratch('gap-idea-');
  const built2 = await buildRows({ ...base, bars: holed, ...range, home, useStore: false });
  const rows = await collect(built2.path);
  const r = rows.find((x) => x.closeMs === idea.closeMs);
  assert.deepEqual([r.kind, r.gapAhead, r.b], ['idea', true, null], 'the idea\'s trade would cross the hole');
  assert.deepEqual(r.a, { ...idea.a, gross: null, net: null }, 'its levels are the read\'s, unscored');
  const ds = await loadDataset(built2.path, { pair: 'BTCUSD', cfg });
  assert.equal(ds.rows.length, rows.length, 'learn reads every row: an idea with its levels is not a damaged row');
  const c = ds.rows.find((x) => x.closeMs === idea.closeMs);
  assert.equal(c.gapAhead, true, 'compactRow carries the flag');
  assert.equal(compactRow(r).gapAhead, true);
  const rebuilt = readsFromRows(ds.rows, holed).find((rd) => rd.closeMs === idea.closeMs);
  assert.equal(rebuilt.rules['1.5R'].decision, idea.a.side, 'its read is rebuilt from the levels');
  const leans = ds.rows.filter((x) => x.kind === 'idea' || x.kind === 'rejected');
  assert.equal(filterData(ds.rows).X.length, leans.filter((x) => x.a && x.a.gross).length, 'training takes only scored rows');
  assert.ok(leans.some((x) => x.a && !x.a.gross), 'and there is an unscored one to leave out');
});

console.log('\ngross and net');
test('net is never better than gross, and a buy that ends the same way is worse by the spread', () => {
  let strictly = 0;
  const pairs = [];
  for (const r of ROWS) {
    if (r.a) pairs.push([r.a.side, r.a.gross, r.a.net, r.a.stopDist, r.a.tp1Dist]);
    if (r.b) { pairs.push(['buy', r.b.long.gross, r.b.long.net, r.b.stopDist, r.b.tp1Dist]); pairs.push(['sell', r.b.short.gross, r.b.short.net, r.b.stopDist, r.b.tp1Dist]); }
    for (const [side, g, n, stop, tp] of pairs.splice(0)) {
      assert.ok(n.r <= g.r + 1e-12, `${n.r} <= ${g.r}`);
      if (side === 'buy' && g.how === n.how && g.how === 'target') {
        const s = r.spreadNum;
        assert.ok(Math.abs(n.r - (tp - s) / (stop + s)) < 1e-12, 'a buy\'s target pays tp1 less the spread, over the stop plus the spread');
        assert.ok(Math.abs(g.r - tp / stop) < 1e-12);
        strictly++;
      }
      if (side === 'buy' && g.how === 'stop' && n.how === 'stop') assert.equal(n.r, -1);
    }
  }
  assert.ok(strictly > 0, 'some buy reached its target');
});

console.log('\nalerted');
test('alerted is exactly the replay\'s alert pass over the same reads', () => {
  const trades = alertPass(READS, BARS, { cfg, rule: '1.5R', pair: 'BTCUSD' }).trades;
  assert.ok(trades.length >= 1, 'some alert in the recorded bars');
  assert.deepEqual(ROWS.filter((r) => r.alerted).map((r) => r.closeMs), trades.map((t) => t.closeMs));
  assert.ok(ROWS.filter((r) => r.alerted).every((r) => r.kind === 'idea'));
  // Scored with the half rule, the alerts' own results are label (a)'s net.
  const half = alertPass(READS, BARS, { cfg, rule: '1.5R', pair: 'BTCUSD', bothTouched: 'half' }).trades;
  for (const t of half) assert.equal(ROWS.find((r) => r.closeMs === t.closeMs).a.net.r, t.r);
  assert.ok(ROWS.some((r) => r.kind === 'idea' && !r.alerted), 'an idea the cooldown or a running trade held back');
});

console.log('\nworkers, look-ahead and costs');
test('three worker threads write exactly the rows one process writes', async () => {
  const file = join(scratch('bars-'), 'bars.json');
  writeFileSync(file, JSON.stringify({ BTCUSD: BARS }));
  const source = 'test-fixture-2024';
  const one = await buildRows({ ...base, bars: BARS, ...ALL, workers: 1, home: scratch('w1-'), file, source, useStore: false });
  const three = await buildRows({ ...base, bars: BARS, ...ALL, workers: 3, home: scratch('w3-'), file, source, useStore: false, chunk: 20, minPerWorker: 20 });
  assert.equal(three.reads.workers, 3, 'three threads really started');
  assert.equal(one.reads.workers, 0);
  assert.equal(readFileSync(three.path, 'utf8'), readFileSync(one.path, 'utf8'));
  assert.equal(readFileSync(one.path, 'utf8').split('\n').filter(Boolean).length, 204);
});
test('no look-ahead: changing every bar after a check leaves its features, lean and stops alone', async () => {
  const cut = Date.parse('2024-10-09T11:00Z');   // a bar opening at noon London
  const altered = BARS.map((b) => (b.t >= cut ? { ...b, o: b.o * 1.1, h: b.h * 1.13, l: b.l * 0.9, c: b.c * 0.95, v: b.v * 3 } : b));
  const rows = await collect((await buildRows({ ...base, bars: altered, ...DAY, home: scratch('ahead-'), useStore: false })).path);
  const before = rows.filter((r) => r.t < cut);
  assert.equal(before.length, 17, 'the checks closing 08:00 to 12:00 London');
  let labelsMoved = 0;
  for (const r of before) {
    const o = ROWS.find((x) => x.closeMs === r.closeMs);
    assert.deepEqual([r.kind, r.lean, r.f, r.cond, r.atr, r.stopStd, r.spreadNum], [o.kind, o.lean, o.f, o.cond, o.atr, o.stopStd, o.spreadNum], r.day + ' ' + r.closeMs);
    if (JSON.stringify(r.b) !== JSON.stringify(o.b)) labelsMoved++;
  }
  assert.ok(labelsMoved > 0, 'the labels, which do look forward, did change');
  assert.ok(rows.filter((r) => r.t >= cut).some((r) => JSON.stringify(r.f) !== JSON.stringify(ROWS.find((x) => x.closeMs === r.closeMs).f)), 'and later rows\' features did');
});
test('the extra() hook sees the same features the live path gives, for a lean and a blocked moment', () => {
  const k = BARS.findIndex((b) => b.t + M15 === Date.parse('2024-10-09T12:15Z'));
  const read = readAt(BARS, k, { ...base, rules: [RULE], extra });
  const closed = BARS.slice(Math.max(0, k - 999), k + 1);
  const an = analysisForFeatures({ closed, pair: 'BTCUSD', cfg, nowMs: read.nowMs, tf: 'M15', spreadNum: read.spreadNum });
  assert.deepEqual(read.extra.f, featuresAt({ closed, analysis: an, nowMs: read.nowMs, cfg, pair: 'BTCUSD', tf: 'M15' }), 'the engine\'s own analysis and the features-only re-read agree');
  const blockedRow = ROWS.find((r) => r.kind === 'blocked');
  assert.ok(blockedRow.f && blockedRow.b && blockedRow.a === null && blockedRow.lean === null && blockedRow.cond === null, 'a blocked row: features and label (b), never a lean or label (a)');
  const ctx = { pair: 'BTCUSD', tf: 'M15', cfg, nowMs: 0, spreadNum: 6, closed: [], window: [], analysis: null, read: {} };
  for (const kind of ['gap', 'no-data', 'stale']) assert.deepEqual(extra({ ...ctx, kind }), { f: null, cond: null, atr: null, stopStd: null });
});
test('cost "max" charges every row at least the fixed and the scaled spread, and has its own rows file', async () => {
  const home = scratch('max-');
  const r = await buildRows({ ...base, cost: 'max', bars: BARS, ...DAY, home, useStore: false });
  const rows = await collect(r.path);
  assert.equal(rows.length, 32, 'bars closing 08:00 to 15:45 London');
  for (const row of rows) {
    const c = BARS.find((b) => b.t === row.t).c;
    assert.equal(row.cost, 'max');
    assert.ok(row.spreadNum >= spreadAt('BTCUSD', c, 'fixed') && row.spreadNum >= spreadAt('BTCUSD', c, 'scaled'));
  }
  assert.notEqual(r.path, rowsPath(home, { ...base, cost: 'scaled' }));
  assert.match(r.path, /BTCUSD-M15-max-rules-[0-9a-f]{16}\.rows\.jsonl$/);
});

console.log('\nthe file and the command line');
test('the rows file is named by its settings, and a second build reads nothing again', async () => {
  assert.equal(built.path, rowsPath(HOME, base));
  assert.match(built.path, /learn\/BTCUSD-M15-scaled-rules-[0-9a-f]{16}\.rows\.jsonl$/);
  assert.notEqual(rowsPath(HOME, { ...base, calendar: 'full' }), built.path);
  assert.deepEqual(readdirSync(join(HOME, 'learn')).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
  const again = await buildRows({ ...base, bars: BARS, ...ALL, workers: 1, home: HOME });
  assert.deepEqual([again.reads.fromStore, again.reads.computed], [204, 0]);
  assert.deepEqual(await collect(again.path), ROWS);
  const bad = join(scratch('bad-'), 'x.rows.jsonl');
  writeFileSync(bad, '{"t":1}\n{not json\n');
  await assert.rejects(collect(bad), /line 2 is not a row/);
});
test('the manifest says what the rows file holds, and today\'s code can recompute its key', async () => {
  const m = readManifest(built.path);
  assert.deepEqual(Object.keys(m), ['fromMs', 'toMs', 'firstCloseMs', 'lastCloseMs', 'rows', 'sha256', 'rowsKey', 'storeKey', 'settings', 'source', 'holdout', 'featuresVersion', 'labelVersion', 'builtAt']);
  assert.deepEqual([m.fromMs, m.toMs, m.rows], [ALL.fromMs, ALL.toMs, ROWS.length]);
  assert.deepEqual([m.firstCloseMs, m.lastCloseMs], [ROWS[0].closeMs, ROWS[ROWS.length - 1].closeMs], 'the first and last check written');
  assert.equal(m.holdout, false);
  assert.equal(m.sha256, createHash('sha256').update(readFileSync(built.path)).digest('hex'), 'the hash of the rows file\'s bytes');
  assert.deepEqual(m.settings, { pair: 'BTCUSD', tf: 'M15', cost: 'scaled', calendar: 'rules' });
  assert.deepEqual([m.featuresVersion, m.labelVersion], [FEATURES_VERSION, LABELS.version]);
  const opts = readOptions({ ...base, workers: 1 });
  assert.deepEqual([m.rowsKey, m.storeKey], [rowsKey(opts), storeKey(opts)]);
  assert.ok(built.path.includes(m.rowsKey), 'the key is in the file name');
  assert.equal(rowsKeyFor(m.settings, { cfg, source: m.source }), m.rowsKey, 'recomputed from the manifest\'s settings');
  assert.equal(rowsKeyFor({ ...m.settings, source: m.source }, { cfg }), m.rowsKey, 'the source may ride in the settings');
  assert.notEqual(rowsKeyFor({ ...m.settings, cost: 'max' }, { cfg, source: m.source }), m.rowsKey);
  assert.notEqual(rowsKeyFor(m.settings, { cfg, source: 'binance' }), m.rowsKey, 'other bars, another key');
  assert.equal(manifestPath(built.path), `${built.path}.manifest.json`);
});
test('a build never silently replaces wider rows, never writes an empty file, and never holds held-back labels', async () => {
  const home = scratch('guard-');
  const wide = await buildRows({ ...base, bars: BARS, ...ALL, home });
  const bytes = readFileSync(wide.path);
  await assert.rejects(buildRows({ ...base, bars: BARS, ...DAY, home }), /wider than this build; add --replace/);
  const weekend = { fromMs: Date.parse('2024-10-05T00:00Z'), toMs: Date.parse('2024-10-06T23:00Z') };
  await assert.rejects(buildRows({ ...base, bars: BARS, ...weekend, home }), /No window checks .* only with --replace/);
  assert.deepEqual(readFileSync(wide.path), bytes, 'the wide rows are untouched');
  const narrow = await buildRows({ ...base, bars: BARS, ...DAY, home, replace: true });
  assert.equal(narrow.rows, 32, 'with --replace the narrower build is written');
  assert.deepEqual([readManifest(narrow.path).fromMs, readManifest(narrow.path).rows], [DAY.fromMs, 32]);
  // A wider build may replace a narrower one; a rows file with no manifest is of unknown range.
  await buildRows({ ...base, bars: BARS, ...ALL, home });
  rmSync(manifestPath(wide.path));
  await assert.rejects(buildRows({ ...base, bars: BARS, ...ALL, home }), /no readable manifest/);
  // Held back: the fixture moved into January 2025 is refused without the flag.
  const jan = BARS.map((b) => ({ ...b, t: b.t + 13 * 7 * 86400e3 }));
  await assert.rejects(buildRows({ ...base, bars: jan, fromMs: jan[0].t, toMs: jan[jan.length - 1].t, home: scratch('held-'), useStore: false }), /held back for one final test/);
});
test('the same range with bars missing writes fewer rows: refused unless --replace, judged on what the old manifest recorded', async () => {
  const home = scratch('fewer-');
  const wide = await buildRows({ ...base, bars: BARS, ...ALL, home });
  const bytes = readFileSync(wide.path);
  const cut = BARS.filter((b) => b.t < Date.parse('2024-10-08T00:00Z'));
  await assert.rejects(buildRows({ ...base, bars: cut, ...ALL, home }), /holds 204 rows .* writes only \d+/);
  assert.deepEqual(readFileSync(wide.path), bytes, 'the rows are untouched');
  // The pure test, on the manifest's first and last checks.
  const m = readManifest(wide.path);
  const closes = (await collect(wide.path)).map((r) => r.closeMs);
  const same = { fromMs: m.fromMs, toMs: m.toMs, rows: m.rows, firstCloseMs: m.firstCloseMs, lastCloseMs: m.lastCloseMs, closes };
  assert.equal(replaceRefusal(wide.path, same), null, 'the same checks again: allowed');
  assert.match(replaceRefusal(wide.path, { ...same, firstCloseMs: m.firstCloseMs + M15 }), /starts with the check at/);
  assert.match(replaceRefusal(wide.path, { ...same, lastCloseMs: m.lastCloseMs - M15 }), /ends with the check at/);
  assert.match(replaceRefusal(wide.path, { ...same, rows: 0, firstCloseMs: null, lastCloseMs: null, closes: [] }), /writes only 0/);
  // Review, 17 Oct: the same total and ends, but a day lost in the middle and one added before.
  const day = (c) => new Date(c).toISOString().slice(0, 10);
  const lostDay = day(closes[Math.floor(closes.length / 2)]);
  const swapped = [...closes.map((c) => c - 7 * 86400e3).filter((c) => c < m.firstCloseMs).slice(-32), ...closes.filter((c) => day(c) !== lostDay)];
  const n = swapped.length;
  assert.ok(n >= m.rows - 32 && swapped[0] < m.firstCloseMs && swapped[n - 1] === m.lastCloseMs);
  assert.match(replaceRefusal(wide.path, { fromMs: Math.min(m.fromMs, swapped[0]), toMs: m.toMs, rows: Math.max(n, m.rows), firstCloseMs: swapped[0], lastCloseMs: m.lastCloseMs, closes: swapped }),
    new RegExp(`holds ${m.rows} checks from .* would write only ${m.rows - closes.filter((c) => day(c) === lostDay).length} of them again`));
  const ok = await buildRows({ ...base, bars: cut, ...ALL, home, replace: true });
  assert.ok(ok.rows < 204, 'with --replace it is written');
});
test('a build holds a lock beside the rows file; a second build of the same file is refused while it exists', async () => {
  const home = scratch('lock-');
  const path = rowsPath(home, base);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(lockPath(path), '1 x\n');
  await assert.rejects(buildRows({ ...base, bars: BARS, ...DAY, home, useStore: false }), /Another build holds .*\.lock/);
  assert.equal(existsSync(path), false, 'nothing written');
  rmSync(lockPath(path));
  const r = await buildRows({ ...base, bars: BARS, ...DAY, home, useStore: false });
  assert.equal(r.path, path);
  assert.equal(existsSync(lockPath(path)), false, 'the lock is released after the build');
  // And released when the build fails inside it (workers without a bar file).
  await assert.rejects(buildRows({ ...base, bars: BARS, ...DAY, home, useStore: false, replace: true, workers: 2, minPerWorker: 10 }), /bar file for workers/);
  assert.deepEqual(readdirSync(join(home, 'learn')).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), [], 'no lock or temporary file left behind');
});
test('held-back (--holdout) rows go to a file of their own and never replace the development rows', async () => {
  const home = scratch('holdname-');
  assert.match(rowsPath(home, base, { holdout: true }), /BTCUSD-M15-scaled-rules-holdout-[0-9a-f]{16}\.rows\.jsonl$/);
  assert.notEqual(rowsPath(home, base, { holdout: true }), rowsPath(home, base));
  const dev = await buildRows({ ...base, bars: BARS, ...DAY, home, useStore: false });
  const bytes = readFileSync(dev.path);
  const held = await buildRows({ ...base, bars: BARS, ...ALL, home, useStore: false, holdout: true });
  assert.notEqual(held.path, dev.path);
  assert.equal(readManifest(held.path).holdout, true);
  assert.deepEqual(readFileSync(dev.path), bytes, 'the development rows are untouched');
});
test('dates: a day alone in --to is its end; times are UTC; impossible dates are refused; the holdout periods are conditions.mjs\'s', () => {
  assert.equal(parseWhen('2024-12-31', { endOfDay: true }), Date.parse('2025-01-01T00:00Z') - 1);
  assert.equal(parseWhen('2017-09-01'), Date.parse('2017-09-01T00:00Z'));
  assert.equal(parseWhen('2026-10-14T20:45'), Date.parse('2026-10-14T20:45Z'));
  assert.equal(parseWhen('2024-12-31T23:59:59.999Z'), Date.parse('2025-01-01T00:00Z') - 1);
  assert.equal(parseWhen('2024-06-01T09:00+01:00'), Date.parse('2024-06-01T08:00Z'));
  assert.equal(parseWhen('2024-02-29'), Date.parse('2024-02-29T00:00Z'), 'a leap day exists');
  for (const bad of ['2024-02-30', '2023-02-29', '2024-13-01', '2024-04-31', '2024-10-01T24:00', '2024-10-01T12:60', '2024-1-5', 'soon', '', '2024-10-01 12:00'])
    assert.ok(Number.isNaN(parseWhen(bad)), `${JSON.stringify(bad)} is refused, not rolled over`);
  assert.deepEqual(parseArgs(['--pair', 'bitcoin', '--replace']).flags, { pair: 'bitcoin', replace: true });
  assert.match(parseArgs(['--to']).error, /--to needs a value/);
  assert.match(parseArgs(['--to', '']).error, /--to needs a value/, 'an empty value is not the default');
  assert.match(parseArgs(['--from', '  ']).error, /--from needs a value/);
  assert.match(parseArgs(['--to', '--holdout']).error, /--to needs a value/);
  assert.match(parseArgs(['--hodlout']).error, /Unknown flag --hodlout/);
  assert.match(parseArgs(['--cost', 'max', '--cost', 'fixed']).error, /twice/);
  assert.match(parseArgs(['bitcoin']).error, /Unexpected/);
  assert.deepEqual(['2024-12-31T15:00Z', '2025-06-02T09:00Z', '2026-03-02T09:00Z', '2026-10-15T09:00Z'].map((s) => periodOfMs(Date.parse(s))), ['dev', 'clean', 'seen', 'fresh']);
});
test('the command prints counts by year and kind, the file and timings — and for held-back rows, recorded, only their number', () => {
  // The recorded bars moved back 92 weeks instead: 26 December 2024 to 5 January 2025, across the holdout's edge.
  const dir = scratch('cli-');
  const bars = join(dir, 'bars.json');
  writeFileSync(bars, JSON.stringify({ BTCUSD: BARS.map((b) => ({ ...b, t: b.t + WEEKS_104 - 644 * 86400e3 })) }));
  writeFileSync(join(dir, 'config.json'), '{}');
  const model = join(dir, 'model.json');
  const env = { ...process.env, SCALP_DESK_HOME: join(dir, 'home'), SCALP_DESK_CONFIG: join(dir, 'config.json'), SCALP_DESK_BARS: bars, SCALP_DESK_MODEL: model };
  const bad = (args) => { try { execFileSync('node', [DATASET, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }); return 'ran'; } catch (x) { return `EXIT ${x.status}\n${x.stdout}`; } };
  const range = ['--pair', 'bitcoin', '--from', '2024-12-01', '--to', '2025-01-10', '--workers', '1'];
  assert.match(bad(range), /^EXIT 2\n2025-01-01 onward is held back/, 'held-back checks are refused without --holdout');
  assert.equal(existsSync(model), false, 'and nothing is recorded');
  // The default range ends on 31 December 2024: only the development rows.
  const dev = execFileSync('node', [DATASET, '--pair', 'bitcoin', '--from', '2024-12-01', '--workers', '1'], { encoding: 'utf8', env });
  assert.match(dev, /checks 2024-12-01 00:00 → 2024-12-31 23:59 UTC/);
  assert.doesNotMatch(dev, /held back from 2025/);
  assert.match(dev, /manifest → .*\.rows\.jsonl\.manifest\.json · rowsKey [0-9a-f]{16}/);
  assert.equal(existsSync(model), false);
  const out = execFileSync('node', [DATASET, ...range, '--holdout'], { encoding: 'utf8', env });
  const looks = JSON.parse(readFileSync(model, 'utf8')).looks;
  assert.equal(looks.length, 1, 'the --holdout look is recorded in model.json');
  assert.equal(looks[0].by, 'desk/dataset.mjs');
  assert.deepEqual([looks[0].range.to, looks[0].settings.cost, looks[0].settings.calendar], ['2025-01-10T23:59:59.999Z', 'scaled', 'rules']);
  assert.match(out, /this look is recorded in/);
  assert.match(out, /BTCUSD M15 dataset · cost scaled · calendar rules/);
  assert.match(out, /rows written: 208 in [\d.]+ s → .*BTCUSD-M15-scaled-rules-holdout-[0-9a-f]{16}\.rows\.jsonl/, 'held-back rows have a file of their own');
  const devPath = /rows written: \d+ in [\d.]+ s → (\S+)/.exec(dev)[1];
  assert.ok(existsSync(devPath) && readManifest(devPath).holdout === false, 'the development rows are still there, not replaced');
  assert.match(out, /development years, rows by kind:\n {2}2024 {2}no-data \d+.* · total \d+/);
  assert.match(out, /held back from 2025-01-01, counted only: 2025 96 rows · 2026 to 14 October 0 rows/);
  assert.doesNotMatch(out, /2025 +(idea|rejected|none|blocked)/, 'no kinds for a held-back year');
  // Nothing that could be a result: no R, no average, no target or stop counts.
  // (The rows file's path is left out: its random scratch folder name could spell anything.)
  assert.doesNotMatch(out.replace(/→ \S+/g, '').replace(/(rowsKey|sha256) [0-9a-f]+/g, '').replace(/recorded in \S+/, ''), /\d R\b|\dR\b|average|mean|target|stop|win/i);
  assert.match(execFileSync('node', [DATASET, '--holdout', ...range], { encoding: 'utf8', env }), /already been looked at 1 time/, 'a second look says so');
  assert.equal(JSON.parse(readFileSync(model, 'utf8')).looks.length, 2);
  assert.match(bad(['--cost', 'cheap']), /^EXIT 2\n--cost is one of fixed, scaled, max/);
  assert.match(bad(['--from', 'soon']), /^EXIT 2\n--from and --to take real dates/);
  assert.match(bad(['--from', '2024-02-30']), /^EXIT 2\n--from and --to take real dates/, 'an impossible date is not rolled over');
  assert.match(bad(['--to']), /^EXIT 2\n--to needs a value/, 'a flag without its value is not its default');
  assert.match(bad(['--to', '']), /^EXIT 2\n--to needs a value/, 'nor an empty one');
  assert.match(bad(['--to', '--holdout']), /^EXIT 2\n--to needs a value/);
  assert.match(bad(['--hodlout']), /^EXIT 2\nUnknown flag --hodlout/);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
