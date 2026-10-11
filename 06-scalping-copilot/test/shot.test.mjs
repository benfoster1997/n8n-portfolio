/**
 * Screenshot analysis: the parts that are plain code and that the model cannot
 * talk its way past — whether the market is open, the gate that decides
 * whether to spend usage at all, and the check that turns a bad plan into
 * "No trade" with a reason. Most cases here came from an independent review
 * that found ways a bad plan could get through.
 */
import assert from 'node:assert/strict';
import {
  shotGate, checkPlan, analystPrompt, headPrompt, fastPrompt, contextLines,
  LENSES, median, shotIsFresh, shotMaxAgeMs, marketOpenNow, seesInstrument, stopFloor,
  chatPrompt, parseReply, TIMEFRAMES, DEFAULT_TIMEFRAME, timeframeOf, tfInfo, seesTimeframe, otherTimeframeSeen,
} from '../src/shot.js';
import { DEFAULT_WINDOW } from '../src/sessions.js';
import { INSTRUMENTS } from '../src/instruments.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const W = DEFAULT_WINDOW;
const reading = (over = {}) => ({
  readable: true, instrument_seen: 'XAUUSD', timeframe_seen: 'M5', price_now: 4391.2,
  axis_low: 4380, axis_high: 4402, view: 'buy', stop_loss: 4386.5,
  take_profit_1: 4398, take_profit_2: 4401.5, confidence: 0.6, reasons: ['r'], against: ['a'], ...over,
});
const plan = (over = {}) => ({
  decision: 'buy', instrument_seen: 'XAUUSD', timeframe_seen: 'M5', price_now: 4391.2,
  axis_low: 4380, axis_high: 4402, stop_loss: 4386.5, take_profit_1: 4398, take_profit_2: 4401.5,
  confidence: 'moderate', summary: 'Pullback held above support.', reasons: ['Higher lows'],
  against: ['Near resistance'], invalidated_if: 'Price closes below 4386.5.', ...over,
});
const three = (over = {}) => [reading(over), reading(over), reading(over)];
// Gold: $0.05 spread + $0.074 commission; minimum stop 0.05% of price. The
// cases below were written for M5 and run on it; M15 has its own section.
const CTX = { priceNow: 4391.2, cost: 0.124, digits: 2, pair: 'XAUUSD', minStopPct: 0.0005, asked: 3, timeframe: 'M5' };
const has = (r, re) => r.problems.some((p) => re.test(p));

console.log('\nis the market open (broker server time, UTC+3)');

test('gold is open at midday on a weekday', () => {
  assert.equal(marketOpenNow(INSTRUMENTS.XAUUSD, Date.UTC(2026, 6, 15, 11, 0), 3), true);
});
test("gold's daily break (22:30 London = 00:30 server) is closed", () => {
  assert.equal(marketOpenNow(INSTRUMENTS.XAUUSD, Date.UTC(2026, 6, 15, 21, 30), 3), false);
});
test('gold is closed on Saturday', () => {
  assert.equal(marketOpenNow(INSTRUMENTS.XAUUSD, Date.UTC(2026, 6, 18, 12, 0), 3), false);
});
test('bitcoin is open on a Sunday evening', () => {
  assert.equal(marketOpenNow(INSTRUMENTS.BTCUSD, Date.UTC(2026, 8, 27, 20, 30), 3), true);
});
test("bitcoin's Friday-night break (00:00 Saturday server) is closed", () => {
  assert.equal(marketOpenNow(INSTRUMENTS.BTCUSD, Date.UTC(2026, 8, 25, 21, 0), 3), false);
});
test('with no server clock set it does not guess', () => {
  assert.equal(marketOpenNow(INSTRUMENTS.XAUUSD, Date.UTC(2026, 6, 15, 11, 0), ''), null);
});

console.log('\nthe gate: whether to spend usage at all');

const gate = (over = {}) => shotGate({ pair: 'XAUUSD', weekend: false, band: 'green', insideWindow: true, win: W, marketOpen: true, nowMs: 0, ...over });

