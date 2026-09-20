/**
 * The arithmetic that decides when a result means anything.
 *
 * The headline these tests protect: an observed 60% over 30 trades is
 * statistically indistinguishable from a coin. Any tool that lets that read as
 * "it's working" is teaching its user to trust noise.
 */
import assert from 'node:assert/strict';
import {
  breakEvenRate, tradesNeeded, assessRecord, expectedStreak, timeToSample,
  demoHaircut, BASE_RATES,
} from '../src/edge-test.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

console.log('\nthe null hypothesis is not 50%');

test('break-even is set by cost, not by symmetry', () => {
  near(breakEvenRate(1, 0), 0.5, 1e-9);
  near(breakEvenRate(1, 0.0167), 0.508, 0.001, 'a small cost moves the bar');
  near(breakEvenRate(2, 0), 1 / 3, 1e-9);
  assert.equal(breakEvenRate(0.5, 1), null, 'a target inside the cost is impossible');
});

console.log('\nsample size');

test('detecting a smaller edge costs quadratically more trades', () => {
  const be = breakEvenRate(1, 0.0167);
  const big = tradesNeeded(0.60, be);
  const small = tradesNeeded(0.55, be);
  const tiny = tradesNeeded(0.52, be);
  assert.ok(big < small && small < tiny);
  // Halving the edge roughly quadruples the requirement.
  assert.ok(tiny / small > 8, `52% needs far more than 55% (${tiny} vs ${small})`);
  assert.ok(big < 250 && big > 100, `60% should land near 180, got ${big}`);
  assert.ok(tiny > 5000, `52% should run into the thousands, got ${tiny}`);
});

test('an edge at or below break-even is not detectable at all', () => {
  const be = breakEvenRate(1, 0.0167);
  assert.equal(tradesNeeded(be, be), null);
  assert.equal(tradesNeeded(0.45, be), null);
});

test('at EQUAL expectancy, a wider payoff is HARDER to prove, not easier', () => {
  // This test previously asserted the opposite, by comparing two edges of
  // different size and reading the result as being about R:R. It is not.
  //
  // 60% at 1:1 and 40% at 1:2 have identical expectancy (+0.20R). But the 1:2
  // version has ~50% more variance per trade, because the outcomes are further
  // apart — so it needs roughly twice the sample to separate from break-even.
  // A wider payoff buys comfort, not faster proof.
  const evA = 0.60 * 1 - 0.40;          // 60% at 1:1
  const evB = 0.40 * 2 - 0.60;          // 40% at 1:2
  assert.ok(Math.abs(evA - evB) < 1e-9, 'the two cases must have equal expectancy');

  const nA = tradesNeeded(0.60, breakEvenRate(1, 0));
  const nB = tradesNeeded(0.40, breakEvenRate(2, 0));
  assert.ok(nB > nA, `1:2 should need MORE trades (${nB}) than 1:1 (${nA}) at equal EV`);
  assert.ok(nB / nA > 1.5 && nB / nA < 3, `expected roughly 2x, got ${(nB / nA).toFixed(2)}x`);
});

console.log('\nwhat a record actually supports');

test('60% over 30 trades is indistinguishable from a coin', () => {
  const r = assessRecord({ trades: 30, wins: 18, rewardRisk: 1, costInRisk: 0.0167 });
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(r.ci[0] < 0.508, 'the interval must still contain break-even');
  assert.ok(r.ci[1] - r.ci[0] > 0.3, 'and it should be embarrassingly wide');
  assert.ok(/not yet distinguishable/i.test(r.text));
});

test('the same rate over 300 trades does clear the bar', () => {
  const r = assessRecord({ trades: 300, wins: 180, rewardRisk: 1, costInRisk: 0.0167 });
  assert.equal(r.verdict, 'edge');
  assert.ok(r.ci[0] > r.breakEven);
});

test('a clearly bad record is called bad, not merely inconclusive', () => {
  const r = assessRecord({ trades: 200, wins: 80, rewardRisk: 1, costInRisk: 0.0167 });
  assert.equal(r.verdict, 'negative');
  assert.ok(r.ci[1] < r.breakEven);
  assert.ok(/not working/i.test(r.text));
});

test('the verdict is three-valued — "no evidence yet" is not "no edge"', () => {
  const verdicts = new Set([
    assessRecord({ trades: 30, wins: 18, costInRisk: 0.0167 }).verdict,
    assessRecord({ trades: 300, wins: 180, costInRisk: 0.0167 }).verdict,
    assessRecord({ trades: 200, wins: 80, costInRisk: 0.0167 }).verdict,
  ]);
  assert.equal(verdicts.size, 3, 'conflating inconclusive with negative abandons working systems');
});

test('expectancy is reported in R with its own error bar', () => {
  const r = assessRecord({ trades: 300, wins: 180, rewardRisk: 1, costInRisk: 0.0167 });
  assert.ok(r.expectancyR > 0);
  assert.ok(r.expectancySe > 0);
  assert.equal(typeof r.expectancyClearOfZero, 'boolean');
  // A win rate alone says nothing without the payoff attached.
  const wide = assessRecord({ trades: 300, wins: 120, rewardRisk: 3, costInRisk: 0 });
  assert.ok(wide.expectancyR > 0, '40% at 1:3 is strongly profitable despite the low win rate');
});

test('malformed input returns null rather than a number', () => {
  assert.equal(assessRecord({ trades: 0, wins: 0 }), null);
  assert.equal(assessRecord({ trades: 10, wins: 11 }), null);
  assert.equal(assessRecord({ trades: 10, wins: -1 }), null);
});

console.log('\nthe optional-stopping guard');

