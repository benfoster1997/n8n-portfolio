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

test('a wider payoff needs a smaller sample for the same profitability', () => {
  const at1to1 = tradesNeeded(0.55, breakEvenRate(1, 0));
  const at1to2 = tradesNeeded(0.45, breakEvenRate(2, 0));
  assert.ok(at1to2 < at1to1, 'a bigger R is easier to prove from fewer trades');
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

console.log('\nlosing runs, so they are not mistaken for failure');

test('a long losing run is near-certain over a real sample', () => {
  const s = expectedStreak(0.55, 300);
  assert.ok(s.likelyWorst >= 5, `at 55% over 300 trades expect a run of at least 5, got ${s.likelyWorst}`);
  const seven = s.rows.find((r) => r.length === 7);
  assert.ok(seven.probability > 0.3, 'a seven-loss run should be a live possibility');
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
