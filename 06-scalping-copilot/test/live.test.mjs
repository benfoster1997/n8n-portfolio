/**
 * The watcher (desk/live.mjs): live bars through the same engine, gate and
 * checks, and the replies it sends. Bars are real: ten days of Binance
 * BTCUSDT fifteen-minute candles recorded on 11 Oct 2026
 * (fixtures/btc-m15.json), so the engine sees market shapes, not invented
 * ones. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  liveRead, shouldAlert, ideaRecord, formatLiveIdea, formatLiveNone, takeIdea, nextPollMs, inWatchHours,
  clearPathTarget, toPlan, COOLDOWN_BARS, stillRunning, alertState, minHistory,
} from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { closedBars, loadBars } from '../src/data-feeds.js';
import { resample, relativeVolume } from '../src/indicators.js';
import { analyse } from '../src/signal-engine.js';
import { stopFloor, checkPlan } from '../src/shot.js';
import { INSTRUMENTS } from '../src/instruments.js';

let passed = 0, failed = 0;
const pending = [];
const test = (n, fn) => {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok   ' + n); }
    catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  };
  pending.push(run);
};

const here = dirname(fileURLToPath(import.meta.url));
const DESK = join(here, '..', 'desk', 'desk.mjs');
const REPLAY = join(here, '..', 'desk', 'replay.mjs');
const F = JSON.parse(readFileSync(join(here, 'fixtures', 'btc-m15.json'), 'utf8'));
const BARS = F.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const M15 = 15 * 60000;
const cfg = withDefaults({});
const at = (k) => BARS[k].t + M15 + 20000;            // 20 s after bar k closes
const upTo = (k) => BARS.slice(0, k + 1);
// Bar 581 closes Wednesday 7 Oct 13:15 UTC (14:15 London): an idea on a clear-path rule.
const IDEA_K = 581;
const CLOSE_TALK = /(left|remaining) in (your|the) (session|window)|until (the )?close|to the close|minutes left|before 16:00/i;
const DIRECTION = /\b(buy|sell|long|short|lean|leaning|up|down|upward|downward)\b|▲|▼/i;

console.log('\nwhen to look');
test('the next poll is 20 seconds after the next bar closes', () => {
  assert.equal(nextPollMs(Date.UTC(2026, 9, 5, 13, 31, 10), 'M15'), Date.UTC(2026, 9, 5, 13, 45, 20));
  assert.equal(nextPollMs(Date.UTC(2026, 9, 5, 13, 45, 0), 'M15'), Date.UTC(2026, 9, 5, 14, 0, 20));
  assert.equal(nextPollMs(Date.UTC(2026, 9, 5, 13, 31, 10), 'M5'), Date.UTC(2026, 9, 5, 13, 35, 20));
});
test('it watches the user\'s window on weekdays only, unless told any time', () => {
  assert.equal(inWatchHours(Date.UTC(2026, 9, 5, 9, 0), cfg), true);       // Monday 10:00 London
  assert.equal(inWatchHours(Date.UTC(2026, 9, 5, 16, 0), cfg), false);     // Monday 17:00 London
  assert.equal(inWatchHours(Date.UTC(2026, 9, 10, 12, 0), cfg), false);    // Saturday
  assert.equal(inWatchHours(Date.UTC(2026, 9, 10, 12, 0), cfg, true), true);
});

console.log('\nthe bars');
test('the bar still forming is dropped; one that has just closed is kept', () => {
  const t = BARS[100].t;
  assert.equal(closedBars(BARS.slice(0, 101), 15, t + M15 - 1).length, 100);
  assert.equal(closedBars(BARS.slice(0, 101), 15, t + M15).length, 101);
});
test('fifteen-minute bars make complete hours and four-hours, with the half-built one dropped', () => {
  const h1 = resample(BARS.slice(0, 401), 60, true, 15);
  assert.ok(h1.slice(1).every((b) => b.count === 4), 'every H1 bar after the first (the fixture starts at :45) has its four M15 bars');
  assert.equal(h1.length, 101, 'one partial first hour, then 100 whole ones');
  assert.equal(resample(BARS.slice(0, 401), 60, true).length < h1.length, true, 'treated as M5, they would never make a whole hour');
});
test('every feed asks for the bar length it is given', async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: false, status: 418, json: async () => ({}) }; };
  try {
    await loadBars('BTCUSD', { minutes: 15 });
    await loadBars('XAUUSD', { minutes: 15, keys: { twelvedata: 'k', alphavantage: 'k' }, allowProxy: true });
  } finally { globalThis.fetch = real; }
  for (const [host, want] of [['binance.vision', 'interval=15m'], ['coinbase', 'granularity=900'], ['kraken.com/0/public/OHLC?pair=XBTUSD', 'interval=15'],
    ['okx', 'bar=15m'], ['bitstamp', 'step=900'], ['twelvedata', 'interval=15min'], ['alphavantage', 'interval=15min'], ['PAXGUSD', 'interval=15']]) {
    const u = seen.find((x) => x.includes(host));
    assert.ok(u && u.includes(want), `${host}: ${u}`);
  }
  assert.ok(seen.find((x) => x.includes('twelvedata')).includes('timezone=UTC'), 'Twelve Data asked for UTC times');
});

console.log('\nthe engine on M15');
test('on M15 the bias comes from H1 and H4, and the page\'s M5 keeps M15 and H1', () => {
  const a = analyse({ bars: upTo(800).slice(-300), htfBars: upTo(800), instrument: INSTRUMENTS.BTCUSD, spread: 6, timeframe: 'M15' });
  assert.deepEqual(a.htf.ids, ['H1', 'H4']);
  assert.ok(a.htf.h4 && a.htf.h4.closedBars >= 30, 'the longer history gives H4 its 30 bars');
  const b = analyse({ bars: upTo(800).slice(-300), instrument: INSTRUMENTS.BTCUSD, spread: 6 });
  assert.deepEqual(b.htf.ids, ['M15', 'H1']);
});
test('a stop the engine proposes on M15 always clears the floor the desk checks it against', () => {
  for (let k = 420; k < BARS.length; k += 7) {
    const a = analyse({ bars: upTo(k).slice(-300), htfBars: upTo(k), instrument: INSTRUMENTS.BTCUSD, spread: 6, timeframe: 'M15' });
    if (a.stopDistance) assert.ok(a.stopDistance >= 0.5 * INSTRUMENTS.BTCUSD.minStopPct * a.price * Math.sqrt(3) - 1e-9, `bar ${k}: ${a.stopDistance}`);
  }
});

console.log('\none read');
test('Sunday night: bitcoin is open but the watcher stays quiet — it cannot see the weekend spread', () => {
  const r = liveRead({ pair: 'BTCUSD', bars: BARS, nowMs: at(BARS.length - 1), cfg });
  assert.equal(r.kind, 'blocked'); assert.equal(r.spreadUnknown, true);
  const t = formatLiveNone(r, cfg);
  assert.match(t, /cannot see the spread/); assert.doesNotMatch(t, /send me today's spread/);
});
test('gold in its quiet hours is stood down before the engine is asked', () => {
  const r = liveRead({ pair: 'XAUUSD', bars: BARS, nowMs: Date.UTC(2026, 9, 7, 9, 30, 20), cfg });   // shapes only: gold's own bars are not needed to be refused
  assert.ok(['blocked', 'stale'].includes(r.kind));
  const g = liveRead({ pair: 'XAUUSD', bars: upTo(560).map((b) => ({ ...b })), nowMs: at(560), cfg });
  assert.ok(g.kind === 'blocked' || g.kind !== 'idea');
});
test('a feed whose newest bar is old is not read', () => {
  const r = liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K), nowMs: at(IDEA_K) + 40 * 60000, cfg });
  assert.equal(r.kind, 'stale'); assert.match(formatLiveNone(r, cfg), /newest closed bar ended at/);
});
test('too few bars is said, not read', () => {
  assert.equal(liveRead({ pair: 'BTCUSD', bars: upTo(30), nowMs: at(30), cfg }).kind, 'no-data');
});
test('on these ten days the next-level rule passes nothing; the shipped 1.5R rule finds the Wednesday and Thursday ideas', () => {
  const count = (rule) => { let n = 0; for (let k = 500; k < BARS.length; k++) if (liveRead({ pair: 'BTCUSD', bars: upTo(k), nowMs: at(k), cfg, targetRule: rule }).kind === 'idea') n++; return n; };
  assert.equal(count('level'), 0);
  assert.equal(count(undefined), 7, 'the default is 1.5R, the user\'s choice');
});
test('a clear-path rule aims 1.5R or 2R only when no level stands in the way', () => {
  const a = { bias: 'long', price: 100, stopDistance: 10, targets: [{ price: 110 }], levels: [] };
  assert.equal(clearPathTarget(a, 'level')[0].price, 110);
  assert.equal(clearPathTarget(a, '1.5R')[0].price, 115);
  assert.equal(clearPathTarget({ ...a, bias: 'short', targets: [{ price: 90 }] }, '2R')[0].price, 80);
  const blocked = { ...a, levels: [{ price: 104 }], targets: [{ price: 104 }, { price: 110 }] };
  assert.equal(clearPathTarget(blocked, '2R')[0].price, 104, 'a level in the way is never skipped');
});
test('Wednesday 14:15 London: on the 1.5R clear-path rule a sell passes every check', () => {
  const r = liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K), nowMs: at(IDEA_K), cfg, targetRule: '1.5R', source: { id: 'test', label: 'test bars' } });
  assert.equal(r.kind, 'idea'); assert.equal(r.result.decision, 'sell');
  assert.ok(r.result.netR >= 1);
  assert.ok(r.result.stopDistance >= stopFloor(r.cost, r.price, INSTRUMENTS.BTCUSD.minStopPct, 'M15'));
  // The same moment on the next-level rule: the 1R fallback cannot pay after costs.
  const same = liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K), nowMs: at(IDEA_K), cfg, targetRule: 'level' });
  assert.equal(same.kind, 'rejected'); assert.ok(same.result.problems.some((p) => /needs at least 1×/.test(p)));
  assert.doesNotMatch(formatLiveNone(same, cfg), DIRECTION, 'a rejected idea\'s direction is never shown');
});
test('a plan from the engine is checked like a screenshot\'s, with its own bars as the chart', () => {
  const r = liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K), nowMs: at(IDEA_K), cfg, targetRule: '1.5R' });
  const p = toPlan(r.analysis, 'BTCUSD', upTo(IDEA_K).slice(-300), 'M15', '1.5R');
  assert.equal(p.timeframe_seen, 'M15'); assert.equal(p.decision, 'sell');
  assert.ok(p.axis_low <= p.take_profit_1 && p.axis_high >= p.stop_loss);
});

console.log('\nalerts');
const idea = () => liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K), nowMs: at(IDEA_K), cfg, targetRule: '1.5R', source: { id: 'test', label: 'test bars' } });
test('one alert per side per hour, and never two for the same bar', () => {
  const r = idea();
  assert.equal(shouldAlert({ lastAlert: {} }, r), true);
  const st = { lastAlert: { BTCUSD: { side: 'sell', barCloseMs: r.barCloseMs } } };
  assert.equal(shouldAlert(st, r), false);
  const later = (bars) => ({ ...r, barCloseMs: r.barCloseMs + bars * M15 });
  assert.equal(shouldAlert(st, later(COOLDOWN_BARS - 1)), false);
  assert.equal(shouldAlert(st, later(COOLDOWN_BARS)), true);
  assert.equal(shouldAlert({ lastAlert: { BTCUSD: { side: 'buy', barCloseMs: r.barCloseMs - M15 } } }, r), true, 'the other side is a new idea');
});
test('the alert gives distances from the user\'s own entry, a volume, and how to get the ticket', () => {
  const rec = ideaRecord(idea());
  const t = formatLiveIdea(rec, cfg, rec.barCloseMs + 20000);
  assert.match(t, /▼ Sell idea · Bitcoin · live M15 chart/);
  assert.match(t, /Stop loss \*\*[\d,.]+ above\*\* your entry/);
  assert.match(t, /Take profit \*\*[\d,.]+ below\*\*/);
  assert.match(t, /Volume \*\*[\d,.]+\*\* lots/);
  assert.match(t, /send me your MT5 price now/);
  assert.match(t, /not your broker's price/);
  assert.match(t, /good until 14:30 London/);
  assert.doesNotMatch(t, CLOSE_TALK);
});

