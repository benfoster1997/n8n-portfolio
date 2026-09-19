/**
 * The DST trap, pinned down.
 *
 * If any of these fail, the news countdown is an hour wrong for part of the
 * year, which is the worst failure this tool could have: it would tell a
 * scalper the coast is clear immediately before the largest candle of the month.
 */
import assert from 'node:assert/strict';
import {
  zonedTimeToUtc, tzOffsetMs, nthWeekdayOfMonth, nthWeekdayOrNull,
  lastWeekdayOfMonth, daysInMonth, formatCountdown,
} from '../src/timezone.js';

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};
const NY = 'America/New_York', LDN = 'Europe/London';
const utcHM = (ms) => `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:${String(new Date(ms).getUTCMinutes()).padStart(2, '0')}`;

console.log('\nthe 08:30 New York problem');

test('08:30 ET is 13:30 UTC in winter and 12:30 UTC in summer', () => {
  assert.equal(utcHM(zonedTimeToUtc(2026, 1, 2, 8, 30, NY)), '13:30', 'January (EST)');
  assert.equal(utcHM(zonedTimeToUtc(2026, 7, 3, 8, 30, NY)), '12:30', 'July (EDT)');
});

test('the 08:30 ET slot resolves correctly on every real 2026 NFP date', () => {
  // THESE ARE THE PUBLISHED DATES, NOT FIRST FRIDAYS.
  //
  // A "first Friday of the month" rule — the one every retail article
  // repeats — is wrong for four of the twelve 2026 releases:
  //   Jan 9, May 8 and Aug 7 are SECOND Fridays;
  //   Jul 2 is a THURSDAY, because Fri 3 Jul is the observed Independence
  //   Day holiday.
  // That is why the calendar in this tool is table-driven and why
  // nthWeekdayOfMonth is only ever used for releases that genuinely do
  // follow a rule. Deriving NFP would put a trader in a position during
  // the largest print of the month, roughly a third of the time.
  const published2026 = [
    [1, 9, '13:30'], [2, 6, '13:30'], [3, 6, '13:30'], [4, 3, '12:30'],
    [5, 8, '12:30'], [6, 5, '12:30'], [7, 2, '12:30'], [8, 7, '12:30'],
    [9, 4, '12:30'], [10, 2, '12:30'], [11, 6, '13:30'], [12, 4, '13:30'],
  ];
  for (const [m, day, hm] of published2026) {
    assert.equal(utcHM(zonedTimeToUtc(2026, m, day, 8, 30, NY)), hm, `month ${m} release hour`);
  }
});

test('the first-Friday rule provably disagrees with the published NFP dates', () => {
  // Guards against anyone "simplifying" the calendar back to a rule later.
  const published = { 1: 9, 2: 6, 3: 6, 4: 3, 5: 8, 6: 5, 7: 2, 8: 7, 9: 4, 10: 2, 11: 6, 12: 4 };
  const mismatches = [];
  for (let m = 1; m <= 12; m++) {
    if (nthWeekdayOfMonth(2026, m, 5, 1) !== published[m]) mismatches.push(m);
  }
  assert.deepEqual(mismatches, [1, 5, 7],
    'a first-Friday rule must be shown to fail for Jan, May and Jul 2026');
});

test('the 6 Nov 2026 NFP falls back to 13:30 UTC because DST ended on 1 Nov', () => {
  assert.equal(utcHM(zonedTimeToUtc(2026, 10, 2, 8, 30, NY)), '12:30', 'October, still EDT');
  assert.equal(utcHM(zonedTimeToUtc(2026, 11, 6, 8, 30, NY)), '13:30', 'November, now EST');
});

test('FOMC 14:00 ET is 18:00 UTC in summer and 19:00 UTC in winter', () => {
  assert.equal(utcHM(zonedTimeToUtc(2026, 9, 16, 14, 0, NY)), '18:00');
  assert.equal(utcHM(zonedTimeToUtc(2026, 12, 9, 14, 0, NY)), '19:00');
});

test('the London 15:00 gold auction shifts with UK DST, independently of the US', () => {
  assert.equal(utcHM(zonedTimeToUtc(2026, 9, 19, 15, 0, LDN)), '14:00', 'BST');
  assert.equal(utcHM(zonedTimeToUtc(2026, 12, 19, 15, 0, LDN)), '15:00', 'GMT');
});

