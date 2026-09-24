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
  spreadDrag, allInSpread, breakEvenWinRate, marginPosture, practiceRealism,
  orderSplit, fillRisk,
} from '../src/risk.js';
import {
  marginPerLot, bidChartNote, INSTRUMENTS, commissionRoundTurnQuote, swapPerNight, unconfirmedFields,
} from '../src/instruments.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};
const near = (a, b, eps = 0.01, msg) => assert.ok(Math.abs(a - b) < eps, msg || `expected ~${b}, got ${a}`);

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

console.log('\nleverage-derived margin and the bid chart');

test('margin per lot is contract size over leverage, in ounces', () => {
  // The spec says Calculation: Forex, Margin currency: XAU — so the
  // "Initial margin: 100" row is 100 OUNCES, the contract size, not 100 dollars.
  const at20 = marginPerLot(100, 20, 4375);
  assert.equal(at20.units, 5, '100 oz / 20');
  assert.equal(at20.amount, 21875);
  near(at20.asFraction, 0.05, 1e-9, 'which is exactly the 5% FCA tier');
  // And it reconciles against the notional.
  near(at20.amount / (100 * 4375), 0.05, 1e-9);
});

test('margin scales with the price, as the broker computes it', () => {
  const cheap = marginPerLot(100, 20, 2000);
  const dear = marginPerLot(100, 20, 5000);
  assert.equal(cheap.units, dear.units, 'the ounce requirement does not move');
  assert.ok(dear.amount > cheap.amount, 'but its cash value does');
  near(dear.amount / cheap.amount, 2.5, 1e-9);
});

test('marginPerLot refuses rather than guessing', () => {
  assert.equal(marginPerLot(100, 0, 4375), null);
  assert.equal(marginPerLot(0, 20, 4375), null);
  assert.equal(marginPerLot(100, 20, 0), null);
});

test('a long lines up with a bid chart; a short does not', () => {
  const buy = bidChartNote('buy', 0.05, 2);
  assert.equal(buy.aligned, true);
  assert.ok(/line up|lines up/i.test(buy.text));

  const sell = bidChartNote('sell', 0.05, 2);
  assert.equal(sell.aligned, false);
  // The short's stop fires before the chart reaches the drawn level.
  assert.ok(/short of the level|before/i.test(sell.text));
  assert.ok(/ASK/.test(sell.text), 'it must name what the level is actually checked against');
});

test('no bid-chart note without a spread to quantify it', () => {
  assert.equal(bidChartNote('sell', 0, 2), null);
  assert.equal(bidChartNote('sell', null, 2), null);
});

console.log('\ncommission, on a tight-spread account');

test('on a raw account the commission is the larger half of the cost', () => {
  // A real observed gold spread of $0.05 with a typical $7/lot round turn.
  const d = spreadDrag({
    spread: 0.05, valuePerUnitMovePerLot: 100, lots: 0.45,
    tradesPerDay: 15, commissionPerLotRoundTurn: 7.00,
  });
  near(d.spreadPart, 2.25);
  near(d.commissionPart, 3.15);
  assert.equal(d.commissionShare, 58);
  assert.ok(d.commissionPart > d.spreadPart,
    'counting only the spread would understate the cost by more than half');
});

test('commission share is independent of position size', () => {
  const small = spreadDrag({ spread: 0.05, valuePerUnitMovePerLot: 100, lots: 0.10, tradesPerDay: 15, commissionPerLotRoundTurn: 7 });
  const big = spreadDrag({ spread: 0.05, valuePerUnitMovePerLot: 100, lots: 2.00, tradesPerDay: 15, commissionPerLotRoundTurn: 7 });
  assert.equal(small.commissionShare, big.commissionShare);
});

test('allInSpread puts commission on the same scale as the spread', () => {
  // $7 per lot over 100 oz is $0.07 per ounce.
  assert.equal(allInSpread(0.05, 7.00, 100), 0.12);
  assert.equal(allInSpread(0.35, 0, 100), 0.35, 'no commission leaves it unchanged');
  assert.equal(allInSpread(0.05, 7.00, 0), null, 'refuses without a contract size');
});

test('a tight spread with commission can cost more than a wide one without', () => {
  const raw = allInSpread(0.05, 7.00, 100);      // 0.12
  const standard = allInSpread(0.10, 0, 100);    // 0.10
  assert.ok(raw > standard,
    'the headline spread is not the comparison that matters');
});

test('break-even uses the all-in cost, so a raw account is not flattered', () => {
  const spreadOnly = breakEvenWinRate(3.00, 3.00, 0.05);
  const allIn = breakEvenWinRate(3.00, 3.00, allInSpread(0.05, 7.00, 100));
  assert.equal(spreadOnly.rate, 50.8);
  assert.equal(allIn.rate, 52);
  assert.ok(allIn.rate > spreadOnly.rate);
});

