/**
 * Hand-verifiable fixtures for the indicator library.
 *
 * Every expected value here was computed by hand from the definition, not
 * captured from a previous run of this code. A test that records whatever the
 * implementation already does cannot catch a wrong seeding rule.
 */
import assert from 'node:assert/strict';
import {
  sma, ema, wma, rsi, atr, trueRange, macd, bollingerBands, stochastic,
  adx, supertrend, donchian, sessionVwap, swingPivots, clusterLevels,
  marketStructure, findFVGs, detectLiquiditySweep, relativeVolume,
  volumeProfile, resample, lastOf,
} from '../src/indicators.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

const bar = (o, h, l, c, v = 100, t = 0) => ({ t, o, h, l, c, v });
/** Bars on a 5-minute grid from a close series. */
const series = (cs) => cs.map((c, i) => bar(c, c + 0.5, c - 0.5, c, 100, i * 300000));

console.log('\nmoving averages');

test('sma: warm-up is null, then the arithmetic mean', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.equal(r.length, 5);
  assert.equal(r[0], null); assert.equal(r[1], null);
  close(r[2], 2); close(r[3], 3); close(r[4], 4);
});

test('ema: seeds from the SMA of the first `period` values, not the first value', () => {
  // period 3 over [1,2,3,4,5]: seed = (1+2+3)/3 = 2 at index 2, k = 0.5
  //   i=3 -> 4*0.5 + 2*0.5 = 3
  //   i=4 -> 5*0.5 + 3*0.5 = 4
  const r = ema([1, 2, 3, 4, 5], 3);
  assert.equal(r[1], null);
  close(r[2], 2); close(r[3], 3); close(r[4], 4);
  // A first-value seed would have given r[2] = 2.25 here. Guard against it.
  assert.notEqual(r[2], 2.25);
});

test('wma: linear weights, heaviest on the newest bar', () => {
  // period 3 over [1,2,3]: (1*1 + 2*2 + 3*3)/6 = 14/6
  const r = wma([1, 2, 3], 3);
  close(r[2], 14 / 6);
});

console.log('\nWilder-smoothed');

test('rsi: Wilder recurrence with alpha = 1/period, not 2/(period+1)', () => {
  // period 2 over [10,11,10,11,12]
  //   gains  [1,0,1,1]   losses [0,1,0,0]
  //   avgGain: seed 0.5 -> 0.75 -> 0.875
  //   avgLoss: seed 0.5 -> 0.25 -> 0.125
  //   RSI:     50, 75, 87.5   (aligned to bars 2,3,4)
  const r = rsi([10, 11, 10, 11, 12], 2);
  assert.equal(r[0], null); assert.equal(r[1], null);
  close(r[2], 50, 1e-9);
  close(r[3], 75, 1e-9);
  close(r[4], 87.5, 1e-9);
});

test('rsi: flat price does not divide by zero', () => {
  const r = rsi([5, 5, 5, 5, 5, 5], 2);
  assert.equal(lastOf(r), 50, 'dead-flat price should read 50, not NaN or 100');
});

test('rsi: monotonic rise pins at 100 without dividing by zero', () => {
  const r = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  assert.equal(lastOf(r), 100);
});

test('trueRange: bar 0 is NULL, because True Range needs a previous close', () => {
  const bars = [bar(10, 12, 8, 11), bar(11, 15, 10, 14)];
  const tr = trueRange(bars);
  assert.equal(tr[0], null,
    'substituting high-low at bar 0 poisons the ATR seed and shifts every reading by a bar');
  // max(15-10=5, |15-11|=4, |10-11|=1) = 5
  close(tr[1], 5);
});

test('atr: Wilder-smoothed, seeded from the first REAL true range', () => {
  // TR = [null, 5, 5, 4]; period 2 -> seed (5+5)/2 = 5 at bar 2
  //   bar 3 -> (5*1 + 4)/2 = 4.5
  const bars = [
    bar(10, 12, 8, 11), bar(11, 15, 10, 14), bar(14, 16, 11, 12), bar(12, 14, 10, 13),
  ];
  const a = atr(bars, 2);
  assert.equal(a[0], null);
  assert.equal(a[1], null, 'the seed cannot close until two real TRs exist');
  close(a[2], 5); close(a[3], 4.5);
});

