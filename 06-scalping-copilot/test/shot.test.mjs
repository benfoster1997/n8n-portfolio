/**
 * Screenshot analysis: the parts that are plain code and that the model cannot
 * talk its way past — the gate that decides whether to spend usage at all, and
 * the check that turns a bad plan into "No trade" with a reason.
 */
import assert from 'node:assert/strict';
import {
  shotGate, checkPlan, analystPrompt, headPrompt, fastPrompt, contextLines,
  LENSES, median, shotIsFresh, SHOT_MAX_AGE_MS,
} from '../src/shot.js';
import { DEFAULT_WINDOW } from '../src/sessions.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const W = DEFAULT_WINDOW;
const reading = (over = {}) => ({
  readable: true, instrument_seen: 'XAUUSD', timeframe_seen: 'M5', price_now: 4391.2,
  axis_low: 4380, axis_high: 4402, view: 'buy', entry: 4391.2, stop_loss: 4386.5,
  take_profit_1: 4398, take_profit_2: 4401.5, confidence: 0.6, reasons: ['r'], against: ['a'], ...over,
});
const plan = (over = {}) => ({
  decision: 'buy', entry_type: 'market', entry: 4391.2, stop_loss: 4386.5,
  take_profit_1: 4398, take_profit_2: 4401.5, price_now: 4391.2, confidence: 'moderate',
  summary: 'Pullback held above support.', reasons: ['Higher lows'], against: ['Near resistance'],
  invalidated_if: 'Price closes below 4386.5.', ...over,
});
const three = (over = {}) => [reading(over), reading(over), reading(over)];
const CTX = { spread: 0.05, digits: 2 };

console.log('\nthe gate: whether to spend usage at all');

test('gold at the weekend is closed, and nothing is sent', () => {
  const g = shotGate({ pair: 'XAUUSD', weekend: true, band: 'dead', insideWindow: false, win: W });
  assert.equal(g.allowed, false); assert.equal(g.state, 'closed');
});

test('a news blackout stops it, with the clear time', () => {
  const g = shotGate({
    pair: 'XAUUSD', weekend: false, band: 'green', insideWindow: true, win: W,
    blackout: { active: true, phase: 'before', event: { name: 'Non-Farm Payrolls' }, endsAtMs: Date.UTC(2026, 6, 2, 13, 0) },
  });
  assert.equal(g.allowed, false); assert.equal(g.state, 'stand-aside');
  assert.match(g.message, /Non-Farm Payrolls/); assert.match(g.message, /Clear at 14:00/);
});

test('the weekday dead zone stops it (decision 2)', () => {
  const g = shotGate({ pair: 'XAUUSD', weekend: false, band: 'dead', insideWindow: true, win: W });
  assert.equal(g.allowed, false); assert.equal(g.state, 'stand-down');
});

test('bitcoin at the weekend is allowed, with a caution', () => {
  const g = shotGate({ pair: 'BTCUSD', weekend: true, band: 'dead', insideWindow: false, win: W });
  assert.equal(g.allowed, true); assert.equal(g.state, 'caution'); assert.match(g.message, /thin/);
});

test('outside the window on a weekday is allowed, with a caution', () => {
  const g = shotGate({ pair: 'BTCUSD', weekend: false, band: 'green', insideWindow: false, win: W });
  assert.equal(g.state, 'caution');
});

test('inside the window in a good band is simply allowed', () => {
  assert.equal(shotGate({ pair: 'XAUUSD', weekend: false, band: 'green', insideWindow: true, win: W }).state, 'ok');
});

console.log('\nthe check: what the model is not trusted to enforce on itself');

test('a clean, agreed plan passes, rounded to the symbol digits', () => {
  const r = checkPlan(plan({ entry: 4391.234 }), three(), CTX);
  assert.equal(r.decision, 'buy');
  assert.equal(r.entry, 4391.23);
  assert.equal(r.stopLoss, 4386.5);
  assert.deepEqual(r.agreement, { agree: 3, of: 3 });
  assert.ok(r.netR >= 1);
});

test('a sell mirrors it', () => {
  const r = checkPlan(plan({ decision: 'sell', stop_loss: 4396, take_profit_1: 4384, take_profit_2: 4381 }),
    three({ view: 'sell' }), CTX);
  assert.equal(r.decision, 'sell');
});

test('a stop on the wrong side becomes No trade', () => {
  const r = checkPlan(plan({ stop_loss: 4395 }), three(), CTX);
  assert.equal(r.decision, 'no_trade'); assert.equal(r.rejected, 'buy');
  assert.ok(r.problems.some((p) => /wrong side/.test(p)));
});

test('a stop inside five spreads becomes No trade', () => {
  const r = checkPlan(plan({ stop_loss: 4391.0, take_profit_1: 4392 }), three(), CTX);
  assert.ok(r.problems.some((p) => /Below 5×/.test(p)));
  assert.equal(r.decision, 'no_trade');
});

test('a target that pays less than the risk after the spread becomes No trade', () => {
  const r = checkPlan(plan({ take_profit_1: 4394 }), three(), CTX);
  assert.ok(r.problems.some((p) => /needs at least 1×/.test(p)));
});

test('the spread is charged on both sides of the reward-to-risk sum', () => {
  // Exactly 1:1 before costs is below 1:1 after them.
  const r = checkPlan(plan({ stop_loss: 4386.2, take_profit_1: 4396.2 }), three(), CTX);
  assert.equal(r.decision, 'no_trade');
});

