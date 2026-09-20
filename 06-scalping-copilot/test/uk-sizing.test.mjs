/**
 * UK account sizing: two models, one binding constraint.
 *
 * The constraint is margin, not risk. Under the FCA's 20:1 cap on gold, a 1%
 * risk trade with a scalp-width stop consumes most of a small account — and
 * because margin depends on the stop as a FRACTION of price, the requirement
 * tightens every time gold rises. These tests pin that down, because it is the
 * part a dollar-denominated rule of thumb gets silently wrong.
 */
import assert from 'node:assert/strict';
import {
  sizeBothModels, stakeAcrossPointSizes, marginFraction, minStopForMargin, mt5Ticket,
} from '../src/risk.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

const BASE = {
  equity: 10000, riskPercent: 1, stopDistance: 3.00, price: 4391,
  pointSize: 0.10, contractSize: 100, marginFactor: 0.05, fxRate: 1.35,
};

console.log('\nthe margin constraint');

test('margin fraction is m*r/s and does not depend on account size', () => {
  near(marginFraction(0.05, 0.01, 3.00 / 4391), 0.7318, 0.0005);
});

test('it is price-invariant for a stop held as a FRACTION of price', () => {
  // Halve the price and halve the stop: identical margin.
  near(marginFraction(0.05, 0.01, 3.00 / 4391), marginFraction(0.05, 0.01, 1.50 / 2195.5), 1e-9);
});

test('but a fixed DOLLAR stop is NOT price-invariant — it scales linearly', () => {
  // This is the claim that must never drift back to "independent of price".
  // M/E = m*r*P/D, so holding D fixed and raising P raises the margin.
  const at2000 = marginFraction(0.05, 0.01, 3.00 / 2000);
  const at4391 = marginFraction(0.05, 0.01, 3.00 / 4391);
  const at5000 = marginFraction(0.05, 0.01, 3.00 / 5000);
  near(at2000, 0.3333, 0.001);
  near(at4391, 0.7318, 0.001);
  near(at5000, 0.8333, 0.001);
  // Linear in price: doubling the price doubles the margin requirement.
  near(at4391 / at2000, 4391 / 2000, 0.001);
});

test('a configurable stake step changes the answer, so it must not be hardcoded', () => {
  const penny = sizeBothModels({ ...BASE, stakeStep: 0.01 });
  const pound = sizeBothModels({ ...BASE, stakeStep: 1.00 });
  near(penny.spreadBet.stake, 3.33, 0.001);
  near(pound.spreadBet.stake, 3.00, 0.001);
  assert.ok(pound.spreadBet.actualRisk < penny.spreadBet.actualRisk,
    'a coarser step delivers materially less than the intended risk');
});

test('minStopForMargin inverts the relationship correctly', () => {
  const min = minStopForMargin(0.05, 0.01, 4391, 0.5);
  near(min, 4.391, 0.001);
  // Feeding it back in must land exactly on the ceiling.
  near(marginFraction(0.05, 0.01, min / 4391), 0.5, 1e-6);
});

test('a scalp-width stop at 1% risk is flagged as over the ceiling', () => {
  const r = sizeBothModels(BASE);
  assert.equal(r.margin.over, true);
  near(r.margin.pctOfEquity, 73.2, 0.1);
  assert.ok(r.margin.verdict, 'an over-ceiling position must explain itself');
  assert.ok(/margin/i.test(r.margin.verdict));
  assert.equal(r.margin.minStopForCeiling, 4.391);
});

test('a wider stop clears the ceiling', () => {
  const r = sizeBothModels({ ...BASE, stopDistance: 9.00 });
  assert.equal(r.margin.over, false);
  assert.equal(r.margin.verdict, null);
  near(r.margin.pctOfEquity, 24.4, 0.2);
});

console.log('\nthe two models');

test('spread bet and CFD reconcile exactly before rounding', () => {
  const r = sizeBothModels(BASE);
  assert.equal(r.bridge.reconciles, true);
  near(r.bridge.stakeFromLots, 3.33, 0.01);
  near(r.bridge.lotsFromStake, 0.45, 0.005);
});

test('spread bet: £3.33/pt over 30 points at $0.10 point size', () => {
  const r = sizeBothModels(BASE);
  assert.equal(r.spreadBet.stopPoints, 30);
  near(r.spreadBet.stakeRaw, 3.3333, 0.001);
  assert.equal(r.spreadBet.stake, 3.30, 'rounded DOWN to the stake step');
  assert.equal(r.spreadBet.actualRisk, 99, 'under the £100 budget, never over');
});

test('rounding is always DOWN — never quietly enlarging the risk', () => {
  const r = sizeBothModels(BASE);
  assert.ok(r.spreadBet.stake <= r.spreadBet.stakeRaw);
  assert.ok(r.cfd.lots <= r.cfd.lotsRaw);
  assert.ok(r.spreadBet.actualRisk <= r.riskBudget,
    'rounding up £3.333 to £3.50 would turn 1% risk into 1.05% on every trade');
});

test('GBP/USD is applied in the right direction', () => {
  // £100 of risk at 1.35 is $135 of risk, which over a $3 stop is 45 oz.
  const r = sizeBothModels(BASE);
  near(r.cfd.lotsRaw, 0.45, 0.001);
  // A stronger pound must permit a LARGER position, not a smaller one.
  const stronger = sizeBothModels({ ...BASE, fxRate: 1.60 });
  assert.ok(stronger.cfd.lotsRaw > r.cfd.lotsRaw,
    'the conversion is inverted — this is the error that misstates size by the square of the rate');
});

