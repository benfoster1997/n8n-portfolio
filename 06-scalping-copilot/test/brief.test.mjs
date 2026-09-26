/**
 * The pre-session brief: the overnight range, how it compares with earlier
 * nights, today's releases, the shape of the day, and the day's plan.
 *
 * The parts most likely to be got wrong quietly are the time windows — gold's
 * overnight starts at a New York reopen that moves against London twice a year
 * and skips the weekend — and the comparison with earlier nights, which must
 * be like for like and must not count a closed market as a quiet one.
 */
import assert from 'node:assert/strict';
import {
  dayKey, overnightWindow, rangeOf, whereInRange, overnightVsNorm,
  todaysPrints, dayShape, planStatus, planProblem, SETUPS, dayTimes,
} from '../src/brief.js';
import { DEFAULT_WINDOW } from '../src/sessions.js';
import { formatHM } from '../src/timezone.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const W = DEFAULT_WINDOW;              // 08:00-16:00 Europe/London
const london = (ms) => formatHM(ms, 'Europe/London');
const M5 = 300000, DAY = 864e5;

/** Flat five-minute bars from a to b, with an optional spike per window. */
function flatBars(a, b, spikes = []) {
  const out = [];
  for (let t = a; t < b; t += M5) out.push({ t, o: 100, h: 100.05, l: 99.95, c: 100, v: 1 });
  for (const { at, size } of spikes) {
    const bar = out.find((x) => x.t >= at);
    if (bar) { bar.h = 100 + size / 2; bar.l = 100 - size / 2; }
  }
  return out;
}

console.log('\nthe overnight window');

test('the plan is keyed to the London calendar day', () => {
  assert.equal(dayKey(Date.UTC(2026, 6, 15, 6, 30), W), '2026-07-15');
  assert.equal(dayKey(Date.UTC(2026, 6, 14, 23, 30), W), '2026-07-15', '00:30 BST is already the 15th');
});

test("gold's overnight starts at the 18:00 New York reopen — 23:00 London in summer", () => {
  const now = Date.UTC(2026, 6, 15, 6, 30);   // Wed 07:30 BST
  const w = overnightWindow(now, 'XAUUSD', W);
  assert.equal(w.startMs, Date.UTC(2026, 6, 14, 22, 0));
  assert.equal(london(w.startMs), '23:00');
  assert.equal(w.endMs, now, 'before the open it runs up to now');
});

test("on a Monday it starts at Sunday's reopen, because gold is shut on Saturday", () => {
  const w = overnightWindow(Date.UTC(2026, 6, 13, 6, 30), 'XAUUSD', W);
  assert.equal(w.startMs, Date.UTC(2026, 6, 12, 22, 0));
});

test('in winter the reopen is still 23:00 London, since both clocks have moved', () => {
  const w = overnightWindow(Date.UTC(2026, 11, 2, 7, 30), 'XAUUSD', W);   // Wed 07:30 GMT
  assert.equal(london(w.startMs), '23:00');
});

test('once the window is open, the overnight stops at the open', () => {
  const w = overnightWindow(Date.UTC(2026, 6, 15, 12, 0), 'XAUUSD', W);
  assert.equal(london(w.endMs), '08:00');
});

test("bitcoin's overnight is the last 24 hours", () => {
  const now = Date.UTC(2026, 6, 15, 6, 30);
  const w = overnightWindow(now, 'BTCUSD', W);
  assert.equal(w.endMs - w.startMs, DAY);
});

console.log('\nthe range, and where price sits in it');

test('the range is the high and low of the bars inside the window', () => {
  const a = Date.UTC(2026, 6, 14, 22, 0), b = a + 8 * 3600e3;
  const r = rangeOf(flatBars(a, b, [{ at: a + 3600e3, size: 6 }]), a, b);
  assert.equal(r.high, 103); assert.equal(r.low, 97); assert.equal(r.size, 6);
});

test('under an hour of bars gives no range rather than a misleading one', () => {
  const a = Date.UTC(2026, 6, 14, 22, 0);
  assert.equal(rangeOf(flatBars(a, a + 50 * 60000), a, a + 3600e3), null);
});

test('where price sits, in words', () => {
  assert.equal(whereInRange(109, 110, 100).where, 'near the overnight high');
  assert.equal(whereInRange(101, 110, 100).where, 'near the overnight low');
  assert.equal(whereInRange(105, 110, 100).where, 'in the middle of the overnight range');
  assert.equal(whereInRange(111, 110, 100).where, 'above the overnight high', 'a typed price can be outside');
  assert.equal(whereInRange(99, 110, 100).where, 'below the overnight low');
  assert.equal(whereInRange(105, 100, 110), null, 'high below low is refused');
});

console.log('\ntonight against earlier nights');

const END = Date.UTC(2026, 6, 16, 6, 30);      // Thu 07:30 BST
const START = END - 8.5 * 3600e3;
// History reaches back exactly three nights, so a skipped night cannot be
// replaced from further back and the count shows it.
const nightsBars = (sizes) => flatBars(START - 3 * DAY, END,
  sizes.map((size, k) => ({ at: START - k * DAY + 3600e3, size })));

test('twice the usual range reads as busier than usual', () => {
  const v = overnightVsNorm(nightsBars([4, 2, 2, 2]), START, END);
  assert.equal(v.nights, 3);
  assert.equal(v.ratio, 2);
  assert.equal(v.word, 'busier than usual');
});

test('half the usual range reads as quieter than usual', () => {
  assert.equal(overnightVsNorm(nightsBars([1, 2, 2, 2]), START, END).word, 'quieter than usual');
});

