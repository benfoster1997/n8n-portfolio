/**
 * The learner's features (desk/features.mjs): one check described as numbers,
 * price-free, signed by market direction, from closed bars only. Bars are the
 * real ten days of Binance BTCUSDT fifteen-minute candles recorded on 11 Oct
 * 2026 (fixtures/btc-m15.json); gold is the same shapes scaled to gold's
 * price, which is all a price-free feature should notice. Nothing here
 * touches the network.
 *
 * What these tests hold it to:
 *  - the same inputs give the same numbers, and the names keep their order
 *    (a stored row is the values in that order);
 *  - a feature at bar k never changes when later bars are added or altered;
 *  - a sell sees the mirror of a buy: directional features flip, the level
 *    ahead and the level behind swap, the rest stay;
 *  - the net and confidence recomputed from the buckets are analyse()'s own;
 *  - a moment the live desk sat out (gold's dead zone, a release blackout)
 *    still gets its features, and they are the same ones the engine saw.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  featuresAt, analysisForFeatures, sideSigned, conditionOf, engineScore,
  FEATURE_NAMES, DIRECTIONAL, SWAPPED, WHY_NULL, REGIMES, HOUR_BANDS, WEEKDAYS, WINDOW_BARS, HISTORY_BARS,
} from '../desk/features.mjs';
import { liveRead, ENGINE_BARS, FETCH_BARS } from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { analyse, WEIGHTS } from '../src/signal-engine.js';
import { closedBars } from '../src/data-feeds.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { sessionQuality } from '../src/sessions.js';
import { getActiveBlackout } from '../src/news-calendar.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(join(here, 'fixtures', 'btc-m15.json'), 'utf8'));
const BARS = F.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const M15 = 15 * 60000;
const cfg = withDefaults({});
const at = (k) => BARS[k].t + M15 + 20000;                 // 20 s after bar k closes, as the watcher reads
const historyTo = (bars, k) => bars.slice(Math.max(0, k - HISTORY_BARS + 1), k + 1);
const IDEA_K = 581;                                        // Wed 7 Oct 14:15 London: a live idea (test/live.test.mjs)
const kClosingAt = (iso) => BARS.findIndex((b) => b.t + M15 === Date.parse(iso));

/** Features at bar k of `bars` for `pair`, by the dataset's route. */
function rowAt(k, { bars = BARS, pair = 'BTCUSD' } = {}) {
  const closed = historyTo(bars, k);
  const nowMs = bars[k].t + M15 + 20000;
  const analysis = analysisForFeatures({ closed, pair, cfg, nowMs });
  return { analysis, closed, nowMs, f: featuresAt({ closed, analysis, nowMs, cfg, pair }) };
}

// One shared sample across the fixture's last 500 bars (every 13th), so the
// suite stays at a few dozen engine reads.
const SAMPLE = [];
for (let k = 480; k < BARS.length; k += 13) SAMPLE.push({ k, ...rowAt(k) });
const SWAP_NAMES = SWAPPED.flat();