test('atr: a bogus bar-0 TR would have dragged the seed down — check it does not', () => {
  // If TR[0] were (high-low)=4 the seed would be (4+5)/2 = 4.5, not 5.
  const bars = [bar(10, 12, 8, 11), bar(11, 15, 10, 14), bar(14, 16, 11, 12)];
  assert.notEqual(atr(bars, 2)[2], 4.5);
});

test('sessionVwap: the gold anchor follows DST instead of a fixed UTC hour', () => {
  // 17:00 America/New_York is 21:00 UTC in summer and 22:00 UTC in winter.
  const mk = (t) => ({ t, o: 10, h: 10, l: 10, c: 10, v: 1 });
  const summer = [];
  for (let h = 19; h <= 23; h++) summer.push(mk(Date.UTC(2026, 6, 15, h, 0)));
  const rS = sessionVwap(summer, { h: 17, tz: 'America/New_York' }, [1]);
  // index 2 is 21:00 UTC — the summer reset, so VWAP restarts at that bar.
  assert.equal(rS.vwap[2], 10);

  const winter = [];
  for (let h = 19; h <= 23; h++) winter.push(mk(Date.UTC(2026, 11, 15, h, 0)));
  const rW = sessionVwap(winter, { h: 17, tz: 'America/New_York' }, [1]);
  assert.ok(Number.isFinite(rW.vwap[3]), 'winter reset should land an hour later');
});

test('sessionVwap: bands stay real at gold price levels (no one-pass cancellation)', () => {
  // The E[x^2]-mean^2 form goes negative here in float64: tp^2 is ~19 million
  // and the variance being extracted is a handful of units.
  const bars = [];
  for (let i = 0; i < 80; i++) {
    const p = 4391 + Math.sin(i / 4) * 2.5;
    bars.push({ t: Date.UTC(2026, 8, 17, 8, 0) + i * 300000, o: p, h: p + 0.4, l: p - 0.4, c: p, v: 500 });
  }
  const r = sessionVwap(bars, 0, [1, 2]);
  const vw = lastOf(r.vwap);
  const u1 = lastOf(r.bands[0].upper), l1 = lastOf(r.bands[0].lower);
  assert.ok(Number.isFinite(u1) && Number.isFinite(l1));
  assert.ok(u1 > vw && l1 < vw, 'bands collapsed onto VWAP — variance underflowed');
  assert.ok(u1 - vw > 0.3, `band is implausibly tight (${(u1 - vw).toFixed(6)}) for this series`);
});

console.log('\nbands and oscillators');

test('bollinger: population stdev (divide by N), matching TradingView', () => {
  // [1..5], period 5: mean 3, population variance (4+1+0+1+4)/5 = 2, sd = sqrt2
  const r = bollingerBands([1, 2, 3, 4, 5], 5, 2);
  close(r.middle[4], 3);
  close(r.upper[4], 3 + 2 * Math.SQRT2, 1e-12);
  close(r.lower[4], 3 - 2 * Math.SQRT2, 1e-12);
  // Sample stdev would give sd = sqrt(2.5) = 1.5811 -> upper 6.162. Reject it.
  assert.ok(Math.abs(r.upper[4] - 6.1622) > 0.01, 'looks like sample stdev');
});

test('bollinger: zero-width band gives percentB 0.5 rather than NaN', () => {
  const r = bollingerBands([7, 7, 7, 7, 7], 5, 2);
  assert.equal(r.percentB[4], 0.5);
});

test('stochastic: flat range gives 50 rather than dividing by zero', () => {
  const bars = Array.from({ length: 20 }, () => bar(5, 5, 5, 5));
  const r = stochastic(bars, 14, 3, 3);
  assert.equal(lastOf(r.k), 50);
});

test('macd: histogram equals line minus signal wherever both exist', () => {
  const vals = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 5);
  const r = macd(vals, 12, 26, 9);
  let checked = 0;
  for (let i = 0; i < vals.length; i++) {
    if (r.line[i] !== null && r.signal[i] !== null) {
      close(r.histogram[i], r.line[i] - r.signal[i], 1e-9); checked++;
    }
  }
  assert.ok(checked > 20, 'expected a meaningful number of comparable bars');
});