test('gold at the weekend is closed, and nothing is sent', () => {
  const g = gate({ weekend: true, band: 'dead', insideWindow: false });
  assert.equal(g.allowed, false); assert.equal(g.state, 'closed'); assert.match(g.message, /Bitcoin/);
});
test("a broker's daily break is closed", () => {
  const g = gate({ pair: 'BTCUSD', marketOpen: false });
  assert.equal(g.state, 'closed'); assert.match(g.message, /daily break/);
});
test('a news blackout stops it, with the clear time', () => {
  const g = gate({ blackout: { active: true, phase: 'before', event: { name: 'Non-Farm Payrolls' }, endsAtMs: Date.UTC(2026, 6, 2, 13, 0) } });
  assert.equal(g.state, 'stand-aside'); assert.match(g.message, /Non-Farm Payrolls/); assert.match(g.message, /Clear at 14:00/);
});
test('the weekday dead zone stops it, and says until when (decision 2)', () => {
  const g = gate({ band: 'dead', bandEndsAtMs: Date.UTC(2026, 6, 15, 11, 30) });
  assert.equal(g.state, 'stand-down'); assert.match(g.message, /until 12:30/);
});
test('bitcoin at the weekend is allowed, but wants the spread typed first', () => {
  const g = gate({ pair: 'BTCUSD', weekend: true, band: 'dead', insideWindow: false });
  assert.equal(g.allowed, true); assert.equal(g.state, 'caution'); assert.equal(g.needsSpread, true);
});
test('a major release within 30 minutes is a caution, not a block', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0);
  const g = gate({ nowMs: now, nextMajor: { short: 'NFP', ts: now + 20 * 60000 } });
  assert.equal(g.state, 'caution'); assert.match(g.message, /NFP/); assert.equal(g.needsSpread, false);
});
test('on M15 the caution starts an hour before a major release; on M5, half an hour', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0);
  const nfp = { short: 'NFP', ts: now + 45 * 60000 };
  assert.equal(gate({ nowMs: now, nextMajor: nfp, timeframe: 'M15' }).state, 'caution');
  assert.equal(gate({ nowMs: now, nextMajor: nfp }).state, 'caution', 'M15 is the default');
  assert.equal(gate({ nowMs: now, nextMajor: nfp, timeframe: 'M5' }).state, 'ok');
  assert.equal(gate({ nowMs: now, nextMajor: { ...nfp, ts: now + 61 * 60000 }, timeframe: 'M15' }).state, 'ok');
});
test('bitcoin is analysed at any hour: its quiet hours do not stop it (user request, 4 Oct)', () => {
  const g = gate({ pair: 'BTCUSD', band: 'dead', insideWindow: true });
  assert.equal(g.allowed, true); assert.equal(g.state, 'ok');
});
test('bitcoin outside the trading window is allowed, asking only for the spread', () => {
  const g = gate({ pair: 'BTCUSD', band: 'red', insideWindow: false });
  assert.equal(g.allowed, true); assert.equal(g.needsSpread, true);
});
test('for bitcoin a release blackout is a warning, not a block', () => {
  const g = gate({ pair: 'BTCUSD', blackout: { active: true, phase: 'before', event: { name: 'Non-Farm Payrolls' }, endsAtMs: Date.UTC(2026, 6, 2, 13, 0) } });
  assert.equal(g.allowed, true); assert.equal(g.state, 'caution'); assert.equal(g.needsSpread, true);
  assert.match(g.message, /Non-Farm Payrolls/); assert.match(g.message, /slip/);
});
test("but a closed broker market still stops bitcoin: MT5 cannot take the order", () => {
  assert.equal(gate({ pair: 'BTCUSD', marketOpen: false }).allowed, false);
});
test('gold keeps its rules: blackout and dead zone still stop it', () => {
  assert.equal(gate({ band: 'dead' }).state, 'stand-down');
  assert.equal(gate({ blackout: { active: true, phase: 'after', event: { name: 'CPI' } } }).state, 'stand-aside');
});
test('inside the window in a good band, with nothing due, is simply allowed', () => {
  assert.equal(gate().state, 'ok');
});

console.log('\nthe check: what the model is not trusted to enforce on itself');

