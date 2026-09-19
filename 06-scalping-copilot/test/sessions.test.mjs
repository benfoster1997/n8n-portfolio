/**
 * The London window, and the DST bug that motivated this file.
 *
 * An earlier version keyed quality bands to fixed UTC hours. The London
 * session is 07:00-15:00 UTC in summer and 08:00-16:00 UTC in winter, so a
 * fixed-UTC band map is an hour wrong for half the year — it would have graded
 * the London open as the mid-morning lull every winter. These tests exist to
 * make that impossible to reintroduce.
 */
import assert from 'node:assert/strict';
import {
  sessionQuality, windowState, insideWindow, localHour, localWeekday,
  remainingBands, rolloverWindow, barBoundaryNote, DEFAULT_WINDOW,
  preferredInstrument, costFloorBps,
} from '../src/sessions.js';
import { zonedTimeToUtc } from '../src/timezone.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};

const LDN = 'Europe/London';
/** A UTC instant at a given London wall-clock time on a given date. */
const at = (y, m, d, h, mi = 0) => zonedTimeToUtc(y, m, d, h, mi, LDN);

// 15 Jul 2026 is a Wednesday (BST). 14 Jan 2026 is a Wednesday (GMT).
const SUMMER = [2026, 7, 15];
const WINTER = [2026, 1, 14];

console.log('\nthe DST bug this file exists to prevent');

test('the 08:00 London hour reads the same in summer and winter', () => {
  const s = sessionQuality(at(...SUMMER, 8, 15), 'XAUUSD');
  const w = sessionQuality(at(...WINTER, 8, 15), 'XAUUSD');
  assert.equal(s.name, 'London satellite');
  assert.equal(w.name, 'London satellite', 'a fixed-UTC band map would mis-grade this all winter');
});

test('every band is identical at the same London wall-clock time, both seasons', () => {
  for (const [h, mi] of [[8, 30], [10, 0], [11, 30], [13, 0], [13, 30], [15, 0], [15, 45]]) {
    for (const pair of ['XAUUSD', 'BTCUSD']) {
      const s = sessionQuality(at(...SUMMER, h, mi), pair);
      const w = sessionQuality(at(...WINTER, h, mi), pair);
      assert.equal(s.name, w.name, `${pair} at ${h}:${mi} differs between seasons (${s.name} vs ${w.name})`);
      assert.equal(s.band, w.band);
    }
  }
});

test('the same UTC hour grades DIFFERENTLY across seasons, as it must', () => {
  // 08:00 UTC is 09:00 London in summer (still the open band) but 08:00 London
  // in winter (also the open band) — so use 12:00 UTC, which is 13:00 London in
  // summer (prime) and 12:00 London in winter (lull).
  const s = sessionQuality(Date.UTC(2026, 6, 15, 12, 45), 'XAUUSD');   // 13:45 London
  const w = sessionQuality(Date.UTC(2026, 0, 14, 12, 45), 'XAUUSD');   // 12:45 London
  assert.notEqual(s.name, w.name,
    'if these matched, the bands would be keyed to UTC rather than London time');
  assert.equal(s.name, 'COMEX ramp and US data');
  assert.equal(w.name, 'Pre-data build');
});

console.log('\nband shape');

test('gold is back-loaded: the real session is the COMEX ramp, not the London open', () => {
  const g = (h, mi = 0) => sessionQuality(at(...SUMMER, h, mi), 'XAUUSD');
  // The folklore says the London open is prime. For gold it is not — the
  // liquidity handover that matters is COMEX regular hours around 13:20.
  assert.equal(g(8, 15).band, 'amber', 'the London open is a satellite, not the main event');
  assert.equal(g(10, 30).band, 'dead', '09:00-12:30 is the structural low of the day');
  assert.equal(g(11, 30).band, 'dead');
  assert.equal(g(12, 45).band, 'amber');
  assert.equal(g(13, 30).band, 'green', 'the US data slot');
  assert.equal(g(15, 30).band, 'green');
  assert.ok(/non-event/i.test(g(10, 30).note),
    'the dead-zone note should say the 10:30 auction will not rescue it');
});

test('16:00 London is a fix burst, not a wind-down', () => {
  const q = sessionQuality(at(...SUMMER, 15, 58), 'XAUUSD');
  assert.equal(q.name, 'The 16:00 fix');
  assert.ok(/burst|volatilit/i.test(q.note));
  assert.ok(/month-end/i.test(q.note), 'month-end is when it is most extreme');
});