test('the confirmed gold specification is recorded as confirmed', () => {
  const g = INSTRUMENTS.XAUUSD;
  assert.equal(g.contractSize.value, 100);
  assert.equal(g.digits.value, 2, 'digits 2, so one point is $0.01');
  assert.equal(g.dollarMoveValuePerLot.value, 100, 'a $1 move is $100 per lot');
  assert.equal(g.minLot.value, 0.01);
  assert.equal(g.stopsLevel.value, 0, 'no broker minimum stop distance');
  assert.equal(g.chartIsBid, true);
  assert.equal(g.marginCurrency, 'XAU');
  for (const k of ['contractSize', 'digits', 'minLot', 'stopsLevel']) {
    assert.equal(g[k].confirmed, true, `${k} should be marked confirmed, not a default`);
    assert.notEqual(g[k].confirm, true, `${k} should no longer be awaiting confirmation`);
  }
});

test('the confirmed bitcoin specification is recorded as confirmed', () => {
  const b = INSTRUMENTS.BTCUSD;
  assert.equal(b.contractSize.value, 1, 'one lot is one bitcoin at this broker');
  assert.equal(b.digits.value, 2);
  assert.equal(b.minLot.value, 0.01);
  assert.equal(b.maxVolume.value, 10);
  assert.equal(b.stopsLevel.value, 0);
  assert.equal(b.commission.perSide, 0);
  for (const k of ['contractSize', 'digits', 'minLot', 'lotStep', 'maxVolume', 'stopsLevel']) {
    assert.equal(b[k].confirmed, true, `${k} should be marked confirmed`);
  }
  assert.deepEqual(unconfirmedFields(b).map((f) => f.key), ['typicalSpread'],
    'only the spread is still unmeasured, and the tool should keep saying so');
  assert.deepEqual(unconfirmedFields(INSTRUMENTS.XAUUSD), []);
});

console.log('\ncommission and swap, from the specification');

test('gold commission is per side in GBP, so a round turn is twice it, in dollars', () => {
  near(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 1.35), 2.75 * 2 * 1.35, 1e-6);
});

test('a typed per-side figure overrides the spec, and zero is a real answer', () => {
  near(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 1.35, '3'), 8.10, 1e-6);
  assert.equal(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 1.35, '0'), 0);
  near(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 1.35, ''), 7.425, 1e-6,
    'an empty box means "use the spec", not zero');
});

test('commission refuses without a GBP/USD rate rather than inventing one', () => {
  assert.equal(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 0), null);
  assert.equal(commissionRoundTurnQuote(INSTRUMENTS.XAUUSD, 1.35, '-1'), null);
});

test('bitcoin carries no commission', () => {
  assert.equal(commissionRoundTurnQuote(INSTRUMENTS.BTCUSD, 1.35), 0);
});

test('gold swap in points: -60.891 points is -$60.89 a lot a night', () => {
  assert.equal(swapPerNight(INSTRUMENTS.XAUUSD, 4400, 'long'), -60.89);
  assert.equal(swapPerNight(INSTRUMENTS.XAUUSD, 4400, 'short'), 42.6);
  assert.equal(swapPerNight(INSTRUMENTS.XAUUSD, 2000, 'long'), -60.89,
    'a points swap does not move with the price');
});

test('bitcoin swap is a percentage of the position, so it scales with price', () => {
  // -20% a year over 360 days on $80,000 of bitcoin.
  assert.equal(swapPerNight(INSTRUMENTS.BTCUSD, 80000, 'long'), -44.44);
  assert.equal(swapPerNight(INSTRUMENTS.BTCUSD, 40000, 'long'), -22.22);
  assert.equal(swapPerNight(INSTRUMENTS.BTCUSD, 80000, 'short'), 0);
  assert.equal(swapPerNight(INSTRUMENTS.BTCUSD, 0, 'long'), null, 'no price, no figure');
});

console.log('\nwhat margin is actually doing');

test('at regulated leverage, margin is a genuine brake', () => {
  const p = marginPosture({
    marginPct: 0.73, leverage: 20, equity: 10000,
    marginPerLotAccount: 16325, wantedLots: 0.45,
  });
  assert.equal(p.state, 'binding');
  assert.ok(p.maxLots < 1, 'a £10k account cannot hold even one lot at 1:20');
});