test('a clean, agreed market order passes, entered at the typed price', () => {
  const r = checkPlan(plan({ entry: 4391.25 }), three(), CTX);
  assert.equal(r.decision, 'buy');
  assert.equal(r.entry, 4391.2);
  assert.equal(r.stopLoss, 4386.5);
  assert.deepEqual(r.agreement, { agree: 3, of: 3, asked: 3 });
  assert.ok(r.netR >= 1);
});
test('a sell mirrors it', () => {
  const r = checkPlan(plan({ decision: 'sell', stop_loss: 4396, take_profit_1: 4384, take_profit_2: 4381 }), three({ view: 'sell' }), CTX);
  assert.equal(r.decision, 'sell');
});
test('no typed price, no trade — it is the one check that does not depend on pixels', () => {
  assert.ok(has(checkPlan(plan(), three(), { ...CTX, priceNow: null }), /not typed/));
});
test('a stop on the wrong side becomes No trade', () => {
  assert.ok(has(checkPlan(plan({ stop_loss: 4395 }), three(), CTX), /wrong side/));
});
test('a stop inside the floor (10× the cost, or half the minimum stop) becomes No trade', () => {
  const r = checkPlan(plan({ stop_loss: 4390.5, take_profit_1: 4393.5 }), three(), CTX);
  assert.ok(has(r, /needs at least 1\.24/));
});
test('the full cost, commission included, is charged on both sides of reward to risk', () => {
  // 1.5 : 1 on the spread alone, under 1 : 1 once commission is counted at a tight stop.
  const r = checkPlan(plan({ stop_loss: 4389.9, take_profit_1: 4392.7 }), three(), { ...CTX, cost: 0.9 });
  assert.equal(r.decision, 'no_trade');
});
test('a target that pays less than the risk after costs becomes No trade', () => {
  assert.ok(has(checkPlan(plan({ take_profit_1: 4394 }), three(), CTX), /needs at least 1×/));
});
test('a limit order is refused — the page builds market orders only', () => {
  assert.ok(has(checkPlan(plan({ entry_type: 'limit', entry: 4386 }), three(), CTX), /limit order/));
});
test('a plan built for an entry away from the price is refused', () => {
  assert.ok(has(checkPlan(plan({ entry: 4396 }), three(), CTX), /entry away/));
});
test('low confidence is No trade, not a weak trade', () => {
  assert.ok(has(checkPlan(plan({ confidence: 'low' }), three(), CTX), /low confidence/));
});
test('only one analyst agreeing is not enough', () => {
  const r = checkPlan(plan(), [reading(), reading({ view: 'sell' }), reading({ view: 'none' })], CTX);
  assert.ok(has(r, /Only 1 of 3 analysts agreed with the idea/));
});
test('an analyst that never answered still counts in "of 3"', () => {
  const r = checkPlan(plan(), [reading(), reading()], CTX);
  assert.equal(r.decision, 'buy');
  assert.deepEqual(r.agreement, { agree: 2, of: 2, asked: 3 });
});
test('a chart that shows a different price from the typed one is refused', () => {
  const r = checkPlan(plan(), three({ price_now: 4401 }), CTX);
  assert.ok(has(r, /different price from the one you typed/));
});
test('analysts agreeing on a misread scale do not get through (the price must match)', () => {
  const rs = three({ price_now: 4391.2 }).map((x, i) => (i ? { ...x, price_now: 4420 } : x));
  assert.ok(has(checkPlan(plan({ price_now: 4420 }), rs, CTX), /different price/));
});
test('a chart of the other instrument is refused', () => {
  assert.ok(has(checkPlan(plan({ instrument_seen: 'BTCUSD' }), three({ instrument_seen: 'BTCUSD' }), CTX), /instrument selected/));
});
test('a chart on another timeframe is refused', () => {
  assert.ok(has(checkPlan(plan({ timeframe_seen: 'M1' }), three({ timeframe_seen: 'M1' }), CTX), /not on M5/));
});
test('an unread price scale is refused rather than skipping the chart check', () => {
  const blank = { axis_low: null, axis_high: null };
  assert.ok(has(checkPlan(plan(blank), three(blank), CTX), /price scale could not be read/));
});
test('a level outside the visible chart is refused', () => {
  assert.ok(has(checkPlan(plan({ stop_loss: 4360, take_profit_1: 4440 }), three(), CTX), /outside the part of the chart/));
});
test('take profit 2 is dropped, not shown, if it is off the chart or not beyond take profit 1', () => {
  assert.equal(checkPlan(plan({ take_profit_2: 4450 }), three(), CTX).takeProfit2, null);
  assert.equal(checkPlan(plan({ take_profit_2: 4397 }), three(), CTX).takeProfit2, null);
  assert.equal(checkPlan(plan({ take_profit_2: null }), three(), CTX).decision, 'buy');
});
test("a rejected idea's direction, summary and reasons are not passed on", () => {
  const r = checkPlan(plan({ stop_loss: 4395 }), three(), CTX);
  assert.equal(r.decision, 'no_trade'); assert.equal(r.rejected, true);
  assert.equal(r.summary, ''); assert.deepEqual(r.reasons, []); assert.equal(r.invalidatedIf, '');
  assert.ok(!r.problems.some((p) => /\bbuy\b/i.test(p)), 'no problem text names the direction');
});
test('an honest No trade passes straight through', () => {
  const r = checkPlan(plan({ decision: 'no_trade', stop_loss: null, take_profit_1: null }), three({ view: 'none' }), CTX);
  assert.equal(r.decision, 'no_trade'); assert.deepEqual(r.problems, []);
});
test('anything that is not buy or sell is No trade', () => {
  assert.equal(checkPlan(plan({ decision: 'strong buy' }), three(), CTX).decision, 'no_trade');
  assert.equal(checkPlan(null, [], CTX).decision, 'no_trade');
});
test('the fast mode (one reader) still gets every price and chart rule', () => {
  const F = { ...CTX, asked: 0 };
  assert.equal(checkPlan(plan(), [], F).decision, 'buy');
  assert.equal(checkPlan(plan(), [], F).agreement, null);
  assert.ok(has(checkPlan(plan({ instrument_seen: 'BTCUSD' }), [], F), /instrument selected/));
  assert.ok(has(checkPlan(plan({ price_now: 4401 }), [], F), /different price/));
});
test('the final stretch marks confidence down and never hides the idea (decision 1)', () => {
  const r = checkPlan(plan({ confidence: 'high' }), three(), { ...CTX, lastStretch: true });
  assert.equal(r.decision, 'buy'); assert.equal(r.confidence, 'moderate');
});