test('the 15:00 slot is labelled as confounded, not a clean auction effect', () => {
  const q = sessionQuality(at(...SUMMER, 15, 10), 'XAUUSD');
  assert.ok(/confounded/i.test(q.note),
    'the LBMA PM auction shares its minute with the US 10:00 ET data slot');
});

test('bitcoin: the European morning is the worst pick of the day', () => {
  const b = (h, mi = 0) => sessionQuality(at(...SUMMER, h, mi), 'BTCUSD');
  assert.equal(b(9, 0).band, 'dead');
  assert.equal(b(11, 0).band, 'dead');
  assert.equal(b(12, 30).band, 'amber');
  assert.equal(b(14, 0).band, 'green');
  assert.ok(/spread/i.test(b(9, 0).note), 'the reason must name the cost problem, not just say "quiet"');
  // The honest framing: his window is not useless for bitcoin, it is back-loaded.
  assert.ok(/after you close/i.test(b(14, 0).note),
    'the good bitcoin hours mostly fall after the window closes and that should be said');
});

test('the two instruments are graded differently at the same moment', () => {
  const t = at(...SUMMER, 8, 30);
  assert.notEqual(sessionQuality(t, 'XAUUSD').band, sessionQuality(t, 'BTCUSD').band,
    'gold and bitcoin do not share a session profile and must not share a band map');
});

test('the weekend is called out, and differently per instrument', () => {
  const sat = at(2026, 7, 18, 12, 0);   // Saturday
  assert.equal(localWeekday(sat, LDN), 6);
  assert.equal(sessionQuality(sat, 'XAUUSD').band, 'dead');
  assert.ok(/closed/i.test(sessionQuality(sat, 'XAUUSD').note));
  assert.ok(/trades on|weekend/i.test(sessionQuality(sat, 'BTCUSD').note),
    'bitcoin does not simply close at the weekend and should not be described as if it does');
});

console.log('\nthe window itself');

test('window phases progress through a London day', () => {
  const p = (h, mi = 0) => windowState(at(...SUMMER, h, mi)).phase;
  assert.equal(p(7, 0), 'before');
  assert.equal(p(8, 5), 'opening');
  assert.equal(p(11, 0), 'open');
  assert.equal(p(15, 15), 'closing');
  assert.equal(p(15, 45), 'last-30');
  assert.equal(p(17, 0), 'after');
});

test('minutes left counts down to the London close, in both seasons', () => {
  for (const d of [SUMMER, WINTER]) {
    const s = windowState(at(...d, 14, 0));
    assert.equal(s.minutesLeft, 120, `wrong in ${d[1] === 7 ? 'summer' : 'winter'}`);
    assert.equal(s.totalMinutes, 480, 'an 08:00-16:00 window is eight hours');
  }
});

test('the weekend is not an open window', () => {
  const s = windowState(at(2026, 7, 19, 12, 0));   // Sunday
  assert.equal(s.phase, 'weekend');
  assert.equal(s.open, false);
});

test('insideWindow agrees with the real US release times', () => {
  // 08:30 ET is 13:30 London outside the misalignment weeks — comfortably inside.
  assert.equal(insideWindow(zonedTimeToUtc(2026, 10, 2, 8, 30, 'America/New_York')), true, 'NFP');
  // 14:00 ET is 19:00 London — three hours after the window closes.
  assert.equal(insideWindow(zonedTimeToUtc(2026, 9, 16, 14, 0, 'America/New_York')), false, 'FOMC');
  // 10:00 ET is 15:00 London — inside, just.
  assert.equal(insideWindow(zonedTimeToUtc(2026, 10, 1, 10, 0, 'America/New_York')), true, 'ISM');
});

test('a misalignment week moves US data an hour earlier, still inside the window', () => {
  // 13 Mar 2026: US on EDT, UK still on GMT.
  const t = zonedTimeToUtc(2026, 3, 13, 8, 30, 'America/New_York');
  assert.equal(Math.floor(localHour(t, LDN)), 12, 'should be 12:30 London, not 13:30');
  assert.equal(insideWindow(t), true, 'still inside the window, just an hour earlier');
});

