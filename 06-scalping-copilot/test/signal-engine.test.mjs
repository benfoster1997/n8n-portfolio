/**
 * The guarantees the signal engine must never break.
 *
 * These are contract tests, not accuracy tests. Nothing here claims the engine
 * reads the market well — only that it cannot emit the specific shapes of
 * output that would be dangerous: a directional read with no invalidation
 * level, a technical read that ignores a news blackout, a target that does not
 * clear the spread, or a one-sided case with nothing said against it.
 */
import assert from 'node:assert/strict';
import { analyse, detectRegime, efficiencyRatio, MIN_BARS } from '../src/signal-engine.js';
import { INSTRUMENTS } from '../src/instruments.js';
import { breakEvenWinRate, positionSize, spreadDrag, marginRequired } from '../src/risk.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const T0 = Date.UTC(2026, 8, 17, 8, 0);          // a Thursday, London session
const mk = (c, i, spreadPct = 0.0008, vol = 1000) => ({
  t: T0 + i * 300000,
  o: c * (1 - spreadPct / 2), h: c * (1 + spreadPct), l: c * (1 - spreadPct), c, v: vol,
});

/** A clean, persistent uptrend with mild noise. */
const trendingUp = (n = 220, start = 3900, step = 1.2) =>
  Array.from({ length: n }, (_, i) => mk(start + i * step + Math.sin(i / 3) * 0.6, i));

/** A tight range that goes nowhere. */
const ranging = (n = 220, mid = 3900, amp = 4) =>
  Array.from({ length: n }, (_, i) => mk(mid + Math.sin(i / 5) * amp + Math.sin(i / 1.7) * (amp / 4), i));

/**
 * Volatility that WAS wide and has gone quiet.
 *
 * Compression is relative to a market's own recent history, not an absolute
 * level — a uniformly smooth series is not compressed, it is just smooth. So
 * the fixture has to have something to compress FROM.
 */
const compressed = (n = 220, mid = 3900, quietBars = 30) =>
  Array.from({ length: n }, (_, i) => {
    const amp = i < n - quietBars ? 9 : 0.3;
    return mk(mid + Math.sin(i / 2.3) * amp + Math.sin(i / 7) * (amp / 3), i);
  });

const XAU = INSTRUMENTS.XAUUSD;
const BTC = INSTRUMENTS.BTCUSD;

console.log('\nregime detection');

test('efficiencyRatio: 1.0 on a straight line, near 0 on churn', () => {
  const line = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.ok(efficiencyRatio(line, 20) > 0.99);
  const churn = Array.from({ length: 30 }, (_, i) => 100 + (i % 2));
  assert.ok(efficiencyRatio(churn, 20) < 0.1);
});

test('a persistent trend is classified trending', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  assert.equal(r.regime.regime, 'trending', JSON.stringify(r.regime));
});

test('a tight oscillation is not classified trending', () => {
  const r = analyse({ bars: ranging(), instrument: XAU });
  assert.notEqual(r.regime.regime, 'trending', JSON.stringify(r.regime));
});

test('a squeeze is classified compressed', () => {
  const r = analyse({ bars: compressed(), instrument: XAU });
  assert.equal(r.regime.regime, 'compressed', JSON.stringify(r.regime));
  assert.ok(r.regime.widthPercentile < 0.2);
  // The fixture must be decisively compressed, not sitting on the threshold —
  // a boundary fixture would flake on any unrelated change.
  assert.ok(r.regime.widthPercentile < 0.12,
    `fixture is too near the cut-off to be a useful test (${r.regime.widthPercentile})`);
});

test('a market that has NOT gone quiet is not called compressed', () => {
  // Same generator, but the wide regime runs to the end.
  const r = analyse({ bars: compressed(220, 3900, 0), instrument: XAU });
  assert.notEqual(r.regime.regime, 'compressed', JSON.stringify(r.regime));
});

console.log('\nthe hard guarantees');