console.log('\nthe names');
test('FEATURE_NAMES is pinned: a stored row is the values in this order, so reordering is a format change', () => {
  assert.deepEqual([...FEATURE_NAMES], [
    'net', 'confidence',
    'b_trend', 'b_momentum', 'b_structure', 'b_location', 'b_volume', 'volume_abstain',
    'b_volatility', 'atr_change_1h', 'bb_width_pctile', 'adx', 'atr_over_price', 'atr_pctile',
    'regime_trending', 'regime_ranging', 'regime_compressed', 'regime_mixed', 'efficiency',
    'h1_bias', 'h4_bias', 'htf_agree',
    'ret_1', 'ret_4', 'ret_16', 'ret_96',
    'close_vs_ema21', 'close_vs_ema50', 'close_vs_vwap', 'rsi_m50', 'bb_pctb_m05', 'bar_range', 'bar_body',
    'level_ahead', 'level_behind', 'level_ahead_none', 'level_behind_none', 'rel_volume',
    'hour_08_10', 'hour_10_12', 'hour_12_14', 'hour_14_16',
    'wd_mon', 'wd_tue', 'wd_wed', 'wd_thu', 'wd_fri',
  ]);
  assert.ok(Object.isFrozen(FEATURE_NAMES), 'frozen, so no caller can reorder it in place');
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length, 'no duplicates');
});
test('every row has exactly those keys, in that order', () => {
  for (const { f } of SAMPLE) assert.deepEqual(Object.keys(f), [...FEATURE_NAMES]);
});
test('every name is directional, a swapped level pair, or side-free — exactly one of the three', () => {
  for (const n of [...DIRECTIONAL, ...SWAP_NAMES]) assert.ok(FEATURE_NAMES.includes(n), `${n} is not a feature`);
  for (const n of FEATURE_NAMES) {
    const kinds = [DIRECTIONAL.includes(n), SWAP_NAMES.includes(n)].filter(Boolean).length;
    assert.ok(kinds <= 1, `${n} is in more than one list`);
  }
  assert.equal(new Set(SWAP_NAMES).size, SWAP_NAMES.length);
});
test('the regime one-hot covers every regime detectRegime can return, and every set of weights', () => {
  const src = readFileSync(join(here, '..', 'src', 'signal-engine.js'), 'utf8');
  const named = new Set([...src.matchAll(/regime = '(\w+)'/g)].map((m) => m[1]));
  assert.ok(named.size >= 4, 'found the regime assignments in the engine');
  assert.deepEqual([...named].sort(), [...REGIMES].sort());
  assert.deepEqual(Object.keys(WEIGHTS).sort(), [...REGIMES].sort());
});
test('the window and history are the watcher\'s', () => {
  assert.equal(WINDOW_BARS, ENGINE_BARS);
  assert.equal(HISTORY_BARS, FETCH_BARS);
});

console.log('\nthe same every time, and never from the future');
test('the same bars, clock and config give the same numbers', () => {
  for (const k of [IDEA_K, 850]) {
    const a = rowAt(k).f, b = rowAt(k).f;
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a, 'survives JSON: no NaN, no −0, no Infinity');
  }
});
test('features at bar k do not move when later bars are appended or altered', () => {
  // Every bar after k: prices up 30%, volume ×5, and 40 invented bars beyond
  // the fixture. The caller's route (closedBars at the check's moment) must
  // give exactly what bars up to k give.
  const extra = [];
  for (let j = 1; j <= 40; j++) {
    const p = BARS[BARS.length - 1];
    extra.push({ t: p.t + j * M15, o: p.c * 2, h: p.c * 2.2, l: p.c * 1.9, c: p.c * 2.1, v: 1e6 });
  }
  for (const k of [520, IDEA_K, 700, 900]) {
    const base = rowAt(k).f;
    const future = BARS.map((b, i) => (i > k ? { ...b, o: b.o * 1.3, h: b.h * 1.3, l: b.l * 1.3, c: b.c * 1.3, v: b.v * 5 } : b)).concat(extra);
    const nowMs = at(k);
    const closed = closedBars(future, 15, nowMs).slice(-HISTORY_BARS);
    assert.equal(closed[closed.length - 1].t, BARS[k].t, 'only bars closed by the check');
    const analysis = analysisForFeatures({ closed, pair: 'BTCUSD', cfg, nowMs });
    assert.deepStrictEqual(featuresAt({ closed, analysis, nowMs, cfg, pair: 'BTCUSD' }), base, `bar ${k}`);
  }
});
test('a bar still forming at the check, or a history running past the window, is refused', () => {
  const k = IDEA_K;
  const { analysis, closed } = rowAt(k);
  // The bar k+1 is still forming 20 s after bar k closes.
  assert.throws(() => analysisForFeatures({ closed: BARS.slice(0, k + 2), pair: 'BTCUSD', cfg, nowMs: at(k) }), /had not closed/);
  assert.throws(() => featuresAt({ closed: BARS.slice(0, k + 2), analysis, nowMs: at(k), cfg }), /had not closed/);
  // A history ending later than the engine's window would put later bars into the H4 bias.
  assert.throws(() => featuresAt({ window: closed.slice(-300, -1), closed, analysis, nowMs: at(k), cfg }), /same bar/);
  // An analysis of a different moment.
  assert.throws(() => featuresAt({ closed: historyTo(BARS, k - 1), analysis, nowMs: at(k), cfg }), /not made on this window/);
});