console.log('\ntaking it');
const rec0 = () => ideaRecord(idea());
const live = BARS[IDEA_K].c;
test('from the user\'s own price: the stop and target at the alert\'s distances, sized, checked', () => {
  const rec = rec0();
  const r = takeIdea({ rec, priceNow: live + 40, livePrice: live, nowMs: rec.barCloseMs + 60000, cfg });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.result.stopLoss, +(live + 40 + rec.stopDist).toFixed(2));
  assert.equal(r.result.takeProfit1, +(live + 40 - rec.tp1Dist).toFixed(2));
  assert.match(r.text, /MT5 ticket — SELL BTCUSD/);
});
test('refused once the next bar has closed', () => {
  const rec = rec0();
  assert.match(takeIdea({ rec, priceNow: live, livePrice: live, nowMs: rec.validUntilMs + 1, cfg }).text, /ran out at/);
});
test('refused when the feed has moved more than a quarter of the stop', () => {
  const rec = rec0();
  const r = takeIdea({ rec, priceNow: live, livePrice: live + rec.stopDist * 0.3, nowMs: rec.barCloseMs + 60000, cfg });
  assert.equal(r.ok, false); assert.match(r.text, /moved/);
});
test('refused when the typed price is nowhere near the live one (a typo, or gold\'s price)', () => {
  const rec = rec0();
  assert.match(takeIdea({ rec, priceNow: 4391.2, livePrice: live, nowMs: rec.barCloseMs + 60000, cfg }).text, /long way from the live bitcoin price/);
});
test('refused when the live price cannot be checked', () => {
  const rec = rec0();
  assert.match(takeIdea({ rec, priceNow: live, livePrice: null, nowMs: rec.barCloseMs + 60000, cfg }).text, /could not check the live price/);
});
test('a wide typed spread is charged, and can turn the idea down', () => {
  const rec = rec0();
  const r = takeIdea({ rec, priceNow: live, livePrice: live, nowMs: rec.barCloseMs + 60000, cfg, spreadNum: rec.stopDist / 2, typedSpread: true });
  assert.equal(r.ok, false); assert.match(r.text, /no longer passes/);
});
test('an alert from the final stretch is not marked down a second time when taken', () => {
  // Read at the 15:30 London close, taken at 15:40: both in the final stretch.
  const rec = { ...rec0(), lastStretch: true, confidence: 'moderate', barCloseMs: Date.UTC(2026, 9, 7, 14, 30), validUntilMs: Date.UTC(2026, 9, 7, 14, 45) };
  const r = takeIdea({ rec, priceNow: live, livePrice: live, nowMs: Date.UTC(2026, 9, 7, 14, 40), cfg });
  assert.equal(r.ok, true, r.text);
});