console.log('\nwhat the readers are told');

const C = {
  pair: 'BTCUSD', digits: 2, priceNow: 84400, nowText: '21:22', weekday: 'Sunday', chartClock: '23:22',
  sessionName: 'Weekend', spread: '6.00', spreadSource: 'typed in just now', commission: 0, cost: '6.00',
  stopFloor: '63.30', news: [], caution: 'Weekend: thin liquidity.', planSetups: [], tradesTaken: 0, maxTrades: 0,
};

test('every prompt carries the typed price, the cost, the stop floor, the chart clock and the caution', () => {
  for (const p of [analystPrompt(LENSES[0], C), headPrompt([reading()], C), fastPrompt(C)]) {
    for (const s of ['BTCUSD', '84400', '6.00', '63.30', '23:22', 'thin liquidity', 'BID', 'only one JSON object', 'market order']) {
      assert.ok(p.includes(s), `missing "${s}"`);
    }
    assert.match(p, /Never mention how much time is left/);
  }
});
test('the format examples are a "none" / "no_trade" shape, not a trade anyone could copy', () => {
  assert.match(analystPrompt(LENSES[0], C), /"view": "none"/);
  assert.match(headPrompt([reading()], C), /"decision": "no_trade"/);
  for (const p of [analystPrompt(LENSES[0], C), fastPrompt(C)]) assert.ok(!/4391|4386|4398/.test(p));
});
test('each analyst gets a different lens', () => {
  assert.equal(new Set(LENSES.map((l) => analystPrompt(l, C))).size, 3);
});
test('the head trader is told how many answered, and each reading keeps its own lens', () => {
  const p = headPrompt([{ ...reading(), lens: 'Levels and liquidity' }, { ...reading({ view: 'sell' }), lens: 'Momentum and risk' }], C);
  assert.match(p, /2 analysts independently/);
  assert.match(p, /Analyst 1 \(Levels and liquidity\)/);
  assert.match(p, /Analyst 2 \(Momentum and risk\)/);
  assert.ok(!/"lens"/.test(p), 'the label is not repeated inside the JSON');
});
test('commission is named when there is some', () => {
  assert.ok(contextLines({ ...C, commission: '0.074', cost: '0.124' }).some((l) => /commission worth about 0\.074/.test(l)));
});