test('the window is configurable, not hardcoded to London', () => {
  const ny = { start: { h: 9, m: 30 }, end: { h: 16, m: 0 }, tz: 'America/New_York', label: 'NY' };
  const s = windowState(zonedTimeToUtc(2026, 7, 15, 10, 0, 'America/New_York'), ny);
  assert.equal(s.phase, 'open');
  assert.equal(s.totalMinutes, 390);
});

console.log('\nplanning the rest of the day');

test('remainingBands returns only what is still ahead, flagging the current one', () => {
  const r = remainingBands(at(...SUMMER, 10, 0), 'XAUUSD');
  assert.ok(r.length >= 2);
  assert.equal(r[0].name, 'Dead zone');
  assert.equal(r[0].current, true);
  assert.ok(r.some((b) => b.name === 'COMEX ramp and US data'));
  assert.ok(!r.some((b) => b.name === 'London satellite'), 'the open is behind us at 10:00');
});

test('remainingBands empties out after the close', () => {
  assert.equal(remainingBands(at(...SUMMER, 17, 0), 'XAUUSD').length, 0);
});

test('band boundaries resolve to real London instants', () => {
  const r = remainingBands(at(...WINTER, 8, 30), 'XAUUSD');
  const prime = r.find((b) => b.name === 'COMEX ramp and US data');
  assert.ok(prime, 'the prime band must be ahead of us at 08:30');
  assert.equal(Math.floor(localHour(prime.startsAtMs, LDN)), 13);
  assert.equal(Math.round((localHour(prime.startsAtMs, LDN) % 1) * 60), 18,
    'starts around 13:20 London — the COMEX ramp, not the 13:30 print');
});

console.log('\ninstrument choice and cost');

test('gold is the steer before the COMEX ramp, and neither after', () => {
  const morning = preferredInstrument(at(...SUMMER, 9, 30));
  assert.equal(morning.pair, 'XAUUSD');
  assert.equal(morning.confident, true);
  assert.ok(/worst hours/i.test(morning.reason));

  const afternoon = preferredInstrument(at(...SUMMER, 14, 0));
  assert.equal(afternoon.confident, false,
    'once both are live this is a choice, not a steer — the tool should not pretend otherwise');
});

test('the steer is stable across seasons, because it is anchored to London', () => {
  for (const [h, mi] of [[9, 30], [11, 0], [14, 0]]) {
    assert.equal(
      preferredInstrument(at(...SUMMER, h, mi)).pair,
      preferredInstrument(at(...WINTER, h, mi)).pair,
      `the steer changed between seasons at ${h}:${mi}`,
    );
  }
});

test('outside the window there is no steer at all', () => {
  assert.equal(preferredInstrument(at(...SUMMER, 6, 0)).pair, null);
  assert.equal(preferredInstrument(at(...SUMMER, 18, 0)).pair, null);
});

test('the cost floor says bitcoin needs several times the move gold does', () => {
  const gold = costFloorBps(0.35, 4391);
  const btc = costFloorBps(30, 81000);
  assert.equal(gold, 0.8);
  assert.equal(btc, 3.7);
  assert.ok(btc / gold > 3, 'bitcoin should cost several times as much per round trip');
  assert.equal(costFloorBps(0, 4391), null, 'never guessed from a missing spread');
});

console.log('\nodds and ends');

test('the broker rollover falls outside a London session — a quiet advantage', () => {
  const r = rolloverWindow(at(...SUMMER, 13, 0), 3);
  assert.equal(r.inside, false, 'the 21:00 UTC roll is long after a London close');
  assert.ok(rolloverWindow(Date.UTC(2026, 6, 15, 21, 10), 3).inside);
  assert.equal(rolloverWindow(Date.now ? at(...SUMMER, 13, 0) : 0, null), null, 'never guessed');
});

test('bar-boundary contamination is flagged on the round marks', () => {
  assert.equal(barBoundaryNote(Date.UTC(2026, 6, 15, 13, 30)).strong, true);
  assert.equal(barBoundaryNote(Date.UTC(2026, 6, 15, 13, 35)).strong, false);
});

test('the default window is the London session', () => {
  assert.equal(DEFAULT_WINDOW.tz, 'Europe/London');
  assert.equal(DEFAULT_WINDOW.start.h, 8);
  assert.equal(DEFAULT_WINDOW.end.h, 16);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