test('the late-Oct window where the UK has switched but the US has not', () => {
  // UK returns to GMT on 25 Oct 2026; the US stays on EDT until 1 Nov.
  // For that week London is UTC+0 and New York is UTC-4, a 4-hour gap
  // instead of the usual 5. A tool with hardcoded offsets is wrong all week.
  const d = [2026, 10, 28];
  const ny = zonedTimeToUtc(d[0], d[1], d[2], 8, 30, NY);
  const ldn = zonedTimeToUtc(d[0], d[1], d[2], 8, 30, LDN);
  assert.equal((ldn - ny) / 3600e3, -4, 'expected a 4-hour gap that week, not the usual 5');
});

console.log('\ntransition edge cases');

test('offsets flip on exactly the right instants in 2026', () => {
  // US: 08 Mar 07:00 UTC and 01 Nov 06:00 UTC.
  assert.equal(tzOffsetMs(Date.UTC(2026, 2, 8, 6, 59), NY) / 3600e3, -5);
  assert.equal(tzOffsetMs(Date.UTC(2026, 2, 8, 7, 1), NY) / 3600e3, -4);
  assert.equal(tzOffsetMs(Date.UTC(2026, 10, 1, 5, 59), NY) / 3600e3, -4);
  assert.equal(tzOffsetMs(Date.UTC(2026, 10, 1, 6, 1), NY) / 3600e3, -5);
  // UK: 29 Mar and 25 Oct, both at 01:00 UTC.
  assert.equal(tzOffsetMs(Date.UTC(2026, 2, 29, 0, 59), LDN) / 3600e3, 0);
  assert.equal(tzOffsetMs(Date.UTC(2026, 2, 29, 1, 1), LDN) / 3600e3, 1);
  assert.equal(tzOffsetMs(Date.UTC(2026, 9, 25, 0, 59), LDN) / 3600e3, 1);
  assert.equal(tzOffsetMs(Date.UTC(2026, 9, 25, 1, 1), LDN) / 3600e3, 0);
});

test('a nonexistent wall-clock time returns a usable instant rather than NaN', () => {
  const ms = zonedTimeToUtc(2026, 3, 8, 2, 30, NY);   // inside the spring gap
  assert.ok(Number.isFinite(ms));
});

test('an ambiguous wall-clock time resolves to the first occurrence', () => {
  const ms = zonedTimeToUtc(2026, 11, 1, 1, 30, NY);   // repeated hour
  assert.equal(ms, Date.UTC(2026, 10, 1, 5, 30), 'should pick the still-EDT occurrence');
});

test('round-trips over three years, both zones, hourly', () => {
  let bad = 0, checked = 0;
  for (const tz of [NY, LDN]) {
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 3600e3) {
      const p = {};
      for (const { type, value } of new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(t))) p[type] = value;
      if (zonedTimeToUtc(+p.year, +p.month, +p.day, +p.hour % 24, +p.minute, tz) !== t) bad++;
      checked++;
    }
  }
  // Exactly six failures are expected and unavoidable: three autumn
  // transitions per zone, each repeating one hour that two instants share.
  assert.ok(checked > 50000, 'fuzz should cover the whole window');
  assert.equal(bad, 6, `expected only the 6 ambiguous repeated hours, got ${bad}`);
});

console.log('\ncalendar helpers');

test('nth weekday of month', () => {
  assert.equal(nthWeekdayOfMonth(2026, 1, 5, 1), 2);    // 1st Friday of Jan 2026
  assert.equal(nthWeekdayOfMonth(2026, 2, 3, 2), 11);   // 2nd Wednesday of Feb
  assert.equal(nthWeekdayOrNull(2026, 2, 5, 5), null);  // no 5th Friday in Feb 2026
  assert.equal(nthWeekdayOrNull(2026, 1, 5, 5), 30);    // but there is in January
});

test('last weekday of month, for CME and Deribit expiries', () => {
  assert.equal(lastWeekdayOfMonth(2026, 9, 5), 25);     // last Friday of Sep 2026
  assert.equal(lastWeekdayOfMonth(2026, 12, 5), 25);
  assert.equal(daysInMonth(2028, 2), 29, 'leap year');
  assert.equal(daysInMonth(2026, 2), 28);
});

test('countdown formatting is legible at a glance', () => {
  assert.equal(formatCountdown(-5), 'now');
  assert.equal(formatCountdown(45 * 1000), '00:45');
  assert.equal(formatCountdown(3 * 3600e3 + 12 * 60e3), '3h 12m');
  assert.equal(formatCountdown(2 * 86400e3 + 4 * 3600e3), '2d 04h');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