test('a USD account needs no conversion', () => {
  const r = sizeBothModels({ ...BASE, fxRate: 1, accountCurrency: 'USD' });
  near(r.cfd.lotsRaw, 0.3333, 0.001);   // $100 risk / ($3 x 100)
});

console.log('\npoint size, the firm-specific trap');

test('all three conventions give identical exposure per $1 of gold', () => {
  const rows = stakeAcrossPointSizes(10000, 1, 3.00);
  assert.equal(rows.length, 3);
  for (const row of rows) near(row.perDollarMove, 33.33, 0.01);
  // The stake NUMBER differs by 10x and 100x, which is the whole trap.
  assert.equal(rows[0].stake, 0.33);
  assert.equal(rows[1].stake, 3.33);
  assert.equal(rows[2].stake, 33.33);
});

test('margin does not depend on the point size convention', () => {
  const a = sizeBothModels({ ...BASE, pointSize: 0.01 });
  const b = sizeBothModels({ ...BASE, pointSize: 1.00 });
  near(a.margin.pctOfEquity, b.margin.pctOfEquity, 0.001);
  assert.notEqual(a.spreadBet.stake, b.spreadBet.stake, 'only the displayed stake differs');
});

test('a stake below the platform minimum is flagged, not silently shipped', () => {
  // $0.01 points on a small account drives the stake under IG's £0.50 floor.
  const r = sizeBothModels({ ...BASE, pointSize: 0.01, minStake: 0.50 });
  assert.equal(r.spreadBet.belowMinimum, true);
  assert.ok(/minimum/i.test(r.spreadBet.note));
});

console.log('\ncosts and refusals');

test('the spread is added to the stop before sizing', () => {
  const noSpread = sizeBothModels(BASE);
  const withSpread = sizeBothModels({ ...BASE, spread: 0.30 });
  assert.equal(withSpread.effectiveStop, 3.30);
  assert.ok(withSpread.cfd.lotsRaw < noSpread.cfd.lotsRaw,
    'paying the spread on entry means a smaller position for the same risk');
});

test('CFD commission reduces the position', () => {
  const plain = sizeBothModels(BASE);
  const withComm = sizeBothModels({ ...BASE, commissionPerLotRoundTurn: 30 });
  assert.ok(withComm.cfd.lotsRaw < plain.cfd.lotsRaw);
});

test('it refuses rather than guessing when the point size is unknown', () => {
  const r = sizeBothModels({ ...BASE, pointSize: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked.some((b) => /point size/i.test(b) && /firm-specific|assumed/i.test(b)));
});

test('it refuses on any missing input rather than producing a number', () => {
  for (const missing of ['equity', 'riskPercent', 'stopDistance', 'price']) {
    const r = sizeBothModels({ ...BASE, [missing]: 0 });
    assert.equal(r.ok, false, `${missing} missing should block`);
    assert.ok(r.blocked.length > 0);
  }
});

console.log('\nthe MT5 ticket');

test('gives stop and target as absolute PRICES, because that is what mobile takes', () => {
  const t = mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 4403.97, target: 4419.97, lots: 0.45, digits: 2 });
  assert.equal(t.stopLoss, 4403.97, 'an absolute level, not an 8.00 distance');
  assert.equal(t.takeProfit, 4419.97);
  assert.equal(t.volume, 0.45);
  assert.equal(t.stopDistance, 8);
});

test('rounds to the symbol digits, so the ticket is not rejected', () => {
  const g = mt5Ticket({ side: 'buy', entry: 4411.9712, invalidation: 4403.9744, target: null, lots: 0.45, digits: 2 });
  assert.equal(g.stopLoss, 4403.97);
  const b = mt5Ticket({ side: 'sell', entry: 81863.4321, invalidation: 82200.5678, target: null, lots: 0.05, digits: 1 });
  assert.equal(b.stopLoss, 82200.6);
});

test('a missing target is allowed; a missing stop is not', () => {
  const t = mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 4403.97, target: null, lots: 0.45 });
  assert.equal(t.takeProfit, null);
  assert.equal(mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 0, target: 4420, lots: 0.45 }), null);
  assert.equal(mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 4403.97, target: 4420, lots: 0 }), null);
});

test('a stop inside the broker minimum is caught before the ticket bounces', () => {
  const t = mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 4411.50, target: 4415, lots: 0.45, digits: 2, stopsLevel: 2.0 });
  assert.equal(t.tooTight, true);
  assert.ok(/reject|minimum/i.test(t.warning));
  const ok = mt5Ticket({ side: 'buy', entry: 4411.97, invalidation: 4403.97, target: 4420, lots: 0.45, digits: 2, stopsLevel: 2.0 });
  assert.equal(ok.tooTight, false);
  assert.equal(ok.warning, null);
});

test('no minimum-stake default is asserted, since published minimums vary and move', () => {
  // Shipping £0.50 or £0.10 as "the" minimum was refuted on checking.
  const r = sizeBothModels({ ...BASE, pointSize: 0.01 });
  assert.equal(r.spreadBet.belowMinimum, false, 'the check is off unless the user supplies their own');
  const withMin = sizeBothModels({ ...BASE, pointSize: 0.01, minStake: 5 });
  assert.equal(withMin.spreadBet.belowMinimum, true, 'and works when they do');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