console.log('\nthe chat route, for views that cannot attach a picture');

test('the chat prompt carries the same context and rules, and asks for JSON only', () => {
  const p = chatPrompt(C);
  for (const s of ['BTCUSD', '84400', '63.30', 'market order', 'ONLY one JSON object', '"decision": "no_trade"']) assert.ok(p.includes(s), `missing "${s}"`);
});
test('a pasted reply is read whether bare, fenced or wrapped in a sentence', () => {
  assert.deepEqual(parseReply('{"decision":"buy"}'), { decision: 'buy' });
  assert.deepEqual(parseReply('Here it is:\n```json\n{"decision":"sell"}\n```'), { decision: 'sell' });
  assert.deepEqual(parseReply('Sure. {"decision":"no_trade"} Good luck.'), { decision: 'no_trade' });
  assert.equal(parseReply('I cannot read this chart.'), null);
  assert.equal(parseReply(''), null);
});
test('a pasted plan gets every check a page analysis gets', () => {
  const F = { ...CTX, asked: 0 };
  assert.equal(checkPlan(parseReply(JSON.stringify(plan())), [], F).decision, 'buy');
  assert.equal(checkPlan(parseReply(JSON.stringify(plan({ stop_loss: 4395 }))), [], F).decision, 'no_trade');
});

console.log('\nthe chart timeframe (M15 by default from 11 Oct 2026; M5 kept)');