test('a similar range reads as about normal', () => {
  assert.equal(overnightVsNorm(nightsBars([2.2, 2, 2, 2]), START, END).word, 'about normal');
});

test('the comparison uses the median, so one wild night does not set the norm', () => {
  assert.equal(overnightVsNorm(nightsBars([2, 2, 20, 2]), START, END).word, 'about normal');
});

test('a night the market was shut is skipped, not counted as quiet', () => {
  const bars = nightsBars([4, 2, 2, 2]).filter((b) => !(b.t >= START - DAY && b.t < END - DAY));
  const v = overnightVsNorm(bars, START, END);
  assert.equal(v.nights, 2, 'the missing night is dropped, not scored as a quiet one');
  assert.equal(v.word, 'busier than usual');
});

test('with more history, a skipped night is replaced by an older one', () => {
  const bars = flatBars(START - 5 * DAY, END, [4, 2, 2, 2, 2].map((size, k) => ({ at: START - k * DAY + 3600e3, size })))
    .filter((b) => !(b.t >= START - DAY && b.t < END - DAY));
  assert.equal(overnightVsNorm(bars, START, END).nights, 3);
});

test('with under two earlier nights it gives no verdict', () => {
  const bars = flatBars(START - DAY, END, [{ at: START + 3600e3, size: 4 }]);
  const v = overnightVsNorm(bars, START, END);
  assert.equal(v.ratio, null);
  assert.equal(v.word, null);
});

console.log('\ntoday, and the shape of the day');

test("today's releases in the window come with their flat-from and flat-until times", () => {
  // 2 Jul 2026 is the real NFP date: a Thursday, 13:30 London.
  const prints = todaysPrints(Date.UTC(2026, 6, 2, 6, 30), 'XAUUSD', W);
  const nfp = prints.find((e) => e.id === 'nfp');
  assert.ok(nfp, 'NFP should be listed');
  assert.equal(london(nfp.ts), '13:30');
  assert.ok(nfp.flatFromMs < nfp.ts && nfp.flatToMs > nfp.ts);
  assert.ok(prints.every((e) => typeof e.tier === 'number'), 'context-only rows never appear');
});

test('the day for gold: sit out 09:00-12:30, best 13:20-15:57', () => {
  const s = dayShape(Date.UTC(2026, 6, 15, 6, 30), 'XAUUSD', W);
  assert.deepEqual(s.sitOut.map((x) => [london(x.fromMs), london(x.toMs)]), [['09:00', '12:30']]);
  assert.deepEqual(s.best.map((x) => [london(x.fromMs), london(x.toMs)]), [['13:20', '15:57']]);
  assert.equal(s.best[0].names.length, 2, 'the two green bands are merged into one stretch');
});

test('the day for bitcoin: sit out 08:00-12:00, best from 13:20', () => {
  const s = dayShape(Date.UTC(2026, 6, 15, 6, 30), 'BTCUSD', W);
  assert.equal(london(s.sitOut[0].fromMs), '08:00');
  assert.equal(london(s.best[0].fromMs), '13:20');
});

test('the how-to card times come from the window, and read the same at 14:00', () => {
  for (const at of [Date.UTC(2026, 6, 15, 6, 0), Date.UTC(2026, 6, 15, 13, 0)]) {
    const t = dayTimes(at, W);
    assert.equal(london(t.briefFromMs), '07:30');
    assert.equal(t.stricterFromMs, undefined, 'no announced time for the final stretch (decision 1)');
    assert.deepEqual([london(t.XAUUSD.sitOut.fromMs), london(t.XAUUSD.sitOut.toMs)], ['09:00', '12:30']);
    assert.deepEqual([london(t.XAUUSD.best.fromMs), london(t.XAUUSD.best.toMs)], ['13:20', '15:57']);
    assert.deepEqual([london(t.BTCUSD.sitOut.fromMs), london(t.BTCUSD.sitOut.toMs)], ['08:00', '12:00']);
    assert.deepEqual([london(t.BTCUSD.best.fromMs), london(t.BTCUSD.best.toMs)], ['13:20', '16:00']);
  }
});

test('move the window and the card moves with it', () => {
  const t = dayTimes(Date.UTC(2026, 6, 15, 6, 0), { ...W, start: { h: 9, m: 0 }, end: { h: 17, m: 0 } });
  assert.equal(london(t.briefFromMs), '08:30');
  assert.equal(london(t.opensAtMs), '09:00');
});

console.log('\nthe plan');

test('a plan counts only on the day it was made', () => {
  const plan = { date: '2026-07-15', setups: ['Breakout'], maxTrades: 5, taken: 2 };
  assert.equal(planStatus(plan, '2026-07-16'), null);
  const s = planStatus(plan, '2026-07-15');
  assert.equal(s.text, '2 of 5 trades');
  assert.equal(s.over, false);
});

test('going past the plan is said plainly', () => {
  const s = planStatus({ date: 'd', setups: [], other: 'my own', maxTrades: 3, taken: 4 }, 'd');
  assert.equal(s.over, true);
  assert.equal(s.text, '4 trades — over your plan of 3');
  assert.deepEqual(s.setups, ['my own']);
});

test('a plan needs a setup and a trade limit — it demands the inputs', () => {
  assert.ok(planProblem({ setups: [], other: '', maxTrades: 5 }));
  assert.ok(planProblem({ setups: ['Breakout'], maxTrades: 0 }));
  assert.ok(planProblem({ setups: ['Breakout'], maxTrades: 2.5 }));
  assert.equal(planProblem({ setups: [], other: 'Fade the London high', maxTrades: 4 }), null);
  assert.equal(planProblem({ setups: [SETUPS[0]], maxTrades: 5 }), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