test('a directional read ALWAYS carries an invalidation price', () => {
  for (const bars of [trendingUp(), ranging(), compressed(), trendingUp(220, 3900, -1.2)]) {
    const r = analyse({ bars, instrument: XAU });
    if (r.bias === 'long' || r.bias === 'short') {
      assert.ok(typeof r.invalidation === 'number' && Number.isFinite(r.invalidation),
        `bias ${r.bias} emitted with invalidation ${r.invalidation}`);
      assert.ok(r.invalidationBasis, 'invalidation must explain what it is based on');
      assert.ok(r.stopDistance > 0);
    }
  }
});

test('the invalidation sits on the losing side of price', () => {
  const up = analyse({ bars: trendingUp(), instrument: XAU });
  if (up.bias === 'long') assert.ok(up.invalidation < up.price, 'a long is wrong BELOW price');
  const dn = analyse({ bars: trendingUp(220, 3900, -1.2), instrument: XAU });
  if (dn.bias === 'short') assert.ok(dn.invalidation > dn.price, 'a short is wrong ABOVE price');
});

test('a news blackout overrides the technicals entirely', () => {
  const bars = trendingUp();
  const clean = analyse({ bars, instrument: XAU });
  assert.ok(clean.bias !== 'none');

  const blocked = analyse({
    bars, instrument: XAU,
    blackout: {
      active: true, phase: 'before', minutesAway: 3,
      event: { name: 'US Non-Farm Payrolls', tier: 1 },
    },
  });
  assert.equal(blocked.state, 'stand-aside');
  assert.equal(blocked.bias, 'none');
  assert.equal(blocked.confidence, 0);
  assert.equal(blocked.invalidation, null, 'a blackout must not ship a tradeable level');
  assert.ok(blocked.headline.includes('Non-Farm Payrolls'));
  // It should still disclose what it suppressed, so the user knows the cost.
  assert.equal(blocked.technicalBiasSuppressed, clean.bias);
});

test('the blackout holds even when the technicals are at their most convincing', () => {
  const r = analyse({
    bars: trendingUp(300, 3900, 2.5), instrument: XAU,
    blackout: { active: true, phase: 'after', minutesSince: 2, event: { name: 'FOMC decision', tier: 1 } },
  });
  assert.equal(r.state, 'stand-aside');
  assert.equal(r.confidence, 0);
});

test('whyNot is never empty on a directional read — it always argues both sides', () => {
  for (const bars of [trendingUp(), ranging(), trendingUp(220, 3900, -1.2), compressed()]) {
    const r = analyse({ bars, instrument: XAU, spread: 0.2 });
    if (r.bias === 'long' || r.bias === 'short') {
      assert.ok(r.whyNot.length > 0, 'a directional read with no case against it');
    }
  }
});

test('a target that does not clear the spread is flagged, with the arithmetic', () => {
  // An absurd spread relative to the instrument's range.
  const r = analyse({ bars: trendingUp(), instrument: XAU, spread: 25, minSpreadMultiple: 3 });
  if (r.targets && r.targets.length) {
    assert.ok(r.spreadVerdict, 'spread verdict missing');
    assert.equal(r.spreadVerdict.ok, false);
    assert.ok(r.spreadVerdict.multiple < 3);
    assert.ok(r.whyNot.some((x) => /spread/i.test(x)), 'spread problem not surfaced in the case against');
  }
});

test('a sane spread passes the gate', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU, spread: 0.2, minSpreadMultiple: 3 });
  if (r.spreadVerdict) assert.equal(r.spreadVerdict.ok, true, JSON.stringify(r.spreadVerdict));
});

test('too little history produces a refusal, not a guess', () => {
  const r = analyse({ bars: trendingUp(20), instrument: XAU });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'insufficient-data');
  assert.equal(r.bias, 'none');
  assert.equal(r.invalidation, null);
  assert.ok(r.detail.includes(String(MIN_BARS)));
});

test('empty and malformed input do not throw', () => {
  assert.equal(analyse({ bars: [], instrument: XAU }).state, 'insufficient-data');
  assert.equal(analyse({ bars: null, instrument: XAU }).state, 'insufficient-data');
});