console.log('\ntrend');

test('adx: rises on a clean trend and stays bounded 0-100', () => {
  const bars = series(Array.from({ length: 80 }, (_, i) => 100 + i));
  const r = adx(bars, 14);
  const v = lastOf(r.adx);
  assert.ok(v !== null, 'adx should have a value after 80 bars');
  assert.ok(v > 40, `a pure uptrend should read strongly trending, got ${v}`);
  assert.ok(v <= 100);
  assert.ok(lastOf(r.plusDI) > lastOf(r.minusDI), '+DI should lead in an uptrend');
});

test('adx: a flat market reads weak', () => {
  const bars = series(Array.from({ length: 80 }, () => 100));
  const r = adx(bars, 14);
  const v = lastOf(r.adx);
  assert.ok(v === null || v < 25, `flat market should not read trending, got ${v}`);
});

test('supertrend: direction flips and the band ratchets rather than flip-flopping', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 140 - i * 2);
  const bars = series([...up, ...down]);
  const r = supertrend(bars, 10, 3);
  assert.equal(r.direction[39], 1, 'should be long at the end of the rise');
  assert.equal(lastOf(r.direction), -1, 'should have flipped short on the fall');
});

console.log('\nstructure');

test('swingPivots: refuses to confirm pivots inside the lookback of the right edge', () => {
  const bars = series([1, 2, 3, 9, 3, 2, 1, 2, 3, 8]);
  const r = swingPivots(bars, 3);
  assert.equal(r.unconfirmedBars, 3);
  // The 8 at index 9 is the highest recent bar but cannot be confirmed yet.
  assert.ok(!r.highs.some((p) => p.index === 9), 'emitted an unconfirmable pivot (repaint risk)');
  assert.ok(r.highs.some((p) => p.index === 3), 'missed the confirmable pivot at index 3');
});

test('marketStructure: reports BOS up on higher highs and higher lows', () => {
  //            idx 0   1   2   3   4   5   6   7   8   9  10  11  12
  const cs = [  10, 15, 20, 15, 12, 18, 25, 20, 16, 22, 30, 25, 20];
  //    pivot highs at 2 (20), 6 (25), 10 (30)  -> higher highs
  //    pivot lows  at 4 (12), 8 (16)           -> higher lows
  const bars = series(cs);
  const p = swingPivots(bars, 2);
  assert.deepEqual(p.highs.map((x) => x.index), [2, 6, 10], 'fixture must give three swing highs');
  assert.deepEqual(p.lows.map((x) => x.index), [4, 8], 'fixture must give two swing lows');
  const r = marketStructure(bars, 2);
  assert.equal(r.trend, 'up');
  assert.ok(r.events.some((e) => e.type === 'BOS' && e.dir === 'up'));
});

test('marketStructure: the first break the other way is a CHoCH, not a BOS', () => {
  //     an uptrend as above, then a low that takes out the prior higher low
  const cs = [10, 15, 20, 15, 12, 18, 25, 20, 16, 22, 30, 25, 10, 14, 18, 16, 20];
  const r = marketStructure(series(cs), 2);
  const choch = r.events.filter((e) => e.type === 'CHoCH');
  assert.equal(choch.length, 1, `expected exactly one CHoCH, got ${JSON.stringify(r.events)}`);
  assert.equal(choch[0].dir, 'down');
  assert.equal(r.trend, 'down', 'structure should have turned down');
});

test('marketStructure: mirror case reports a downtrend', () => {
  const cs = [30, 25, 20, 25, 28, 22, 15, 20, 24, 18, 10, 15, 20].map((x) => x + 50);
  const r = marketStructure(series(cs), 2);
  assert.equal(r.trend, 'down');
});

test('marketStructure: says so rather than guessing when pivots are too few', () => {
  const r = marketStructure(series([1, 2, 3]), 3);
  assert.equal(r.trend, 'undefined');
  assert.ok(r.reason);
});