const M15 = { ...CTX, timeframe: 'M15' };
test('M15 is the default, and only M5 and M15 are offered', () => {
  assert.equal(DEFAULT_TIMEFRAME, 'M15');
  assert.deepEqual(Object.keys(TIMEFRAMES).sort(), ['M15', 'M5']);
  assert.equal(tfInfo(undefined).id, 'M15'); assert.equal(tfInfo('nonsense').id, 'M15');
});
test('a timeframe is understood however it is typed, and nothing else is', () => {
  for (const x of ['M15', 'm15', '15', '15m', '15 min', ' M15 ', '15 minutes']) assert.equal(timeframeOf(x), 'M15', x);
  for (const x of ['M5', 'm5', '5', '5m', '5 min']) assert.equal(timeframeOf(x), 'M5', x);
  for (const x of ['H1', 'M1', 'M30', 'M50', '', null, undefined, true, 'fast']) assert.equal(timeframeOf(x), null, String(x));
});
test('a timeframe as printed on the chart is matched by its own number, never by a digit inside another', () => {
  for (const x of ['M15', 'XAUUSD, M15', 'XAUUSD,M15', '15m', '15 min', '15-minute', 'fifteen-minute', 'Fifteen minutes']) assert.ok(seesTimeframe(x, 'M15'), x);
  for (const x of ['M5', 'M1', 'H1', 'M30', 'M150', '5m', 'XAUUSD, M5']) assert.ok(!seesTimeframe(x, 'M15'), x);
  for (const x of ['M5', 'XAUUSD, M5', '5m', '5 min', 'five-minute']) assert.ok(seesTimeframe(x, 'M5'), x);
  for (const x of ['M15', '15m', 'XAUUSD, M15', 'M50', 'H1']) assert.ok(!seesTimeframe(x, 'M5'), x);
  for (const x of [null, '', '<as printed on the chart, e.g. H1>']) assert.ok(seesTimeframe(x, 'M15'), 'unknown is not held against it');
});
test('on M15 an M15 chart passes; an M5 chart is turned down, with the switch offered', () => {
  const ok = checkPlan(plan({ timeframe_seen: 'M15' }), three({ timeframe_seen: 'M15' }), M15);
  assert.equal(ok.decision, 'buy');
  const r = checkPlan(plan(), three(), M15);
  assert.ok(has(r, /not on M15\. Switch MT5 to the fifteen-minute chart/));
  assert.ok(has(r, /set Chart timeframe to M5 in Setup/));
  assert.ok(has(checkPlan(plan(), three(), { ...CTX, timeframe: undefined }), /not on M15/), 'M15 when none is given');
});
test('on M5 an M15 chart is turned down the same way; an H1 chart is turned down with no switch offered', () => {
  const r = checkPlan(plan({ timeframe_seen: 'M15' }), three({ timeframe_seen: 'M15' }), CTX);
  assert.ok(has(r, /not on M5/)); assert.ok(has(r, /Chart timeframe to M15/));
  const h = checkPlan(plan({ timeframe_seen: 'H1' }), three({ timeframe_seen: 'H1' }), M15);
  assert.ok(has(h, /not on M15/)); assert.ok(!has(h, /Chart timeframe to/));
});
test('one reader on the wrong timeframe out of three does not sink it; two do', () => {
  const rs = [reading({ timeframe_seen: 'M15' }), reading({ timeframe_seen: 'M15' }), reading()];
  assert.equal(checkPlan(plan({ timeframe_seen: 'M15' }), rs, M15).decision, 'buy');
  assert.equal(otherTimeframeSeen(['M5', 'M15', null], 'M15', 2), null);
  assert.equal(otherTimeframeSeen(['M5', 'XAUUSD, M5', null], 'M15', 2), 'M5');
});
test('a stop that clears M5 noise but not M15 noise is turned down on M15, and says why', () => {
  // 1.60 from 4,391.20: over M5's 1.24 floor, under M15's 1.90.
  const p = { timeframe_seen: 'M15', stop_loss: 4389.6, take_profit_1: 4393.5 };
  assert.equal(checkPlan(plan({ ...p, timeframe_seen: 'M5' }), three({ timeframe_seen: 'M5' }), CTX).decision, 'buy');
  const r = checkPlan(plan(p), three({ timeframe_seen: 'M15' }), M15);
  assert.ok(has(r, /needs at least 1\.90 to clear the costs and ordinary fifteen-minute noise/));
});
test('the readers are told the timeframe, its noise, its news window and its staleness — and not the other one', () => {
  const c15 = { ...C, tf: 'M15', news: ['NFP at 13:30 London'] };
  for (const p of [analystPrompt(LENSES[0], c15), headPrompt([reading({ timeframe_seen: 'M15' })], c15), fastPrompt(c15), chatPrompt(c15)]) {
    for (const s of ['M15 (fifteen-minute candles)', 'ordinary fifteen-minute noise', 'next 3 hours', 'within 60 minutes']) assert.ok(p.includes(s), `missing "${s}"`);
    assert.ok(!/five-minute|\bM5\b/.test(p), 'no M5 wording on M15');
  }
  assert.match(analystPrompt(LENSES[0], c15), /timeframe is not M15/);
  assert.match(analystPrompt(LENSES[0], c15), /more than 30 minutes before the chart clock/);
  const c5 = { ...C, tf: 'M5', news: ['NFP at 13:30 London'] };
  const p5 = analystPrompt(LENSES[0], c5);
  for (const s of ['M5 (five-minute candles)', 'ordinary five-minute noise', 'next 90 minutes', 'within 30 minutes', 'timeframe is not M5', 'more than 15 minutes before']) assert.ok(p5.includes(s), `missing "${s}"`);
  assert.ok(!/fifteen-minute|\bM15\b/.test(p5));
  assert.match(contextLines({ ...C, tf: 'M15' }).join('\n'), /No scheduled releases in the next 3 hours/);
});
test('the format examples do not suggest the timeframe the trader expects', () => {
  for (const tf of ['M5', 'M15']) {
    for (const p of [analystPrompt(LENSES[0], { ...C, tf }), headPrompt([], { ...C, tf }), fastPrompt({ ...C, tf })]) {
      assert.ok(!/"timeframe_seen": "[^"]*\bM1?5\b/.test(p), `${tf}: the example names M5 or M15`);
    }
  }
});

console.log('\nodds and ends');