console.log('\nthe commands, end to end (no network: $SCALP_DESK_BARS)');
/**
 * A desk of its own: state in a temporary home, default settings, the test
 * feeds given (bitcoin's recorded bars unless told otherwise), the clock set.
 * Under $SCALP_DESK_NOW the watcher's waits move the clock on instead of
 * sleeping, so a whole morning of bar closes runs in a moment.
 */
function env(nowIso, feeds = { BTCUSD: BARS }) {
  const home = mkdtempSync(join(tmpdir(), 'live-'));
  const bars = join(home, 'bars.json');
  writeFileSync(bars, JSON.stringify(feeds));
  const config = join(home, 'config.json');
  writeFileSync(config, '{}');
  const e = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_CONFIG: config, SCALP_DESK_BARS: bars, SCALP_DESK_NOW: nowIso, TWELVEDATA_API_KEY: '' };
  const run = (args, cmd = DESK) => { try { return execFileSync('node', [cmd, ...args], { encoding: 'utf8', env: e }); } catch (x) { return `EXIT ${x.status}\n${x.stdout}`; } };
  const file = (f) => join(home, 'watch', f);
  const read = (f) => JSON.parse(readFileSync(file(f), 'utf8'));
  const put = (f, v) => { mkdirSync(join(home, 'watch'), { recursive: true }); writeFileSync(file(f), JSON.stringify(v)); };
  return { home, run, e, file, read, put };
}
const reply = (out) => (out.split('--- reply ---\n')[1] || '').split('\n--- end ---')[0];
test('scan on a Sunday night says why there is no idea, and names no direction', () => {
  const d = env('2026-10-11T21:30:20Z');
  const out = d.run(['scan', '--pair', 'bitcoin']);
  assert.match(out, /STATUS: info/); assert.match(reply(out), /No idea · Bitcoin/);
  assert.doesNotMatch(reply(out), DIRECTION);
  assert.equal(existsSync(d.file('ideas.json')), false, 'a scan with no idea writes nothing, so it cannot undo the watcher\'s alerts');
});
test('watch outside the window stops at once, and says so to the session only', () => {
  const d = env('2026-10-11T21:30:20Z');
  const out = d.run(['watch', '--once']);
  assert.match(out, /STATUS: stopped/); assert.doesNotMatch(out, /--- reply ---/);
  assert.match(out, /gold is not watched — no Twelve Data key/);
});
test('watch --once at any hour polls bitcoin and stays quiet when nothing passes', () => {
  const d = env('2026-10-11T21:30:20Z');
  const out = d.run(['watch', '--once', '--anytime', '--pair', 'bitcoin']);
  assert.match(out, /STATUS: quiet/); assert.match(out, /BTCUSD blocked/);
});
test('watch --stop with nothing running says so', () => {
  assert.match(env('2026-10-11T21:30:20Z').run(['watch', '--stop']), /I was not watching/);
});
test('take with no alert asks for one; take from a stored alert builds the ticket, or refuses a moved one', () => {
  const d = env('2026-10-07T13:16:00Z');
  assert.match(d.run(['take', '--price', '84000']), /no live idea to take/);
  const last = BARS[BARS.length - 1].c;   // the test feed's "live" price is its newest bar
  mkdirSync(join(d.home, 'watch'), { recursive: true });
  const store = (refPrice) => writeFileSync(join(d.home, 'watch', 'ideas.json'), JSON.stringify({ BTCUSD: { ...rec0(), sourceId: 'test', refPrice } }));
  store(last);
  const ok = d.run(['take', '--price', String(last + 25)]);
  assert.match(ok, /STATUS: done · ticket/); assert.match(reply(ok), /MT5 ticket — SELL BTCUSD/);
  assert.match(reply(ok), /Too big for one order/, 'the demo balance still says to set a shadow balance');
  store(last + rec0().stopDist);
  const moved = d.run(['take', '--price', String(last)]);
  assert.match(moved, /STATUS: refused/); assert.match(reply(moved), /moved/);
});

