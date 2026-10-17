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
 *    still gets its features, and they are the same ones the engine saw;
 *  - a missing or mismatched input is refused, never turned into a quieter
 *    meaning or an all-null row, and the re-read for features carries no lean;
 *  - the live feed's 999 closed bars, the dataset's 1,000 and a whole history
 *    all give the same row;
 *  - the definitions are versioned: editing this module without a conscious
 *    FEATURES_VERSION decision fails here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  featuresAt, analysisForFeatures, featuresFromBars, sideSigned, conditionOf, engineScore,
  FEATURE_NAMES, DIRECTIONAL, SWAPPED, WHY_NULL, REGIMES, HOUR_BANDS, WEEKDAYS, WINDOW_BARS, HISTORY_BARS,
  FEATURES_VERSION, BANDS_TZ,
} from '../desk/features.mjs';
import { liveRead, ENGINE_BARS, FETCH_BARS } from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { analyse, WEIGHTS } from '../src/signal-engine.js';
import { closedBars } from '../src/data-feeds.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { sessionQuality, windowState } from '../src/sessions.js';
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
function rowAt(k, { bars = BARS, pair = 'BTCUSD', config = cfg } = {}) {
  const closed = historyTo(bars, k);
  const nowMs = bars[k].t + M15 + 20000;
  const analysis = analysisForFeatures({ closed, pair, cfg: config, nowMs });
  return { analysis, closed, nowMs, f: featuresAt({ closed, analysis, nowMs, cfg: config, pair }) };
}

/**
 * analyse()'s own full read of the moment analysisForFeatures re-reads (no
 * blackout, no dead band), which prints the net and confidence the features
 * must reproduce. Test-only: the module never hands a full read out.
 */
function engineReadAt(k, { bars = BARS, pair = 'BTCUSD' } = {}) {
  const closed = historyTo(bars, k);
  const nowMs = bars[k].t + M15 + 20000;
  let session = { ...sessionQuality(nowMs, pair, cfg.window), lastStretch: windowState(nowMs, cfg.window).phase === 'last-30' };
  if (session.band === 'dead') session = { ...session, band: 'red' };
  return analyse({
    bars: closed.slice(-WINDOW_BARS), htfBars: closed, instrument: INSTRUMENTS[pair],
    spread: INSTRUMENTS[pair].typicalSpread.observed, blackout: null, session, nowMs, timeframe: 'M15',
  });
}

/**
 * Twenty days of bars: the fixture with a copy of itself prepended, one
 * fixture-length earlier and scaled so the seam has no price jump. Enough to
 * run past HISTORY_BARS, which the 999-bar fixture alone never does.
 */