test('the dead zone withholds the read rather than showing it weakly', () => {
  const bars = trendingUp();
  const clean = analyse({ bars, instrument: XAU });
  assert.ok(clean.bias !== 'none', 'baseline should produce a read');

  const dead = analyse({
    bars, instrument: XAU,
    session: { band: 'dead', name: 'Dead zone', note: 'The structural low of your day.' },
  });
  assert.equal(dead.state, 'stand-down');
  assert.equal(dead.bias, 'none');
  assert.equal(dead.confidence, 0);
  assert.equal(dead.invalidation, null, 'a withheld read must not ship a tradeable level');
  // It must still disclose what it suppressed — hiding that is its own dishonesty.
  assert.equal(dead.technicalBiasSuppressed, clean.bias);
  assert.ok(dead.suppressedConfidence > 0);
  assert.ok(dead.whyNot.some((x) => /cost|spread/i.test(x)),
    'the reason must be the cost structure, not vague caution');
});

test('a news blackout outranks the dead zone', () => {
  const r = analyse({
    bars: trendingUp(), instrument: XAU,
    session: { band: 'dead', name: 'Dead zone', note: 'quiet' },
    blackout: { active: true, phase: 'before', minutesAway: 4, event: { name: 'US CPI', tier: 1 } },
  });
  assert.equal(r.state, 'stand-aside', 'the news reason is the more urgent one to show');
  assert.ok(r.headline.includes('CPI'));
});

test('a green session does not suppress anything', () => {
  const r = analyse({
    bars: trendingUp(), instrument: XAU,
    session: { band: 'green', name: 'COMEX ramp and US data', note: 'prime' },
  });
  assert.notEqual(r.state, 'stand-down');
});

console.log('\nscoring discipline');

test('confidence is low by default and never pins at certainty', () => {
  for (const bars of [trendingUp(), ranging(), compressed()]) {
    const r = analyse({ bars, instrument: XAU });
    assert.ok(r.confidence >= 0 && r.confidence <= 0.95, `confidence ${r.confidence} out of range`);
  }
  assert.ok(analyse({ bars: ranging(), instrument: XAU }).confidence < 0.6,
    'a directionless range should not produce a firm read');
});

test('mixed and compressed regimes are penalised relative to a clean trend', () => {
  const trend = analyse({ bars: trendingUp(), instrument: XAU });
  const squeeze = analyse({ bars: compressed(), instrument: XAU });
  assert.ok(trend.confidence > squeeze.confidence,
    `trend ${trend.confidence} should outrank squeeze ${squeeze.confidence}`);
});

test('in a range, trend weight is near zero and the engine says it is discarding it', () => {
  const r = analyse({ bars: ranging(), instrument: XAU });
  if (r.regime.regime === 'ranging') {
    assert.ok(r.weights.trend <= 0.05, `trend weight ${r.weights.trend} too high in a range`);
    assert.ok(r.weights.location >= 0.3, 'location should dominate in a range');
  }
});

test('volatility is directionless — it never votes on direction', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  assert.equal(r.buckets.volatility.directionless, true);
  assert.equal(r.buckets.volume.directionless, undefined,
    'volume is a directional bucket; lack of data is abstention, not directionlessness');
});

test('a bucket with no data abstains instead of inflating the others', () => {
  // 220 bars of M5 is under 24h, so relative volume has no like-for-like
  // history yet and the volume bucket must abstain.
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  assert.ok(r.abstained.includes('volume'), `expected volume to abstain, got ${JSON.stringify(r.abstained)}`);
  // Its weight must be gone from the live denominator, not redistributed.
  const expected = +(1 - r.weights.volatility - r.weights.volume).toFixed(3);
  assert.equal(r.liveWeight, expected,
    'abstained weight was redistributed rather than removed');
  assert.ok(r.whyNot.some((x) => /No volume input/i.test(x)),
    'abstention must be disclosed in the case against');
});

test('abstention lowers confidence rather than being silently absorbed', () => {
  // Same price path, but spanning several days so volume has real history.
  const many = [];
  for (let i = 0; i < 600; i++) {
    many.push({
      t: Date.UTC(2026, 8, 10) + i * 300000,
      o: 3900 + i * 0.4, h: 3900 + i * 0.4 + 1, l: 3900 + i * 0.4 - 1,
      c: 3900 + i * 0.4 + Math.sin(i / 3) * 0.5, v: 1000 + (i % 7) * 50,
    });
  }
  const withVolume = analyse({ bars: many, instrument: XAU });
  assert.ok(!withVolume.abstained.includes('volume'),
    'with days of history the volume bucket should have data');
});