/* -----------------------------------------------------------------------------
 * What the independent review of the watcher found (11 Oct 2026), one by one.
 * Each test fails on the code as it was before the fix.
 * -------------------------------------------------------------------------- */

const SRC = { id: 'test', label: 'test bars' };
const read = (k, pair = 'BTCUSD', bars = BARS) => liveRead({ pair, bars: bars.slice(0, k + 1), nowMs: at(k), cfg, source: SRC });
// Bitcoin's recorded shapes at gold's price: enough for the commands' plumbing
// (which feed, which alert), never a claim about how gold trades.
const GOLD_SCALE = 4391 / 83000;
const GOLD = BARS.map((b) => ({ ...b, o: b.o * GOLD_SCALE, h: b.h * GOLD_SCALE, l: b.l * GOLD_SCALE, c: b.c * GOLD_SCALE }));
const goldRec = () => ideaRecord(read(IDEA_K, 'XAUUSD', GOLD));

console.log('\nthe final stretch is marked down once');
// Bar 586 closes Wednesday 7 Oct 14:30 UTC: 15:30 London, the first close of the final stretch.
const LAST_K = 586;
test('a real 15:30 alert is marked down by the engine alone, so it can still be taken', () => {
  const r = read(LAST_K);
  assert.equal(r.kind, 'idea'); assert.equal(r.result.confidence, 'moderate');
  assert.ok(r.analysis.whyNot.some((w) => /final stretch/.test(w)), 'the engine applied its own mark-down');
  const rec = ideaRecord(r);
  assert.equal(rec.lastStretch, true);
  const t = formatLiveIdea(rec, cfg, rec.barCloseMs + 20000);
  assert.match(t, /Final stretch — confidence is marked down/); assert.doesNotMatch(t, CLOSE_TALK);
  const take = (confidence) => takeIdea({ rec: { ...rec, confidence }, priceNow: BARS[LAST_K].c + 20, livePrice: BARS[LAST_K].c, nowMs: rec.barCloseMs + 60000, cfg });
  const taken = take(rec.confidence);
  assert.equal(taken.ok, true, taken.text); assert.match(taken.text, /MT5 ticket — SELL BTCUSD/);
  // checkPlan's own step-down is for screenshots. Applied on top, the alert went out as
  // "low", and take, which turns a low idea down, refused it.
  const twice = checkPlan(toPlan(r.analysis, 'BTCUSD', upTo(LAST_K).slice(-300), 'M15'), [], {
    priceNow: r.price, cost: r.cost, digits: 2, pair: 'BTCUSD', minStopPct: INSTRUMENTS.BTCUSD.minStopPct, asked: 0, lastStretch: true, timeframe: 'M15',
  });
  assert.equal(twice.confidence, 'low');
  const refused = take(twice.confidence);
  assert.equal(refused.ok, false); assert.match(refused.text, /low confidence/);
});