test('no verdict is offered before the committed sample is reached', () => {
  const r = assessRecord({ trades: 30, wins: 18, costInRisk: 0.0167, plannedSample: 300 });
  assert.equal(r.verdict, 'collecting');
  assert.equal(r.remaining, 270);
  assert.equal(r.pctDone, 10);
  assert.equal(r.expectancyClearOfZero, false, 'it must not claim significance early');
  assert.ok(/No verdict until/i.test(r.text));
  assert.ok(/5% test into a 20% one/i.test(r.text), 'the reason should be stated, not just the rule');
});

test('the verdict appears once the sample is complete', () => {
  assert.equal(assessRecord({ trades: 300, wins: 180, costInRisk: 0.0167, plannedSample: 300 }).verdict, 'edge');
  assert.equal(assessRecord({ trades: 301, wins: 181, costInRisk: 0.0167, plannedSample: 300 }).verdict, 'edge');
});

test('a favourable early run does NOT produce a verdict', () => {
  // 12 wins from 15 is 80% and would clear any naive test. That is exactly the
  // wobble continuous re-testing catches, and exactly what must be refused.
  const r = assessRecord({ trades: 15, wins: 12, costInRisk: 0.0167, plannedSample: 300 });
  assert.equal(r.verdict, 'collecting');
  assert.notEqual(r.verdict, 'edge');
});

test('with no committed sample it still tests, for ad-hoc use', () => {
  const r = assessRecord({ trades: 300, wins: 180, costInRisk: 0.0167 });
  assert.equal(r.verdict, 'edge');
});

console.log('\nWilson, not Wald');

test('the interval is bounded and matches the Wilson score form', () => {
  const r = assessRecord({ trades: 30, wins: 18, costInRisk: 0.0167 });
  // Wilson at 18/30 is [0.423, 0.754]; Wald would give [0.425, 0.775].
  near(r.ci[0], 0.423, 0.003);
  near(r.ci[1], 0.754, 0.003);
});

test('Wilson never runs past 0 or 1, where Wald does', () => {
  const perfect = assessRecord({ trades: 10, wins: 10, costInRisk: 0 });
  assert.ok(perfect.ci[1] <= 1, 'upper bound must stay in range');
  assert.ok(perfect.ci[0] > 0.6, 'and 10/10 should still have a sane lower bound');
  const none = assessRecord({ trades: 10, wins: 0, costInRisk: 0 });
  assert.ok(none.ci[0] >= 0);
  assert.ok(none.ci[1] > 0, 'Wald would collapse this interval to zero width');
});

console.log('\nlosing runs, so they are not mistaken for failure');

test('streak probabilities are exact, matching an independent calculation', () => {
  // Computed by absorbing-Markov DP, not the overlapping-windows approximation.
  // These figures were derived independently and must reproduce exactly.
  const s = expectedStreak(0.55, 500);
  const at = (k) => s.rows.find((r) => r.length === k).probability;
  near(at(5), 0.995, 0.002);
  near(at(6), 0.903, 0.003);
  near(at(7), 0.644, 0.005);
  near(at(8), 0.369, 0.005);
  near(at(10), 0.088, 0.004);
});

test('a long losing run is near-certain over a real sample', () => {
  const s = expectedStreak(0.55, 300);
  assert.ok(s.likelyWorst >= 5, `at 55% over 300 trades expect a run of at least 5, got ${s.likelyWorst}`);
  assert.ok(s.rows.find((r) => r.length === 7).probability > 0.3);
});

test('a worse win rate means longer runs', () => {
  assert.ok(expectedStreak(0.45, 300).likelyWorst > expectedStreak(0.65, 300).likelyWorst);
});

test('streaks need a valid rate', () => {
  assert.equal(expectedStreak(0, 300), null);
  assert.equal(expectedStreak(1, 300), null);
  assert.equal(expectedStreak(0.55, 0), null);
});

console.log('\ncalendar time');

test('sample size converts to a real number of weeks', () => {
  const t = timeToSample(874, 5);
  assert.equal(t.days, 175);
  near(t.weeks, 35, 0.5);
  assert.ok(t.months > 7, 'proving a 55% edge at five trades a day takes most of a year');
});

test('more trades a day shortens it proportionally', () => {
  assert.ok(timeToSample(874, 10).days < timeToSample(874, 5).days);
  assert.equal(timeToSample(874, 0), null);
});

console.log('\ndemo bias and base rates');

test('the demo haircut is asymmetric — stops slip, targets do not', () => {
  const h = demoHaircut({ grossR: 0.20, trades: 300, slippageInR: 0.05, winRate: 0.6 });
  // Only the 40% of trades that lose take the slippage: 0.4 * 0.05 = 0.02R.
  near(h.penaltyPerTrade, 0.02, 0.0001);
  near(h.adjustedR, 0.18, 0.0001);
  assert.ok(/Stops slip and targets do not/i.test(h.text));
  assert.ok(/partial fills/i.test(h.text), 'IOC is the thing demo cannot show at all');
});

test('a higher win rate takes a smaller haircut', () => {
  const good = demoHaircut({ grossR: 0.2, trades: 300, slippageInR: 0.05, winRate: 0.7 });
  const poor = demoHaircut({ grossR: 0.2, trades: 300, slippageInR: 0.05, winRate: 0.4 });
  assert.ok(poor.penaltyPerTrade > good.penaltyPerTrade);
});

test('base rates are carried with their provenance, not as bare numbers', () => {
  assert.ok(BASE_RATES.profitableShare);
  assert.ok(BASE_RATES.sources.includes('Barber'));
  assert.equal(BASE_RATES.confidence, 'likely');
  assert.ok(BASE_RATES.note.includes('unreachable'), 'the tool must not imply it read the papers');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