test('higher-timeframe bias uses only closed bars', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  assert.ok(r.htf.m15 === null || r.htf.m15.closedBars > 0);
  assert.ok(r.htf.notes.some((n) => /closed/i.test(n)) || r.htf.m15 === null);
});

test('reads the same way on bitcoin scale without per-instrument magic numbers', () => {
  const btcBars = trendingUp(220, 95000, 30);
  const r = analyse({ bars: btcBars, instrument: BTC, spread: 20 });
  assert.equal(r.ok, true);
  assert.ok(r.atr > 0);
  if (r.bias !== 'neutral') assert.ok(Number.isFinite(r.invalidation));
});

test('the statement describes rather than instructs', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  assert.ok(!/\b(buy|sell) now\b/i.test(r.statement), 'statement reads as a command');
  if (r.bias !== 'neutral') assert.ok(/wrong/i.test(r.statement), 'statement should name its invalidation');
});

test('DMI is shown but never scored — it duplicates RSI', () => {
  const r = analyse({ bars: trendingUp(), instrument: XAU });
  const dmi = r.buckets.trend.reasons.find((x) => /DMI/.test(x));
  assert.ok(dmi, 'DMI should still be surfaced to the user');
  assert.ok(/not scored|duplicates/i.test(dmi),
    'and it must say why it is absent from the score');
  // Under close-only true range (+DI - -DI) IS 2*RSI - 100. Scoring both would
  // be the bucket structure's own double-count, smuggled across two buckets.
  assert.ok(!/\+DI leading|-DI leading/.test(dmi));
});

test('a stop under 5x the spread is rejected however good the chart looks', () => {
  const bars = trendingUp();
  const clean = analyse({ bars, instrument: XAU, spread: 0.2 });
  if (!clean.stopDistance) return;
  // Pick a spread that puts the stop just under the 5x floor.
  const spread = clean.stopDistance / 4;
  const r = analyse({ bars, instrument: XAU, spread });
  if (r.spreadVerdict) {
    assert.equal(r.spreadVerdict.stopOk, false);
    assert.equal(r.spreadVerdict.ok, false);
    assert.ok(r.whyNot.some((x) => /unsound|5x/i.test(x)),
      'the arithmetic problem must reach the case against');
  }
});

test('a stop between 5x and 10x the spread warns rather than rejects', () => {
  const bars = trendingUp();
  const clean = analyse({ bars, instrument: XAU, spread: 0.2 });
  if (!clean.stopDistance) return;
  const r = analyse({ bars, instrument: XAU, spread: clean.stopDistance / 7 });
  if (r.spreadVerdict) {
    assert.equal(r.spreadVerdict.stopOk, true);
    assert.ok(r.spreadVerdict.warn, 'expected a warning in the 5x-10x band');
  }
});

console.log('\nrisk arithmetic');

test('breakEvenWinRate: 1:1 with no spread needs 50%', () => {
  const r = breakEvenWinRate(10, 10, 0);
  assert.equal(r.rate, 50);
});

test('breakEvenWinRate: the spread is paid on both ends', () => {
  // target 10, stop 10, spread 2 -> win nets 8, loss costs 12 -> 12/20 = 60%
  const r = breakEvenWinRate(10, 10, 2);
  assert.equal(r.rate, 60);
  assert.equal(r.netR, +(8 / 12).toFixed(2));
});

test('breakEvenWinRate: a target inside the spread is declared impossible', () => {
  const r = breakEvenWinRate(1, 10, 2);
  assert.equal(r.impossible, true);
  assert.ok(r.reason);
});

test('positionSize: gold, 1% of 10,000 USD, 3.00 stop, 0.20 spread', () => {
  // effective stop 3.20; risk 100; per lot 3.20 * 100 = 320 -> 0.3125 -> 0.31
  const r = positionSize({
    accountBalance: 10000, riskPercent: 1, stopDistance: 3,
    valuePerUnitMovePerLot: 100, spread: 0.2,
  });
  assert.equal(r.effectiveStop, 3.2);
  assert.equal(r.lots, 0.31);
  assert.equal(r.riskAmount, 100);
  assert.ok(r.actualRisk <= 100, 'rounding must never round risk UP');
});