console.log('\nwatch before the window opens');
test('at 03:00 London it waits out its time limit for the open, instead of exiting at once to be restarted in a loop', () => {
  const d = env('2026-10-07T02:00:00Z');   // Wednesday, 03:00 London
  const out = d.run(['watch', '--pair', 'bitcoin']);
  assert.match(out, /STATUS: timeout/); assert.doesNotMatch(out, /--- reply ---/);
  assert.match(out, /has not opened yet; start the watch again \(no message to the user\)/);
  const s = d.read('status.json');
  assert.equal(s.polls, 0);
  assert.ok(s.endedAtMs - s.startedAtMs >= 1.85 * 3600e3, `it waited ${Math.round((s.endedAtMs - s.startedAtMs) / 60000)} minutes`);
  assert.equal(existsSync(d.file('watch.pid')), false, 'and it cleans up after itself');
});
test('from 07:00 London it sleeps until the open, then reads at each bar close', () => {
  const d = env('2026-10-07T06:00:00Z');   // Wednesday, 07:00 London
  const out = d.run(['watch', '--pair', 'bitcoin']);
  assert.match(out, /^WATCHING: Bitcoin on M15, in the window\.$/m);
  assert.match(out, /STATUS: timeout/);
  const s = d.read('status.json');
  assert.equal(s.polls, 4, 'reads at 08:00, 08:15, 08:30 and 08:45 London, then its time limit');
  assert.equal(s.last.BTCUSD.atMs, Date.parse('2026-10-07T07:45:20Z'));
});