console.log('\nwhat the numbers are');
test('every feature is finite, or null for a documented reason', () => {
  const rows = [...SAMPLE, { k: 70, ...rowAt(70) }, { k: 200, ...rowAt(200) }];
  const seenNull = new Set();
  for (const { k, f } of rows) {
    for (const n of FEATURE_NAMES) {
      const v = f[n];
      if (v === null) {
        assert.ok(WHY_NULL[n], `bar ${k}: ${n} is null with no reason in WHY_NULL`);
        seenNull.add(n);
      } else {
        assert.equal(typeof v, 'number', `bar ${k}: ${n}`);
        assert.ok(Number.isFinite(v), `bar ${k}: ${n} = ${v}`);
      }
    }
  }
  // The early bars really do exercise the null paths.
  for (const n of ['h1_bias', 'h4_bias', 'htf_agree', 'ret_96', 'atr_pctile']) assert.ok(seenNull.has(n), `${n} was never null`);
  const early = rowAt(200).f;
  assert.equal(early.h4_bias, null, '201 M15 bars hold too few closed H4 bars');
  assert.notEqual(early.h1_bias, null, '...but enough H1 bars');
});
test('when the engine cannot read at all (too few bars), every feature is null', () => {
  const f = rowAt(30).f;
  assert.equal(rowAt(30).analysis.state, 'insufficient-data');
  assert.ok(FEATURE_NAMES.every((n) => f[n] === null));
});
test('nothing is in dollars: gold scaled from the same shapes reads the same, to rounding', () => {
  const s = 4375 / BARS[IDEA_K].c;
  const scaled = BARS.map((b) => ({ ...b, o: b.o * s, h: b.h * s, l: b.l * s, c: b.c * s }));
  const a = rowAt(IDEA_K).f, b = rowAt(IDEA_K, { bars: scaled }).f;
  for (const n of FEATURE_NAMES) {
    if (a[n] === null) { assert.equal(b[n], null, n); continue; }
    assert.ok(Math.abs(a[n] - b[n]) < 1e-6 * Math.max(1, Math.abs(a[n])), `${n}: ${a[n]} vs ${b[n]}`);
  }
});
test('one-hots: exactly one regime; at most one hour band and weekday, set from the London clock', () => {
  for (const { f } of SAMPLE) {
    assert.equal(REGIMES.filter((r) => f[`regime_${r}`] === 1).length, 1);
    assert.ok(HOUR_BANDS.filter((b) => f[b.key] === 1).length <= 1);
    assert.ok(WEEKDAYS.filter((d) => f[d.key] === 1).length <= 1);
  }
  const f = rowAt(IDEA_K).f;                               // Wednesday 14:15 London (13:15 UTC, BST)
  assert.equal(f.hour_14_16, 1);
  assert.equal(f.wd_wed, 1);
  const sat = rowAt(kClosingAt('2026-10-10T12:00:00Z')).f; // Saturday: no weekday feature
  assert.ok(WEEKDAYS.every((d) => sat[d.key] === 0));
});
test('level distances are positive, and "none" is set exactly when the distance is missing', () => {
  for (const { f } of SAMPLE) {
    for (const [d, none] of [['level_ahead', 'level_ahead_none'], ['level_behind', 'level_behind_none']]) {
      assert.equal(f[none], f[d] === null ? 1 : 0);
      if (f[d] !== null) assert.ok(f[d] > 0, `${d} = ${f[d]}`);
    }
  }
});