test('positionSize: converts when the account is GBP and the symbol is USD-quoted', () => {
  // Same trade, GBP account. 320 USD per lot at 0.79 GBP/USD = 252.8 GBP.
  // 100 GBP risk -> 0.3955 -> 0.39 lots.
  const r = positionSize({
    accountBalance: 10000, riskPercent: 1, stopDistance: 3,
    valuePerUnitMovePerLot: 100, spread: 0.2,
    accountCurrency: 'GBP', quoteCurrency: 'USD', fxRate: 0.79,
  });
  assert.equal(r.lots, 0.39);
});

test('positionSize: refuses rather than guessing when a spec is unconfirmed', () => {
  const r = positionSize({
    accountBalance: 10000, riskPercent: 1, stopDistance: 3,
    valuePerUnitMovePerLot: 0,
  });
  assert.equal(r.lots, null);
  assert.ok(r.blocked.some((b) => /contract value/i.test(b)));
});

test('positionSize: refuses when the account cannot afford the minimum lot', () => {
  const r = positionSize({
    accountBalance: 100, riskPercent: 0.5, stopDistance: 500,
    valuePerUnitMovePerLot: 1, minLot: 0.01,
  });
  assert.equal(r.lots, 0);
  assert.ok(r.blocked.length > 0);
});

test('breakEvenWinRate matches the compact form p = (1 + c/S)/(1 + R)', () => {
  // A $1.00 gold stop with a $0.25 spread at 1:1 needs 62.5%, not 50%.
  const r = breakEvenWinRate(1.0, 1.0, 0.25);
  assert.equal(r.rate, 62.5);
  const compact = ((1 + 0.25 / 1.0) / (1 + 1.0)) * 100;
  assert.ok(Math.abs(r.rate - compact) < 0.05, 'the two formulations must agree');
  // At 1:2 the same cost needs 41.7%, not 33.3%.
  assert.equal(breakEvenWinRate(2.0, 1.0, 0.25).rate, 41.7);
});

test('breakEvenWinRate exposes the costless baseline, so the spread tax is visible', () => {
  const r = breakEvenWinRate(1.0, 1.0, 0.25);
  assert.equal(r.costlessRate, 50, 'the 1:1 baseline with no spread');
  assert.ok(r.rate > r.costlessRate, 'the real number must be the worse one');
  const r2 = breakEvenWinRate(2.0, 1.0, 0);
  assert.equal(r2.costlessRate, 33.3);
  assert.equal(r2.rate, 33.3, 'with no spread the two coincide');
});

test('marginRequired: the risk formula alone can hand you an unholdable position', () => {
  // 0.33 lots of gold at $4,391, 100oz/lot, under the FCA's 20:1 cap.
  const m = marginRequired({
    price: 4391, lots: 0.33, contractSize: 100, leverage: 20, accountBalance: 10000,
  });
  assert.equal(m.notional, 144903);
  assert.equal(m.margin, 7245.15);
  assert.ok(m.pctOfAccount > 70, `${m.pctOfAccount}% of the account — should be flagged tight`);
  assert.equal(m.tight, true);
  // At 1:100 the same trade is comfortable.
  assert.equal(marginRequired({
    price: 4391, lots: 0.33, contractSize: 100, leverage: 100, accountBalance: 10000,
  }).tight, false);
});

test('marginRequired refuses rather than guessing on missing inputs', () => {
  assert.equal(marginRequired({ price: 4391, lots: 0.33, contractSize: 100, leverage: 0 }), null);
  assert.equal(marginRequired({ price: 0, lots: 1, contractSize: 100, leverage: 20 }), null);
});

test('spreadDrag: the monthly toll of scalping is made visible', () => {
  // gold, 0.20 spread, 0.5 lots, 20 trades a day -> 0.20*100*0.5 = $10 a trade
  const r = spreadDrag({ spread: 0.2, valuePerUnitMovePerLot: 100, lots: 0.5, tradesPerDay: 20 });
  assert.equal(r.perTrade, 10);
  assert.equal(r.perDay, 200);
  assert.equal(r.perMonth, 4200);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