console.log('\na feed that stops answering');
test('three failed polls of one feed drop only that instrument; the restart keeps watching the other', () => {
  const d = env('2026-10-11T21:30:20Z', { XAUUSD: GOLD, BTCUSD: [] });
  const out = d.run(['watch', '--anytime']);
  assert.match(out, /^WATCHING: Gold and Bitcoin on M15, at any hour\.$/m);
  assert.match(out, /STATUS: dropped/);
  assert.match(reply(out), /^The live bitcoin feed has stopped answering, so I have stopped watching bitcoin\. Still watching gold\.$/);
  assert.match(out, /^NOTE: send the reply, then start the watch again with: watch --pair gold$/m);
  assert.equal(d.read('status.json').polls, 3);
});
test('when the only instrument watched loses its feed, the watch ends with an error', () => {
  const d = env('2026-10-11T21:30:20Z', { BTCUSD: [] });
  const out = d.run(['watch', '--anytime']);
  assert.match(out, /STATUS: error/);
  assert.match(reply(out), /The live bitcoin feed has stopped answering, so I have stopped watching\. Send screenshots/);
});
test('an idea on the other instrument in the poll that drops a feed is sent, with the drop', () => {
  // Bitcoin's feed fails from 13:45 London; gold's third read, at 14:15, is a sell idea.
  const d = env('2026-10-07T12:45:20Z', { XAUUSD: GOLD, BTCUSD: [] });
  const out = d.run(['watch']);
  assert.match(out, /STATUS: alert/);
  assert.match(reply(out), /▼ Sell idea · Gold · live M15 chart/);
  assert.match(reply(out), /stopped watching bitcoin\. Still watching gold\.$/);
  assert.match(out, /^NOTE: send the reply, push a one-line notification, then start the watch again with: watch --pair gold$/m);
  assert.ok(d.read('ideas.json').XAUUSD, 'the gold alert is kept for take');
});

console.log('\nno new alert while the last one is still running');
const prev = () => alertState(rec0());   // the 14:15 London sell
test('the sells read at 15:15 and 15:30 London wait: the 14:15 alert\'s stop and target are both untouched', () => {
  for (const k of [585, 586]) {
    const r = read(k);
    const st = { lastAlert: { BTCUSD: prev() } };
    assert.equal(r.kind, 'idea');
    assert.equal(shouldAlert(st, r), true, `bar ${k}: the cooldown alone has passed`);
    assert.equal(stillRunning(prev(), upTo(k), r.nowMs, cfg, 6), true, `bar ${k}`);
    assert.equal(shouldAlert(st, r, upTo(k), cfg), false, `bar ${k}`);
  }
});
test('it has run its course once its stop or target is touched — a sell\'s on the ask', () => {
  const p = prev();
  const sl = p.refPrice + p.stopDist, tp = p.refPrice - p.tp1Dist;
  const t = BARS[587].t, nowMs = t + M15 + 20000, c = BARS[586].c;
  const with_ = (h, l) => [...upTo(586), { t, o: c, h, l, c, v: 1 }];
  assert.equal(stillRunning(p, with_(sl - 3, c - 50), nowMs, cfg, 0), true, 'the bid stayed $3 under the stop');
  assert.equal(stillRunning(p, with_(sl - 3, c - 50), nowMs, cfg, 6), false, 'the ask, $6 above it, reached it');
  assert.equal(stillRunning(p, with_(c + 50, tp - 5), nowMs, cfg, 6), true, 'the ask stayed $1 above the target');
  assert.equal(stillRunning(p, with_(c + 50, tp - 6), nowMs, cfg, 6), false, 'the ask reached the target');
  // A buy's levels are on the bid, and bars from before the alert do not count.
  const buy = { side: 'buy', barCloseMs: BARS[582].t, refPrice: 1000, stopDist: 10, tp1Dist: 15 };
  const one = (h, l, k = 582) => [{ t: BARS[k].t, o: 1000, h, l, c: 1000, v: 1 }];
  assert.equal(stillRunning(buy, one(1014, 991), nowMs, cfg, 6), true);
  assert.equal(stillRunning(buy, one(1014, 990), nowMs, cfg, 6), false, 'stop');
  assert.equal(stillRunning(buy, one(1015, 991), nowMs, cfg, 6), false, 'target');
  assert.equal(stillRunning(buy, one(1014, 980, 581), nowMs, cfg, 6), true, 'a bar before the alert');
});
test('and once its day\'s window has closed, whatever the price did', () => {
  assert.equal(stillRunning(prev(), upTo(588), Date.parse('2026-10-07T14:59:59Z'), cfg, 6), true);
  assert.equal(stillRunning(prev(), upTo(588), Date.parse('2026-10-07T15:00:00Z'), cfg, 6), false, '16:00 London');
});
test('a watch started just after the 14:15 alert sends nothing more that day; with no alert behind it, it alerts at once', () => {
  const d = env('2026-10-07T13:15:30Z');
  d.put('state.json', { lastAlert: { BTCUSD: prev() } });
  const out = d.run(['watch', '--pair', 'bitcoin']);
  assert.match(out, /STATUS: stopped/); assert.doesNotMatch(out, /--- reply ---/);
  assert.equal(d.read('status.json').polls, 7, 'every close from 14:15 to 15:45 London, then the window shut');
  const fresh = env('2026-10-07T13:15:30Z').run(['watch', '--pair', 'bitcoin']);
  assert.match(fresh, /STATUS: alert/); assert.match(reply(fresh), /▼ Sell idea · Bitcoin/);
});
test('the replay holds itself to the same rule, and gives its range clustered by day', () => {
  const d = env('2026-10-12T00:00:00Z');
  const out = d.run(['--pair', 'bitcoin', '--from', '2026-10-06', '--to', '2026-10-11T22:00', '--rule', '1.5R', '--list'], REPLAY);
  const trades = [...out.matchAll(/^ {3}(\S+) (buy|sell) \w+ netR [\d.]+ → \w+ (-?[\d.]+)R after \d+ bars$/gm)];
  assert.deepEqual(trades.map((m) => m[1]), ['2026-10-07T13:15', '2026-10-08T13:45'], 'not also 14:15 on the 7th: the 13:15 sell was still running');
  // The clustered range, recomputed by day from the listed trades (shown to 2 places).
  const rs = trades.map((m) => ({ day: m[1].slice(0, 10), r: Number(m[3]) }));
  const mean = rs.reduce((s, t) => s + t.r, 0) / rs.length;
  const byDay = new Map();
  for (const t of rs) byDay.set(t.day, (byDay.get(t.day) || 0) + t.r - mean);
  const se = Math.sqrt([...byDay.values()].reduce((s, x) => s + x * x, 0)) / rs.length;
  const m = out.match(/clustered by day: 95% range (-?[\d.]+) to (-?[\d.]+)/);
  assert.ok(m, out);
  assert.ok(Math.abs(Number(m[1]) - (mean - 1.96 * se)) < 0.02 && Math.abs(Number(m[2]) - (mean + 1.96 * se)) < 0.02, `${m[0]} vs ${(mean - 1.96 * se).toFixed(3)} to ${(mean + 1.96 * se).toFixed(3)}`);
});