console.log('\nthe engine\'s own net, for every state');
test('net and raw confidence equal analyse()\'s own wherever it prints them (read and neutral)', () => {
  let reads = 0;
  for (const { k, analysis, f } of SAMPLE) {
    if (analysis.state !== 'read' && analysis.state !== 'neutral') continue;
    if (analysis.state === 'read') reads++;
    assert.equal(+f.net.toFixed(3), analysis.net, `bar ${k} net`);
    assert.ok(Math.abs(f.net - analysis.net) <= 0.0005 + 1e-12, `bar ${k} net`);
    assert.equal(+f.confidence.toFixed(2), analysis.confidence, `bar ${k} confidence`);
  }
  assert.ok(reads >= 3, `the sample held only ${reads} reads`);
});
test('the live path and the dataset give the same features at the same bar (an idea)', () => {
  const k = IDEA_K;
  const r = liveRead({ pair: 'BTCUSD', bars: BARS.slice(0, k + 1), nowMs: at(k), cfg });
  assert.equal(r.kind, 'idea');
  const closed = closedBars(BARS.slice(0, k + 1), 15, at(k));
  const live = featuresAt({ closed, analysis: r.analysis, nowMs: at(k), cfg, pair: 'BTCUSD' });
  assert.deepStrictEqual(live, rowAt(k).f);
  assert.equal(+live.net.toFixed(3), r.analysis.net);
});
test('engineScore marks confidence down for the final stretch and a short window, as analyse() does', () => {
  const { analysis } = rowAt(IDEA_K);
  const full = engineScore(analysis, { windowLength: 300 });
  assert.ok(Math.abs(engineScore(analysis, { windowLength: 300, lastStretch: true }).confidence - full.confidence * 0.6) < 1e-12);
  assert.ok(Math.abs(engineScore(analysis, { windowLength: 120 }).confidence - full.confidence * 0.85) < 1e-12);
  assert.equal(engineScore(analysis, { windowLength: 120 }).net, full.net, 'the net does not depend on either');
  assert.deepEqual(engineScore({ state: 'insufficient-data' }, { windowLength: 10 }), { net: null, confidence: null });
});

console.log('\nmoments the live desk sat out');
test('gold in its dead zone: blocked live, withheld by the engine, but it still has features — the engine\'s own', () => {
  const k = kClosingAt('2026-10-07T09:45:00Z');           // Wednesday 10:45 London
  const s = 4375 / BARS[k].c;
  const gold = BARS.map((b) => ({ ...b, o: b.o * s, h: b.h * s, l: b.l * s, c: b.c * s }));
  const nowMs = gold[k].t + M15 + 20000;
  const live = liveRead({ pair: 'XAUUSD', bars: gold.slice(0, k + 1), nowMs, cfg });
  assert.equal(live.kind, 'blocked');
  const closed = historyTo(gold, k);
  const session = sessionQuality(nowMs, 'XAUUSD', cfg.window);
  assert.equal(session.band, 'dead');
  const withheld = analyse({ bars: closed.slice(-300), htfBars: closed, instrument: INSTRUMENTS.XAUUSD, spread: 0.05, session, nowMs, timeframe: 'M15' });
  assert.equal(withheld.state, 'stand-down');
  assert.equal(withheld.net, undefined, 'analyse prints no net when it withholds the read');
  const { analysis, f } = rowAt(k, { bars: gold, pair: 'XAUUSD' });
  assert.ok(analysis.state !== 'stand-down' && analysis.state !== 'stand-aside');
  assert.ok(Number.isFinite(f.net) && Number.isFinite(f.confidence));
  assert.equal(f.hour_10_12, 1);
  assert.equal(f.wd_wed, 1);
  // Recomputed from the withheld read's buckets: the same features.
  assert.deepStrictEqual(featuresAt({ closed, analysis: withheld, nowMs, cfg, pair: 'XAUUSD' }), f);
  assert.ok(Math.abs(f.confidence - withheld.suppressedConfidence) <= 0.005, 'and the confidence it disclosed');
});
test('bitcoin in a release blackout: blocked live, set aside by the engine, still the same features', () => {
  const k = 674;                                           // Thu 8 Oct 13:30 London, weekly jobless claims
  const nowMs = at(k);
  const blackout = getActiveBlackout(nowMs, 'BTCUSD', {});
  assert.ok(blackout && blackout.active);
  assert.equal(liveRead({ pair: 'BTCUSD', bars: BARS.slice(0, k + 1), nowMs, cfg }).kind, 'blocked');
  const closed = historyTo(BARS, k);
  const aside = analyse({
    bars: closed.slice(-300), htfBars: closed, instrument: INSTRUMENTS.BTCUSD, spread: 6, blackout,
    session: { ...sessionQuality(nowMs, 'BTCUSD', cfg.window), lastStretch: false }, nowMs, timeframe: 'M15',
  });
  assert.equal(aside.state, 'stand-aside');
  const { f } = rowAt(k);
  assert.ok(Number.isFinite(f.net));
  assert.deepStrictEqual(featuresAt({ closed, analysis: aside, nowMs, cfg, pair: 'BTCUSD' }), f);
});
test('bitcoin\'s own quiet hours are read as the live path reads them (dead band mapped, not withheld)', () => {
  const k = kClosingAt('2026-10-08T08:30:00Z');           // Thursday 09:30 London
  assert.equal(sessionQuality(at(k), 'BTCUSD', cfg.window).band, 'dead');
  const r = liveRead({ pair: 'BTCUSD', bars: BARS.slice(0, k + 1), nowMs: at(k), cfg });
  assert.ok(r.analysis, `the live path read it (${r.kind})`);
  assert.deepStrictEqual(featuresAt({ closed: historyTo(BARS, k), analysis: r.analysis, nowMs: at(k), cfg }), rowAt(k).f);
});