const LONG = (() => {
  const span = BARS.length * M15, s = BARS[0].o / BARS[BARS.length - 1].c;
  return [...BARS.map((b) => ({ ...b, t: b.t - span, o: b.o * s, h: b.h * s, l: b.l * s, c: b.c * s })), ...BARS];
})();
const scaledBy = (bars, s) => bars.map((b) => ({ ...b, o: b.o * s, h: b.h * s, l: b.l * s, c: b.c * s }));

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
    'b_volatility', 'log_atr_change_1h', 'bb_width_pctile', 'adx', 'atr_over_price', 'atr_pctile',
    'regime_trending', 'regime_ranging', 'regime_compressed', 'regime_mixed', 'efficiency',
    'h1_bias', 'h4_bias', 'htf_agree',
    'ret_1', 'ret_4', 'ret_16', 'ret_96',
    'close_vs_ema21', 'close_vs_ema50', 'close_vs_vwap', 'rsi_m50', 'bb_pctb_m05', 'bar_range', 'bar_body',
    'level_ahead', 'level_behind', 'level_ahead_none', 'level_behind_none', 'log_rel_volume',
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
test('a bar still forming at the check, or an analysis of another moment, is refused', () => {
  const k = IDEA_K;
  const { analysis } = rowAt(k);
  // The bar k+1 is still forming 20 s after bar k closes.
  assert.throws(() => analysisForFeatures({ closed: BARS.slice(0, k + 2), pair: 'BTCUSD', cfg, nowMs: at(k) }), /had not closed/);
  assert.throws(() => featuresAt({ closed: BARS.slice(0, k + 2), analysis, nowMs: at(k), cfg }), /had not closed/);
  // An analysis of a different moment.
  assert.throws(() => featuresAt({ closed: historyTo(BARS, k - 1), analysis, nowMs: at(k), cfg }), /not made on this window/);
  // The window is never handed in separately, so it cannot end on another bar than the history.
  assert.throws(() => featuresAt({ window: historyTo(BARS, k).slice(-300, -1), closed: historyTo(BARS, k), analysis, nowMs: at(k), cfg }), /takes no window/);
  assert.throws(() => analysisForFeatures({ window: historyTo(BARS, k).slice(-300), closed: historyTo(BARS, k), pair: 'BTCUSD', cfg, nowMs: at(k) }), /takes no window/);
});
test('a missing input is refused, never read as a narrower history or an all-null row', () => {
  const k = IDEA_K;
  const { analysis, closed, nowMs } = rowAt(k);
  // No history: the old fallback ranked the ATR percentile over the 300-bar window instead.
  assert.throws(() => featuresAt({ analysis, nowMs, cfg }), /needs `closed`/);
  assert.throws(() => featuresAt({ closed: [], analysis, nowMs, cfg }), /needs `closed`/);
  assert.throws(() => analysisForFeatures({ pair: 'BTCUSD', cfg, nowMs }), /needs `closed`/);
  // No analysis: liveRead's blocked and no-data results carry none.
  const blocked = liveRead({ pair: 'BTCUSD', bars: BARS.slice(0, 675), nowMs: at(674), cfg });
  assert.equal(blocked.kind, 'blocked');
  assert.throws(() => featuresAt({ closed: historyTo(BARS, 674), analysis: blocked.analysis, nowMs: at(674), cfg }), /needs the engine's analysis/);
  assert.throws(() => featuresAt({ closed, analysis: {}, nowMs, cfg }), /needs the engine's analysis/);
  // An analysis with a state but nothing to describe.
  assert.throws(() => featuresAt({ closed, analysis: { state: 'read', price: analysis.price }, nowMs, cfg }), /carries no/);
  // 'insufficient-data' is believed only when the window really is short.
  assert.throws(() => featuresAt({ closed, analysis: { state: 'insufficient-data' }, nowMs, cfg }), /not made on this window/);
});
test('bars that repeat or go back, and a check long after the last bar, are refused', () => {
  const k = IDEA_K;
  const { analysis, closed, nowMs } = rowAt(k);
  // A duplicated last bar (a merge bug) would have set ret_1 to 0.
  const dup = [...closed.slice(0, -1), closed[closed.length - 2]];
  assert.throws(() => featuresAt({ closed: dup, analysis, nowMs, cfg }), /rise strictly/);
  assert.throws(() => analysisForFeatures({ closed: dup, pair: 'BTCUSD', cfg, nowMs }), /rise strictly/);
  const swapped = [...closed.slice(0, 500), closed[501], closed[500], ...closed.slice(502)];
  assert.throws(() => featuresAt({ closed: swapped, analysis, nowMs, cfg }), /rise strictly/);
  // liveRead's stale rule: more than two bars after the last close.
  const closeMs = BARS[k].t + M15;
  assert.doesNotThrow(() => featuresAt({ closed, analysis, nowMs: closeMs + 2 * M15, cfg }));
  assert.throws(() => featuresAt({ closed, analysis, nowMs: closeMs + 2 * M15 + 1, cfg }), /stale/);
  assert.throws(() => analysisForFeatures({ closed, pair: 'BTCUSD', cfg, nowMs: closeMs + 6 * 3600e3 }), /stale/);
});

test('an analysis of a longer history, a shorter one or the other instrument is refused, though its last close matches', () => {
  // Review, 17 Oct 2026: only the last close was compared, so a short `closed`
  // with the full history's analysis was accepted and atr_pctile moved.
  const k = BARS.length + IDEA_K;                       // Wed 7 Oct 14:15 London on the long series: the watcher reads it
  const nowMs = LONG[k].t + M15 + 20000;
  const full = historyTo(LONG, k);
  const analysis = analysisForFeatures({ closed: full, pair: 'BTCUSD', cfg, nowMs });
  assert.doesNotThrow(() => featuresAt({ closed: full, analysis, nowMs, cfg, pair: 'BTCUSD' }));
  for (const n of [300, 120, 40]) {
    assert.throws(() => featuresAt({ closed: full.slice(-n), analysis, nowMs, cfg, pair: 'BTCUSD' }), /not made on this window/, `closed = the last ${n} bars`);
  }
  // A live analysis carries no instrument; a features-only one does, and it must match.
  const gold = analysisForFeatures({ closed: full, pair: 'XAUUSD', cfg, nowMs });
  assert.throws(() => featuresAt({ closed: full, analysis: gold, nowMs, cfg, pair: 'BTCUSD' }), /it is of XAUUSD, not BTCUSD/);
  // The 999 closed bars of the live fetch with their own analysis pass; the same analysis against 1,000 is checked, not assumed.
  const live = liveRead({ pair: 'BTCUSD', bars: LONG.slice(k - (HISTORY_BARS - 2), k + 2), nowMs, cfg });
  assert.ok(live.analysis);
  assert.doesNotThrow(() => featuresAt({ closed: full.slice(-(HISTORY_BARS - 1)), analysis: live.analysis, nowMs, cfg, pair: 'BTCUSD' }));
});

console.log('\nhow much history');
test('a whole history gives exactly the row the last 1,000 bars give, through both functions', () => {
  // A dataset may hand in every bar up to the check; analysisForFeatures used
  // to read all of them for the H4 bias and relative volume while featuresAt
  // read 1,000, which matched neither the watcher nor itself.
  let checked = 0;
  for (let k = 1010; k < LONG.length; k += 31) {
    const nowMs = LONG[k].t + M15 + 20000;
    const all = LONG.slice(0, k + 1), cut = historyTo(LONG, k);
    assert.equal(cut.length, HISTORY_BARS);
    const fAll = featuresAt({ closed: all, analysis: analysisForFeatures({ closed: all, pair: 'BTCUSD', cfg, nowMs }), nowMs, cfg });
    const fCut = featuresAt({ closed: cut, analysis: analysisForFeatures({ closed: cut, pair: 'BTCUSD', cfg, nowMs }), nowMs, cfg });
    assert.deepStrictEqual(fAll, fCut, `bar ${k}`);
    checked++;
  }
  assert.ok(checked >= 25);
});
test('the live feed (1,000 bars, one still forming: 999 closed) and the dataset (1,000 closed) give the same row', () => {
  let compared = 0;
  for (let k = 1100; k < LONG.length - 1; k += 41) {
    const nowMs = LONG[k].t + M15 + 20000;
    const raw = LONG.slice(k - (HISTORY_BARS - 2), k + 2);            // what the watcher's fetch returns
    assert.equal(raw.length, HISTORY_BARS);
    assert.equal(closedBars(raw, 15, nowMs).length, HISTORY_BARS - 1);
    const dataset = featuresAt({ closed: historyTo(LONG, k), analysis: analysisForFeatures({ closed: historyTo(LONG, k), pair: 'BTCUSD', cfg, nowMs }), nowMs, cfg });
    // Blocked moments: the re-read is made from the feed's bars.
    assert.deepStrictEqual(featuresFromBars({ bars: raw, nowMs, cfg, pair: 'BTCUSD' }), dataset, `bar ${k}, re-read`);
    const r = liveRead({ pair: 'BTCUSD', bars: raw, nowMs, cfg });
    if (!r.analysis) continue;
    assert.deepStrictEqual(featuresFromBars({ bars: raw, nowMs, cfg, pair: 'BTCUSD', analysis: r.analysis }), dataset, `bar ${k}, live analysis`);
    compared++;
  }
  assert.ok(compared >= 5, `only ${compared} live reads compared`);
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
test('a frozen feed (ATR zero): every null has a reason, and ATR over price is 0, not null', () => {
  const flat = BARS.map((b) => ({ ...b, o: 100, h: 100, l: 100, c: 100 }));
  const closed = flat.slice(0, 600), nowMs = at(599);
  const analysis = analysisForFeatures({ closed, pair: 'BTCUSD', cfg, nowMs });
  assert.equal(analysis.atr, 0);
  const f = featuresAt({ closed, analysis, nowMs, cfg });
  for (const n of FEATURE_NAMES) if (f[n] === null) assert.ok(WHY_NULL[n], `${n} is null with no reason in WHY_NULL`);
  for (const n of ['close_vs_vwap', 'bar_range', 'bar_body', 'ret_1']) assert.equal(f[n], null, n);
  assert.equal(f.atr_over_price, 0);
});
test('when the engine cannot read at all (too few bars), every feature is null', () => {
  const f = rowAt(30).f;
  assert.equal(rowAt(30).analysis.state, 'insufficient-data');
  assert.ok(FEATURE_NAMES.every((n) => f[n] === null));
});
test('nothing is in dollars: the same shapes at another price read the same, to rounding, for both instruments', () => {
  const close = (a, b, n) => (a === null ? b === null : Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a))) || assert.fail(`${n}: ${a} vs ${b}`);
  const a = rowAt(IDEA_K).f, b = rowAt(IDEA_K, { bars: scaledBy(BARS, 4375 / BARS[IDEA_K].c) }).f;
  for (const n of FEATURE_NAMES) close(a[n], b[n], n);
  // Gold's own instrument: its VWAP resets at 17:00 New York, not midnight UTC.
  const gold = scaledBy(BARS, 4375 / BARS[IDEA_K].c);
  const g1 = rowAt(IDEA_K, { bars: gold, pair: 'XAUUSD' }).f, g2 = rowAt(IDEA_K, { bars: scaledBy(gold, 1.7), pair: 'XAUUSD' }).f;
  for (const n of FEATURE_NAMES) close(g1[n], g2[n], n);
  assert.notEqual(g1.close_vs_vwap, b.close_vs_vwap, 'gold\'s VWAP path really was exercised');
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
test('the hour band and weekday are London\'s whatever the user\'s window zone says', () => {
  assert.equal(BANDS_TZ, 'Europe/London');
  const ny = withDefaults({ window: { tz: 'America/New_York' } });
  assert.equal(ny.window.tz, 'America/New_York');
  const when = [...HOUR_BANDS.map((b) => b.key), ...WEEKDAYS.map((d) => d.key)];
  for (const k of [IDEA_K, kClosingAt('2026-10-07T09:45:00Z'), kClosingAt('2026-10-08T23:00:00Z')]) {
    const london = rowAt(k).f, other = rowAt(k, { config: ny }).f;
    for (const n of when) assert.equal(other[n], london[n], `bar ${k}: ${n}`);
  }
  // 23:00 UTC Thursday is 00:00 Friday in London but still Thursday in New York.
  const late = rowAt(kClosingAt('2026-10-08T23:00:00Z'), { config: ny }).f;
  assert.equal(late.wd_fri, 1);
});
test('the long-tailed ratios are stored as logarithms', () => {
  const { analysis, f } = rowAt(IDEA_K);
  const rv = analysis.indicators.relVol[analysis.indicators.relVol.length - 1];
  assert.ok(rv > 0);
  assert.ok(Math.abs(f.log_rel_volume - Math.log(rv)) < 1e-12);
  const atrs = analysis.indicators.atr;
  assert.ok(Math.abs(f.log_atr_change_1h - Math.log(atrs[atrs.length - 1] / atrs[atrs.length - 5])) < 1e-12);
  // A zero-volume newest bar is floored, not −∞.
  const k = IDEA_K, closed = historyTo(BARS, k).map((b, i, a) => (i === a.length - 1 ? { ...b, v: 0 } : b));
  const an = analysisForFeatures({ closed, pair: 'BTCUSD', cfg, nowMs: at(k) });
  const z = featuresAt({ closed, analysis: an, nowMs: at(k), cfg });
  assert.ok(Number.isFinite(z.log_rel_volume) && z.log_rel_volume < -4, `${z.log_rel_volume}`);
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
  for (const { k, f } of SAMPLE) {
    const analysis = engineReadAt(k);
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
  const analysis = engineReadAt(IDEA_K);
  const full = engineScore(analysis, { windowLength: 300 });
  assert.ok(Math.abs(engineScore(analysis, { windowLength: 300, lastStretch: true }).confidence - full.confidence * 0.6) < 1e-12);
  assert.ok(Math.abs(engineScore(analysis, { windowLength: 120 }).confidence - full.confidence * 0.85) < 1e-12);
  assert.equal(engineScore(analysis, { windowLength: 120 }).net, full.net, 'the net does not depend on either');
  assert.deepEqual(engineScore({ state: 'insufficient-data' }, { windowLength: 10 }), { net: null, confidence: null });
});

test('the re-read for features carries no lean: no bias, stop, targets, verdict or wording', () => {
  for (const { k, analysis } of SAMPLE) {
    if (analysis.state === 'insufficient-data') continue;
    assert.deepEqual(Object.keys(analysis).sort(), ['atr', 'buckets', 'featuresOnly', 'htf', 'indicators', 'pair', 'price', 'regime', 'state'], `bar ${k}`);
    assert.equal(analysis.state, 'features-only');
    assert.equal(analysis.featuresOnly, true);
  }
  assert.deepEqual(rowAt(30).analysis, { state: 'insufficient-data', featuresOnly: true, pair: 'BTCUSD' });
  // The release-blackout moment the live desk sat out: the engine leaned, the re-read does not say how.
  const engine = engineReadAt(674), reread = rowAt(674).analysis;
  assert.ok(engine.bias !== undefined && engine.statement !== undefined, 'the full read would have named it');
  for (const key of ['bias', 'invalidation', 'targets', 'spreadVerdict', 'statement', 'reasons', 'whyNot', 'net', 'confidence']) {
    assert.equal(reread[key], undefined, key);
  }
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
  assert.deepEqual(conditionOf(f, { side: 'long' }), buy);
  assert.deepEqual(conditionOf(f, { side: 'short' }), sell);
});
test('conditionOf honours the agreed contract on every row: types, keys, and no volatility bucket', () => {
  const ONE = [-1, 0, 1];
  for (const { k, f } of SAMPLE) {
    for (const side of ['buy', 'sell']) {
      const c = conditionOf(f, { side });
      assert.ok(REGIMES.includes(c.regime), `bar ${k}`);
      assert.ok(['low', 'moderate', 'firm'].includes(c.confidenceLabel));
      assert.ok(ONE.includes(c.h1) && ONE.includes(c.h4), `bar ${k}: h1 ${c.h1}, h4 ${c.h4}`);
      assert.equal(typeof c.agree, 'boolean');
      assert.deepEqual(Object.keys(c.buckets), ['trend', 'momentum', 'structure', 'location', 'volume']);
      for (const v of Object.values(c.buckets)) assert.ok(v === null || ONE.includes(v));
      assert.ok(c.hourBand === null || ['08-10', '10-12', '12-14', '14-16'].includes(c.hourBand));
      assert.ok(c.weekday === null || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(c.weekday));
      assert.equal(c.side, side);
      assert.equal(c.agree, f.htf_agree === 1);
    }
  }
  assert.equal(conditionOf(rowAt(IDEA_K).f, { side: 'buy' }).confidenceLabel, engineReadAt(IDEA_K).confidenceLabel, 'the engine\'s own word');
});
test('conditionOf: an abstaining volume bucket is "no data", not "no lean"; outside the bands, null', () => {
  const f = { ...rowAt(IDEA_K).f, volume_abstain: 1, b_volume: 0, hour_14_16: 0, wd_wed: 0 };
  const c = conditionOf(f, { side: 1 });
  assert.equal(c.buckets.volume, null);
  assert.equal(c.hourBand, null);
  assert.equal(c.weekday, null);
  // A bias too short to measure reads flat, and the pair as not agreeing (the engine's own rule).
  const short = conditionOf({ ...f, htf_agree: null, h4_bias: null }, { side: 'sell' });
  assert.equal(short.agree, false);
  assert.equal(short.h4, 0);
  assert.equal(conditionOf({ ...f, confidence: 0.29 }, { side: 'buy' }).confidenceLabel, 'low');
  assert.equal(conditionOf({ ...f, confidence: 0.3 }, { side: 'buy' }).confidenceLabel, 'moderate');
  assert.equal(conditionOf({ ...f, confidence: 0.55 }, { side: 'buy' }).confidenceLabel, 'firm');
});
test('conditionOf refuses a row without a side, and a row the engine could not read', () => {
  const f = rowAt(IDEA_K).f;
  assert.throws(() => conditionOf(f), /side/);
  assert.throws(() => conditionOf(f, {}), /side/);
  assert.throws(() => conditionOf(f, { side: 0 }), /side/);
  assert.throws(() => conditionOf(rowAt(30).f, { side: 'buy' }), /no condition/);
});

console.log('\nthe version');
test('FEATURES_VERSION is an integer, and this file\'s content is pinned to it', () => {
  assert.ok(Number.isInteger(FEATURES_VERSION) && FEATURES_VERSION >= 1);
  // Every version of desk/features.mjs ever stored rows. Changing the module
  // fails here until someone decides: a definition changed (bump
  // FEATURES_VERSION and add its hash), or only words did (replace the hash
  // of the current version). Old entries stay, so the history reads.
  const PINNED = {
    // Re-pinned 17 Oct 2026 at integration: featuresAt's provenance check (a guard
    // that refuses mismatched inputs), `pair` on the features-only analysis, and
    // comments. No feature's value changed for any input it accepted before.
    1: '26befcf5170efe01ba3c8ff1b3a915824f7e7d4870f2ed6010369d3de54646c2',
  };
  const src = readFileSync(join(here, '..', 'desk', 'features.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(src).digest('hex');
  assert.ok(PINNED[FEATURES_VERSION], `FEATURES_VERSION ${FEATURES_VERSION} has no pinned hash`);
  assert.equal(hash, PINNED[FEATURES_VERSION],
    'desk/features.mjs changed: if any feature\'s meaning changed, bump FEATURES_VERSION and pin the new hash under it; if only comments did, re-pin this version');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