test('only one analyst agreeing is not enough', () => {
  const rs = [reading(), reading({ view: 'sell' }), reading({ view: 'none' })];
  const r = checkPlan(plan(), rs, CTX);
  assert.equal(r.decision, 'no_trade');
  assert.ok(r.problems.some((p) => /Only 1 of 3/.test(p)));
});

test('analysts reading the price differently is No trade — the axis was not legible', () => {
  const rs = [reading(), reading({ price_now: 4391.2 }), reading({ price_now: 4410 })];
  const r = checkPlan(plan(), rs, CTX);
  assert.ok(r.problems.some((p) => /read the current price differently/.test(p)));
});

test('a price the user typed overrides the readings', () => {
  const rs = [reading(), reading({ price_now: 4391.2 }), reading({ price_now: 4410 })];
  const r = checkPlan(plan(), rs, { ...CTX, priceNow: 4391.2 });
  assert.equal(r.decision, 'buy');
  assert.equal(r.priceNow, 4391.2);
});

test('fewer than two readable charts is No trade', () => {
  const rs = [reading({ readable: false }), reading({ readable: false }), reading()];
  assert.ok(checkPlan(plan(), rs, CTX).problems.some((p) => /Fewer than two/.test(p)));
});

test('an entry far from the current price is No trade', () => {
  const r = checkPlan(plan({ entry: 4420, stop_loss: 4414, take_profit_1: 4432, take_profit_2: 4440 }), three(), CTX);
  assert.ok(r.problems.some((p) => /too far from the current price/.test(p)));
});

test('a level outside the visible chart is No trade', () => {
  const r = checkPlan(plan({ stop_loss: 4360, take_profit_1: 4440, take_profit_2: 4450 }), three(), CTX);
  assert.ok(r.problems.some((p) => /outside the part of the chart/.test(p)));
});

test('missing numbers are No trade, and strings with commas are read as numbers', () => {
  assert.equal(checkPlan(plan({ take_profit_1: null }), three(), CTX).decision, 'no_trade');
  assert.equal(checkPlan(plan({ entry: '4,391.20' }), three(), CTX).decision, 'buy');
});

test('an honest No trade passes straight through', () => {
  const r = checkPlan(plan({ decision: 'no_trade', entry: null, stop_loss: null, take_profit_1: null }), three({ view: 'none' }), CTX);
  assert.equal(r.decision, 'no_trade'); assert.deepEqual(r.problems, []);
});

test('anything that is not buy or sell is No trade', () => {
  assert.equal(checkPlan(plan({ decision: 'strong buy' }), three(), CTX).decision, 'no_trade');
  assert.equal(checkPlan(null, [], CTX).decision, 'no_trade');
});

test('the fast mode (no analysts) still gets every price rule', () => {
  assert.equal(checkPlan(plan(), [], CTX).decision, 'buy');
  assert.equal(checkPlan(plan({ stop_loss: 4395 }), [], CTX).decision, 'no_trade');
  assert.equal(checkPlan(plan(), [], CTX).agreement, null);
});

console.log('\nwhat the readers are told');

const C = {
  pair: 'BTCUSD', nowText: '21:22', weekday: 'Sunday', sessionName: 'Weekend', spread: '6.00',
  spreadSource: 'last read off your MT5', news: [], caution: 'Weekend: thin liquidity.',
  planSetups: ['Breakout'], tradesTaken: 1, maxTrades: 5, priceNow: null, minStopText: '30.00 (5× the spread)',
};

test('every prompt carries the instrument, the spread, the stop floor and the caution', () => {
  for (const p of [analystPrompt(LENSES[0], C), headPrompt([reading()], C), fastPrompt(C)]) {
    assert.match(p, /BTCUSD/); assert.match(p, /6\.00/); assert.match(p, /30\.00/); assert.match(p, /thin liquidity/);
    assert.match(p, /BID prices/); assert.match(p, /only one JSON object/);
  }
});

test('each analyst gets a different lens', () => {
  const ps = LENSES.map((l) => analystPrompt(l, C));
  assert.equal(new Set(ps).size, 3);
});

test('a typed price is passed on as the one to trust', () => {
  assert.ok(contextLines({ ...C, priceNow: 84400.5 }).some((l) => /84400\.5/.test(l) && /Trust it/.test(l)));
});

test('the head trader sees all three readings', () => {
  const p = headPrompt([reading(), reading({ view: 'sell' }), reading({ view: 'none' })], C);
  assert.match(p, /Analyst 1/); assert.match(p, /Analyst 3/); assert.match(p, /"view":"sell"/);
});

console.log('\nodds and ends');

test('median ignores junk', () => {
  assert.equal(median([3, NaN, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('an analysis is used for a ticket only while fresh, on the same instrument, and only for a trade', () => {
  const shot = { pair: 'XAUUSD', atMs: 0, result: { decision: 'buy' } };
  assert.equal(shotIsFresh(shot, SHOT_MAX_AGE_MS - 1, 'XAUUSD'), true);
  assert.equal(shotIsFresh(shot, SHOT_MAX_AGE_MS + 1, 'XAUUSD'), false);
  assert.equal(shotIsFresh(shot, 1, 'BTCUSD'), false);
  assert.equal(shotIsFresh({ ...shot, result: { decision: 'no_trade' } }, 1, 'XAUUSD'), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