console.log('\nfor a side');
test('a sell sees the mirror: directional features flip, ahead and behind swap, the rest stay', () => {
  for (const { k, f } of SAMPLE) {
    const s = sideSigned(f, -1);
    assert.deepEqual(Object.keys(s), [...FEATURE_NAMES], 'same keys, same order');
    for (const n of FEATURE_NAMES) {
      if (DIRECTIONAL.includes(n)) assert.equal(s[n], f[n] === null ? null : -f[n] + 0, `bar ${k}: ${n}`);
      else if (!SWAP_NAMES.includes(n)) assert.equal(s[n], f[n], `bar ${k}: ${n}`);
    }
    for (const [x, y] of SWAPPED) { assert.equal(s[x], f[y]); assert.equal(s[y], f[x]); }
    assert.ok(Object.values(s).every((v) => !Object.is(v, -0)), 'no −0 (it would break equality on a round trip)');
    assert.deepStrictEqual(sideSigned(s, -1), f, 'mirroring twice gives back the original');
    assert.deepStrictEqual(sideSigned(f, 1), f, 'a buy sees the raw, market-direction features');
    assert.notEqual(sideSigned(f, 1), f, '...as a copy');
    assert.deepStrictEqual(sideSigned(f, 'sell'), s);
  }
  assert.throws(() => sideSigned(SAMPLE[0].f, 0), /side/);
});

console.log('\nthe condition cell');
test('conditionOf: the coarse cell, with signs relative to the side', () => {
  const f = rowAt(IDEA_K).f;                               // a sell idea in a downtrend
  const sell = conditionOf(f, { side: -1 });
  assert.deepEqual(Object.keys(sell).sort(), ['agree', 'buckets', 'confidenceLabel', 'h1', 'h4', 'hourBand', 'regime', 'side', 'weekday']);
  assert.equal(sell.side, 'sell');
  assert.equal(sell.regime, REGIMES.find((r) => f[`regime_${r}`] === 1));
  assert.equal(sell.hourBand, '14-16');
  assert.equal(sell.weekday, 'Wed');
  assert.ok(['low', 'moderate', 'firm'].includes(sell.confidenceLabel));
  const buy = conditionOf(f, { side: 'buy' });
  assert.equal(buy.side, 'buy');
  assert.equal(buy.h1, -sell.h1 + 0);
  assert.equal(buy.h4, -sell.h4 + 0);
  assert.equal(buy.agree, sell.agree, 'agreement between H1 and H4 has no side');
  assert.equal(buy.confidenceLabel, sell.confidenceLabel);
  for (const n of Object.keys(buy.buckets)) {
    if (buy.buckets[n] === null) assert.equal(sell.buckets[n], null);
    else assert.equal(buy.buckets[n], -sell.buckets[n] + 0, n);
  }
  assert.deepEqual(conditionOf(f).buckets, buy.buckets, 'no side = market direction = a buyer\'s view');
  assert.equal(conditionOf(f).side, null);
});
test('conditionOf: an abstaining volume bucket is "no data", not "no lean"; outside the bands, null', () => {
  const f = { ...rowAt(IDEA_K).f, volume_abstain: 1, b_volume: 0, hour_14_16: 0, wd_wed: 0 };
  const c = conditionOf(f, { side: 1 });
  assert.equal(c.buckets.volume, null);
  assert.equal(c.hourBand, null);
  assert.equal(c.weekday, null);
  assert.equal(conditionOf({ ...f, htf_agree: null, h4_bias: null }).agree, null);
  assert.equal(conditionOf({ ...f, confidence: 0.29 }).confidenceLabel, 'low');
  assert.equal(conditionOf({ ...f, confidence: 0.3 }).confidenceLabel, 'moderate');
  assert.equal(conditionOf({ ...f, confidence: 0.55 }).confidenceLabel, 'firm');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