console.log('\nrelative volume compares like with like');
test('a Monday is measured against earlier weekdays, and a Sunday against earlier weekends', () => {
  // Two weeks of fifteen-minute bars: 300 a bar on weekdays, 100 at weekends.
  const start = Date.UTC(2026, 8, 28);   // Monday 28 Sep
  const bars = [];
  for (let t = start; t < start + 15 * 86400e3; t += M15) {
    const dow = new Date(t).getUTCDay();
    bars.push({ t, o: 1, h: 1, l: 1, c: 1, v: dow === 0 || dow === 6 ? 100 : 300 });
  }
  const rv = relativeVolume(bars, 5);
  assert.equal(rv[bars.findIndex((b) => b.t === Date.UTC(2026, 9, 12, 9, 0))], 1, 'an ordinary Monday morning is 1.0x, not 1.4x');
  assert.equal(rv[bars.findIndex((b) => b.t === Date.UTC(2026, 9, 11, 9, 0))], 1, 'an ordinary Sunday is 1.0x, not 0.4x');
});
test('on the recorded bars: Monday 14:00 London against Thursday\'s and Friday\'s, not the weekend\'s', () => {
  const v = (day) => BARS.find((b) => b.t === Date.UTC(2026, 9, day, 13, 0)).v;
  const k = BARS.findIndex((b) => b.t === Date.UTC(2026, 9, 5, 13, 0));
  assert.ok(Math.abs(relativeVolume(BARS, 5)[k] - v(5) / ((v(1) + v(2)) / 2)) < 1e-12);
});
test('the engine takes the baseline from the longer history when it ends on the same bar', () => {
  // Saturday 21:45 London: the 300-bar window holds no earlier weekend; the longer history holds two.
  const k = 900;
  const engine = (htfBars) => analyse({ bars: upTo(k).slice(-300), htfBars, instrument: INSTRUMENTS.BTCUSD, spread: 6, timeframe: 'M15' });
  const long = engine(upTo(k)), alone = engine(undefined), offByOne = engine(upTo(k - 1));
  assert.equal(long.indicators.relVol.at(-1), relativeVolume(upTo(k), 5).at(-1));
  assert.ok(long.indicators.relVol.at(-1) > 0);
  assert.match(long.buckets.volume.reasons[0], new RegExp(`volume ${long.indicators.relVol.at(-1).toFixed(1)}x normal`));
  assert.equal(alone.indicators.relVol.at(-1), null, 'the window alone has no earlier weekend to compare with');
  assert.equal(offByOne.indicators.relVol.at(-1), null, 'a history ending on another bar is not used');
});