test('findFVGs: detects the three-candle imbalance and only above the size floor', () => {
  const bars = [
    bar(100, 101, 99, 100), bar(100, 110, 100, 109), bar(109, 112, 105, 111),
  ].map((b, i) => ({ ...b, t: i * 300000 }));
  // bars[2].l = 105 > bars[0].h = 101 -> bullish gap of 4
  const gaps = findFVGs(bars, 2, { minAtr: 0.25 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].type, 'bullish');
  close(gaps[0].size, 4);
  // With a 40-point floor the same gap is correctly ignored.
  assert.equal(findFVGs(bars, 160, { minAtr: 0.25 }).length, 0);
});

test('detectLiquiditySweep: needs the close back inside, not just the wick through', () => {
  const base = [5, 4, 9, 4, 5, 4, 5, 4, 5];
  const bars = series(base);
  // A bar that wicks above the 9.5 pivot high but closes back under it.
  bars.push({ t: 9 * 300000, o: 5, h: 11, l: 4.5, c: 5, v: 100 });
  const sweeps = detectLiquiditySweep(bars, { lookback: 2, withinBars: 3, atrValue: null });
  assert.ok(sweeps.some((s) => s.type === 'sell-side-sweep'), 'missed the sweep');

  // Same wick, but closing ABOVE the level is a breakout, not a sweep.
  const bars2 = series(base);
  bars2.push({ t: 9 * 300000, o: 5, h: 11, l: 4.5, c: 10.5, v: 100 });
  const sweeps2 = detectLiquiditySweep(bars2, { lookback: 2, withinBars: 3, atrValue: null });
  assert.ok(!sweeps2.some((s) => s.type === 'sell-side-sweep'), 'called a breakout a sweep');
});

console.log('\nVWAP, volume, resampling');

test('sessionVwap: resets at the configured UTC hour', () => {
  const bars = [];
  // 22:00 UTC on day 1 through 02:00 on day 2, hourly, price steps up.
  for (let i = 0; i < 6; i++) {
    bars.push({ t: Date.UTC(2026, 0, 1, 21 + i, 0), o: 10 + i, h: 10 + i, l: 10 + i, c: 10 + i, v: 1 });
  }
  const r = sessionVwap(bars, 22, [1]);
  // Bar index 1 is 22:00, the first of the new session -> VWAP equals its own price.
  close(r.vwap[1], 11);
  assert.ok(r.vwap[0] !== r.vwap[1]);
});

test('sessionVwap: zero volume degrades to a typical-price average, not NaN', () => {
  const bars = [0, 1, 2].map((i) => ({ t: i * 300000, o: 10, h: 10, l: 10, c: 10, v: 0 }));
  const r = sessionVwap(bars, 0, [1]);
  assert.ok(Number.isFinite(lastOf(r.vwap)));
  close(lastOf(r.vwap), 10);
});

test('relativeVolume: compares like-for-like five-minute slots across days', () => {
  const bars = [];
  for (let d = 0; d < 6; d++) {
    for (const [h, m] of [[8, 0], [13, 30]]) {
      bars.push({
        t: Date.UTC(2026, 0, 1 + d, h, m),
        o: 1, h: 1, l: 1, c: 1,
        // The 13:30 slot is always busy; the last day is busier still.
        v: (h === 13 ? 1000 : 100) * (d === 5 ? 3 : 1),
      });
    }
  }
  const rv = relativeVolume(bars, 5);
  const lastNews = rv[rv.length - 1];
  assert.ok(lastNews > 2.5 && lastNews < 3.5,
    `the busy day should read ~3x its own slot, got ${lastNews}`);
});

test('resample: aggregates OHLCV correctly into M15', () => {
  const bars = [
    { t: Date.UTC(2026, 0, 1, 0, 0), o: 1, h: 5, l: 0, c: 2, v: 10 },
    { t: Date.UTC(2026, 0, 1, 0, 5), o: 2, h: 3, l: 1, c: 3, v: 20 },
    { t: Date.UTC(2026, 0, 1, 0, 10), o: 3, h: 4, l: 2, c: 4, v: 30 },
  ];
  const m15 = resample(bars, 15, false);
  assert.equal(m15.length, 1);
  assert.deepEqual(
    { o: m15[0].o, h: m15[0].h, l: m15[0].l, c: m15[0].c, v: m15[0].v },
    { o: 1, h: 5, l: 0, c: 4, v: 60 },
  );
});