test('the stop floor is the larger of 10× the cost and half the minimum stop', () => {
  assert.equal(stopFloor(0.124, 4391.2, 0.0005, 'M5'), 1.24);
  assert.equal(+stopFloor(6, 84400, 0.0015, 'M5').toFixed(2), 63.3);
});
test('on M15 the noise part grows by √3, the cost part does not', () => {
  assert.equal(+stopFloor(0.124, 4391.2, 0.0005, 'M15').toFixed(2), 1.9);     // was 1.24, cost-bound
  assert.equal(+stopFloor(6, 84400, 0.0015, 'M15').toFixed(2), 109.64);      // was 63.30
  assert.equal(stopFloor(1, 4391.2, 0.0005, 'M15'), 10, 'a dear trade is still cost-bound');
  assert.equal(stopFloor(0.124, 4391.2, 0.0005), stopFloor(0.124, 4391.2, 0.0005, 'M15'), 'M15 is the default');
});
test('symbol names are matched loosely, and an unreadable one is not held against it', () => {
  assert.ok(seesInstrument('XAUUSD.r', 'XAUUSD')); assert.ok(seesInstrument('GOLD', 'XAUUSD'));
  assert.ok(seesInstrument('BTCUSD', 'BTCUSD')); assert.ok(!seesInstrument('BTCUSD', 'XAUUSD'));
  assert.ok(seesInstrument(null, 'XAUUSD')); assert.ok(seesInstrument('<symbol as printed>', 'XAUUSD'));
});
test('median ignores junk', () => {
  assert.equal(median([3, NaN, 1, 2]), 2); assert.equal(median([]), null);
});
test('an analysis is used for a ticket only while fresh, on the same instrument, and only for a trade', () => {
  const shot = { pair: 'XAUUSD', atMs: 0, result: { decision: 'buy' }, tf: 'M5' };
  assert.equal(shotIsFresh(shot, shotMaxAgeMs('M5') - 1, 'XAUUSD'), true);
  assert.equal(shotIsFresh(shot, shotMaxAgeMs('M5') + 1, 'XAUUSD'), false);
  assert.equal(shotIsFresh(shot, 1, 'BTCUSD'), false);
  assert.equal(shotIsFresh({ ...shot, result: { decision: 'no_trade' } }, 1, 'XAUUSD'), false);
});
test('fresh for 15 minutes on M5 and 30 on M15, by the analysis\'s own timeframe', () => {
  assert.equal(shotMaxAgeMs('M5'), 15 * 60000);
  assert.equal(shotMaxAgeMs('M15'), 30 * 60000);
  const shot = { pair: 'XAUUSD', atMs: 0, result: { decision: 'buy' } };
  assert.equal(shotIsFresh({ ...shot, tf: 'M15' }, 20 * 60000, 'XAUUSD'), true);
  assert.equal(shotIsFresh({ ...shot, tf: 'M5' }, 20 * 60000, 'XAUUSD'), false);
  assert.equal(shotIsFresh({ ...shot, tf: 'M15' }, 31 * 60000, 'XAUUSD'), false);
});

console.log('\nhow the decision is written');
test('"Buy", "long", "SELL" and "short" are checked like buy and sell', () => {
  for (const d of ['Buy', ' BUY ', 'long']) assert.equal(checkPlan(plan({ decision: d }), three(), CTX).decision, 'buy', d);
  for (const d of ['SELL', 'short']) {
    const r = checkPlan(plan({ decision: d, stop_loss: 4396, take_profit_1: 4384, take_profit_2: null }), three({ view: d, stop_loss: 4396, take_profit_1: 4384 }), CTX);
    assert.equal(r.decision, 'sell', d);
  }
});
test('an unrecognised decision is rejected with its summary and reasons withheld', () => {
  for (const d of ['hold', 'wait', '', undefined, 'buy now']) {
    const r = checkPlan(plan({ decision: d }), three(), CTX);
    assert.equal(r.decision, 'no_trade'); assert.equal(r.rejected, true, String(d));
    assert.equal(r.summary, ''); assert.deepEqual(r.reasons, []);
  }
  const ok = checkPlan(plan({ decision: 'No trade', summary: 'Mid-range.' }), [], { ...CTX, asked: 0 });
  assert.equal(ok.rejected, undefined); assert.equal(ok.summary, 'Mid-range.');
});
test('analyst views written as "Buy" still count towards agreement; "Moderate" is moderate', () => {
  const r = checkPlan(plan({ confidence: 'Moderate' }), [reading({ view: 'Buy' }), reading({ view: 'long' }), reading({ view: 'none' })], CTX);
  assert.equal(r.decision, 'buy'); assert.equal(r.agreement.agree, 2); assert.equal(r.confidence, 'moderate');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