test('at 1:500 it is NOT a brake, and the tool says so rather than saying "comfortable"', () => {
  const p = marginPosture({
    marginPct: 0.029, leverage: 500, equity: 10000,
    marginPerLotAccount: 653, wantedLots: 0.45,
  });
  assert.equal(p.state, 'no-brake');
  assert.notEqual(p.headline, 'Comfortable on margin',
    'a low margin figure at high leverage is true but gives the wrong impression');
  assert.ok(/not protecting|absence of a limit/i.test(p.headline + p.text));
  assert.ok(p.headroom > 30, 'the account could hold ~34x the intended position');
});

test('low margin at LOW leverage is genuinely comfortable', () => {
  const p = marginPosture({
    marginPct: 0.24, leverage: 20, equity: 10000,
    marginPerLotAccount: 16325, wantedLots: 0.15,
  });
  assert.equal(p.state, 'comfortable',
    'the warning is about leverage removing a limit, not about a small number');
});

test('the binding case wins even at high leverage', () => {
  const p = marginPosture({
    marginPct: 0.8, leverage: 500, equity: 10000,
    marginPerLotAccount: 653, wantedLots: 12,
  });
  assert.equal(p.state, 'binding');
});

console.log('\npractice that transfers');

test('a demo funded far above the real account is flagged', () => {
  const r = practiceRealism(9816107.46, 10000);
  assert.equal(r.ok, false);
  assert.ok(r.ratio > 900);
  assert.ok(/habits transfer|calibrated to the wrong number/i.test(r.text));
});

test('a demo matched to the real account passes', () => {
  assert.equal(practiceRealism(10000, 10000).ok, true);
  assert.equal(practiceRealism(12000, 10000).ok, true);
});

test('a demo far BELOW the real account is flagged too', () => {
  const r = practiceRealism(500, 10000);
  assert.equal(r.ok, false);
  assert.ok(/below/i.test(r.text));
});

test('it stays silent until the user says what they would actually trade', () => {
  assert.equal(practiceRealism(9816107.46, 0), null);
  assert.equal(practiceRealism(9816107.46, null), null);
});

console.log('\nconstraints that only appear at size');

const DEMO = { ...BASE, equity: 9816107.46, marginFactor: 1 / 500 };

test('a correctly sized position can still be too big for one ticket', () => {
  const r = sizeBothModels(DEMO);
  assert.ok(r.cfd.lots > 400, `expected a large position, got ${r.cfd.lots}`);
  const sp = orderSplit(r.cfd.lots, 100);
  assert.equal(sp.needsSplit, true);
  assert.equal(sp.orders, 5);
  assert.equal(sp.perOrder, 100);
  assert.ok(sp.remainder > 0 && sp.remainder < 100);
  // Sensible on risk, comfortable on margin, and still unplaceable as one order.
  assert.equal(r.margin.over, false);
});

test('splitting is not charged twice in spread, and the note says so', () => {
  const sp = orderSplit(431.26, 100);
  assert.ok(/does not cost more in spread/i.test(sp.text));
  assert.ok(/later ones/i.test(sp.text), 'the real cost is execution, not spread');
});

test('an exact multiple needs no remainder order', () => {
  const sp = orderSplit(300, 100);
  assert.equal(sp.orders, 3);
  assert.equal(sp.remainder, null);
});

test('a small position never triggers a split', () => {
  assert.equal(orderSplit(0.45, 100).needsSplit, false);
  assert.equal(orderSplit(100, 100).needsSplit, false, 'exactly at the cap is one order');
});

test('an unknown cap is reported as unknown, not as "fine"', () => {
  const sp = orderSplit(431.26, 0);
  assert.equal(sp.unknown, true);
  assert.equal(sp.needsSplit, false);
});

test('Immediate-or-Cancel at size warns about a partial fill', () => {
  const fr = fillRisk({ lots: 431.26, contractSize: 100, fillMode: 'ioc' });
  assert.equal(fr.large, true);
  assert.equal(fr.units, 43126);
  assert.ok(/partial fill/i.test(fr.text));
  assert.ok(/smaller than the one you sized/i.test(fr.text),
    'the risk calculation breaks downward, and that should be said');
});

test('a small position gets no fill warning', () => {
  const fr = fillRisk({ lots: 0.45, contractSize: 100, fillMode: 'ioc' });
  assert.equal(fr.large, false);
  assert.equal(fr.text, undefined);
});

test('margin still reads "no brake" at the demo balance and 1:500', () => {
  const r = sizeBothModels(DEMO);
  const p = marginPosture({
    marginPct: r.margin.pctOfEquity / 100, leverage: 500,
    equity: DEMO.equity, marginPerLotAccount: (100 / 500) * DEMO.price / DEMO.fxRate,
    wantedLots: r.cfd.lots,
  });
  assert.equal(p.state, 'no-brake',
    'a big balance does not change the fact that leverage has removed the limit');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