console.log('\na feed too short for the four-hour trend');
test('the watcher needs 30 bars of its higher bias timeframe, and some to spare', () => {
  assert.equal(minHistory('M15'), 500); assert.equal(minHistory('M5'), 380);
});
test('a source giving 300 bars is passed over for one that gives enough', async () => {
  const rows = (n) => BARS.slice(0, n);
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    u = String(u);
    const json = u.includes('binance.vision') ? rows(300).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v])
      : u.includes('coinbase') ? rows(300).map((b) => [b.t / 1000, b.l, b.h, b.o, b.c, b.v])
      : u.includes('kraken') ? { error: [], result: { XXBTZUSD: rows(720).map((b) => [b.t / 1000, b.o, b.h, b.l, b.c, 0, b.v, 1]), last: 0 } }
      : null;
    return json ? { ok: true, status: 200, json: async () => json } : { ok: false, status: 418, json: async () => ({}) };
  };
  let r, page;
  try {
    r = await loadBars('BTCUSD', { minutes: 15, limit: 1000, minBars: minHistory('M15') });
    page = await loadBars('BTCUSD', { minutes: 15, limit: 1000 });
  } finally { globalThis.fetch = real; }
  assert.equal(r.ok, true); assert.equal(r.source.id, 'kraken'); assert.equal(r.bars.length, 720);
  for (const id of ['binance-vision', 'coinbase']) assert.match(r.attempts.find((x) => x.id === id).reason, /returned only 300 bars; 500 needed/);
  assert.equal(page.source.id, 'binance-vision', 'the page, which asks for no minimum, still takes the first');
});
test('and 300 bars handed to the watcher are called too few, not read', () => {
  const r = liveRead({ pair: 'BTCUSD', bars: upTo(IDEA_K).slice(-300), nowMs: at(IDEA_K), cfg });
  assert.equal(r.kind, 'no-data'); assert.match(r.reason, /only 300 closed M15 bars from the feed, too few for the H4 trend/);
});

console.log('\nthe gold key');
test('watching gold without its key: how to add one, all in the reply, and nothing started', () => {
  const d = env('2026-10-07T09:00:20Z');
  const out = d.run(['watch', '--pair', 'gold']);
  assert.match(out, /STATUS: need-key/); assert.doesNotMatch(out, /WATCHING:/);
  const t = reply(out);
  assert.match(t, /free key from twelvedata\.com/);
  assert.match(t, /cloud environment settings \(title bar → environment → Edit\) as an environment variable named TWELVEDATA_API_KEY/);
  assert.match(t, /not in this chat/); assert.match(t, /start a new session/); assert.match(t, /Bitcoin needs nothing/);
  assert.doesNotMatch(t, /\b(above|below)\b/, 'it once pointed to instructions "above" that were not there');
  assert.equal(existsSync(d.file('watch.pid')), false);
  assert.equal(reply(d.run(['scan', '--pair', 'gold'])), t, 'a scan of gold says the same');
});

console.log('\ntake, and the alert files');
test('take picks the alert whose price the user typed, whichever was stored first', () => {
  const d = env('2026-10-07T13:16:00Z', { BTCUSD: BARS, XAUUSD: GOLD });
  // The test feeds' "live" price is their newest bar, so both alerts are put there.
  const btc = { ...rec0(), sourceId: 'test', refPrice: BARS.at(-1).c };
  const gold = { ...goldRec(), refPrice: GOLD.at(-1).c };
  assert.equal(btc.barCloseMs, gold.barCloseMs, 'read at the same close, so recency cannot decide');
  d.put('ideas.json', { XAUUSD: gold, BTCUSD: btc });
  assert.match(reply(d.run(['take', '--price', (btc.refPrice + 25).toFixed(2)])), /MT5 ticket — SELL BTCUSD/);
  d.put('ideas.json', { BTCUSD: btc, XAUUSD: gold });
  assert.match(reply(d.run(['take', '--price', (gold.refPrice + 0.2).toFixed(2)])), /MT5 ticket — SELL XAUUSD/);
});
test('a scan records its alert without undoing one the watcher stored while the scan waited for its feed', async () => {
  const d = env('2026-10-07T13:15:20Z');
  // The scan's feed is a pipe, so it waits there until this test writes the bars.
  const fifo = join(d.home, 'bars.fifo');
  execFileSync('mkfifo', [fifo]);
  const child = spawn('node', [DESK, 'scan', '--pair', 'bitcoin'], { env: { ...d.e, SCALP_DESK_BARS: fifo } });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((res) => child.on('close', res));
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  let fd = null;
  for (const until = Date.now() + 10000; fd === null;) {
    try { fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); } catch (e) {
      if (e.code !== 'ENXIO' || Date.now() > until) { child.kill(); throw new Error(`the scan never opened its feed (${e.code})`); }
      await pause(10);
    }
  }
  // The scan is waiting on its feed: meanwhile the watcher records a gold alert.
  const gold = goldRec();
  d.put('ideas.json', { XAUUSD: gold });
  d.put('state.json', { lastAlert: { XAUUSD: alertState(gold) } });
  const buf = Buffer.from(JSON.stringify({ BTCUSD: BARS }));
  for (let off = 0; off < buf.length;) {
    try { off += writeSync(fd, buf, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; await pause(5); }
  }
  closeSync(fd);
  await exited;
  assert.match(reply(out), /▼ Sell idea · Bitcoin/);
  assert.deepEqual(Object.keys(d.read('ideas.json')).sort(), ['BTCUSD', 'XAUUSD']);
  assert.deepEqual(d.read('ideas.json').XAUUSD, gold, 'the gold alert is untouched');
  assert.deepEqual(Object.keys(d.read('state.json').lastAlert).sort(), ['BTCUSD', 'XAUUSD']);
});

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
