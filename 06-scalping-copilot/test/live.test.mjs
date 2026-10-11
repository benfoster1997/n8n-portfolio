/**
 * The watcher (desk/live.mjs): live bars through the same engine, gate and
 * checks, and the replies it sends. Bars are real: ten days of Binance
 * BTCUSDT fifteen-minute candles recorded on 11 Oct 2026
 * (fixtures/btc-m15.json), so the engine sees market shapes, not invented
 * ones. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  liveRead, shouldAlert, ideaRecord, formatLiveIdea, formatLiveNone, takeIdea, nextPollMs, inWatchHours,
  clearPathTarget, toPlan, COOLDOWN_BARS,
} from '../desk/live.mjs';
import { withDefaults } from '../desk/lib.mjs';
import { closedBars, loadBars } from '../src/data-feeds.js';
import { resample } from '../src/indicators.js';
import { analyse } from '../src/signal-engine.js';
import { stopFloor } from '../src/shot.js';
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
function env(nowIso) {
  const home = mkdtempSync(join(tmpdir(), 'live-'));
  const bars = join(home, 'bars.json');
  writeFileSync(bars, JSON.stringify({ BTCUSD: BARS }));
  const config = join(home, 'config.json');
  writeFileSync(config, '{}');
  const e = { ...process.env, SCALP_DESK_HOME: home, SCALP_DESK_CONFIG: config, SCALP_DESK_BARS: bars, SCALP_DESK_NOW: nowIso, TWELVEDATA_API_KEY: '' };
  const run = (args) => { try { return execFileSync('node', [DESK, ...args], { encoding: 'utf8', env: e }); } catch (x) { return `EXIT ${x.status}\n${x.stdout}`; } };
  return { home, run };
}
const reply = (out) => (out.split('--- reply ---\n')[1] || '').split('\n--- end ---')[0];
test('scan on a Sunday night says why there is no idea, and names no direction', () => {
  const d = env('2026-10-11T21:30:20Z');
  const out = d.run(['scan', '--pair', 'bitcoin']);
  assert.match(out, /STATUS: info/); assert.match(reply(out), /No idea · Bitcoin/);
  assert.doesNotMatch(reply(out), DIRECTION);
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

for (const run of pending) await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