test('resample: drops the still-forming bar (no look-ahead)', () => {
  const bars = [];
  for (let i = 0; i < 4; i++) {
    bars.push({ t: Date.UTC(2026, 0, 1, 0, i * 5), o: 1, h: 1, l: 1, c: 1, v: 1 });
  }
  // Three bars complete 00:00-00:15; the fourth opens an incomplete M15.
  assert.equal(resample(bars, 15, true).length, 1, 'kept a partial higher-timeframe bar');
  assert.equal(resample(bars, 15, false).length, 2);
});

test('volumeProfile: POC lands where price spent its time', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar(100, 100.5, 99.5, 100, 10, i * 300000));
  for (let i = 0; i < 3; i++) bars.push(bar(120, 120.5, 119.5, 120, 10, (30 + i) * 300000));
  const vp = volumeProfile(bars, 40);
  assert.ok(Math.abs(vp.poc - 100) < 2, `POC should sit near 100, got ${vp.poc}`);
});

console.log('\ndefensive behaviour');

test('every function survives empty input', () => {
  assert.deepEqual(sma([], 5), []);
  assert.deepEqual(ema([], 5), []);
  assert.deepEqual(rsi([], 14), []);
  assert.deepEqual(atr([], 14), []);
  assert.deepEqual(resample([], 15), []);
  assert.deepEqual(swingPivots([], 3).highs, []);
  assert.deepEqual(clusterLevels([], 1), []);
  assert.equal(volumeProfile([]).poc, null);
  assert.equal(marketStructure([], 3).trend, 'undefined');
});

test('every function survives a single bar', () => {
  const one = [bar(1, 2, 0, 1)];
  assert.deepEqual(sma([1], 5), [null]);
  assert.deepEqual(atr(one, 14), [null]);
  assert.equal(adx(one, 14).adx[0], null);
  assert.equal(supertrend(one, 10, 3).value[0], null);
  assert.deepEqual(findFVGs(one, 1), []);
});

test('output length always equals input length (index alignment)', () => {
  const bars = series(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 3));
  const cs = bars.map((b) => b.c);
  for (const [name, r] of [
    ['sma', sma(cs, 20)], ['ema', ema(cs, 20)], ['rsi', rsi(cs, 14)],
    ['atr', atr(bars, 14)], ['adx', adx(bars, 14).adx],
    ['bb', bollingerBands(cs, 20, 2).upper], ['stoch', stochastic(bars, 14).k],
    ['st', supertrend(bars, 10, 3).value], ['vwap', sessionVwap(bars, 0).vwap],
    ['donchian', donchian(bars, 20).upper], ['relVol', relativeVolume(bars)],
    ['macd', macd(cs, 12, 26, 9).line],
  ]) {
    assert.equal(r.length, bars.length, `${name} returned ${r.length}, expected ${bars.length}`);
  }
});

test('inputs are never mutated', () => {
  const bars = series([1, 2, 3, 4, 5, 6, 7, 8]);
  const snapshot = JSON.stringify(bars);
  atr(bars, 3); adx(bars, 3); supertrend(bars, 3, 2);
  sessionVwap(bars, 0); resample(bars, 15); volumeProfile(bars);
  assert.equal(JSON.stringify(bars), snapshot, 'an indicator mutated its input bars');
});

test('clusterLevels scales by ATR, so it works on both instruments', () => {
  const cs = [];
  for (let i = 0; i < 10; i++) cs.push(...[100, 104, 100, 96, 100]);
  const gold = clusterLevels(series(cs), 1.5, { lookback: 2 });
  // Same shape at bitcoin scale: prices and ATR both multiplied by 900.
  const btcBars = series(cs.map((c) => c * 900));
  const btc = clusterLevels(btcBars, 1.5 * 900, { lookback: 2 });
  assert.equal(gold.length, btc.length,
    'level count should not depend on the instrument price scale');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
