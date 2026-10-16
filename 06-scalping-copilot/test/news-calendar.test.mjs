import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENTS, getUpcomingEvents, getActiveBlackout, dstMisalignment,
  brokerChartTime, DST_MISALIGNMENT_WINDOWS, CORRELATION_NOTE, US_HOLIDAYS_2026,
  US_HOLIDAYS, US_CLOSURES, confidenceOf,
} from '../src/news-calendar.js';

// The researched release dates the history tables were typed in from.
const HISTORY = JSON.parse(readFileSync(new URL('../data/calendar-history.json', import.meta.url), 'utf8'));

let passed = 0, failed = 0;
const test = (n, fn) => {
  try { fn(); passed++; console.log('  ok   ' + n); }
  catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + e.message); }
};
const utcHM = (ms) => `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:${String(new Date(ms).getUTCMinutes()).padStart(2, '0')}`;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

console.log('\nevent resolution');

test('every event declares a tier, a zone and a confidence', () => {
  for (const e of EVENTS) {
    assert.ok(e.id && e.name && e.agency, `${e.id} missing identity`);
    assert.ok(['both', 'XAUUSD', 'BTCUSD'].includes(e.affects), `${e.id} bad affects`);
    assert.ok([1, 2, 3, 'context'].includes(e.tier), `${e.id} bad tier ${e.tier}`);
    assert.ok(e.tz, `${e.id} has no timezone`);
    assert.ok(['verified', 'likely', 'unverified'].includes(e.confidence), `${e.id} bad confidence`);
    assert.ok(e.why, `${e.id} does not say why it matters`);
  }
});

test('NFP resolves to the published dates at the right UTC hour', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 0, 1), 24 * 340, null)
    .filter((e) => e.id === 'nfp');
  const got = rows.map((r) => [isoDate(r.ts), utcHM(r.ts)]);
  assert.deepEqual(got.slice(0, 4), [
    ['2026-01-09', '13:30'],   // second Friday, EST
    ['2026-02-11', '13:30'],   // a Wednesday: delayed by the brief shutdown from 31 January
    ['2026-03-06', '13:30'],
    ['2026-04-03', '12:30'],   // now EDT
  ]);
  const jul = got.find(([d]) => d.startsWith('2026-07'));
  assert.deepEqual(jul, ['2026-07-02', '12:30'], 'July NFP is the Thursday before the observed holiday');
  const nov = got.find(([d]) => d.startsWith('2026-11'));
  assert.deepEqual(nov, ['2026-11-06', '13:30'], 'November is back on EST');
});

test('FOMC minutes land exactly 21 days after the second meeting day', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 0, 1), 24 * 340, null)
    .filter((e) => e.id === 'fomc-minutes');
  const sep = rows.find((r) => isoDate(r.ts).startsWith('2026-10-07'));
  assert.ok(sep, `expected 7 Oct minutes (16 Sep + 21d), got ${rows.map((r) => isoDate(r.ts))}`);
  assert.equal(utcHM(sep.ts), '18:00', 'still EDT on 7 Oct');
});

test('the Deribit expiry is the last Friday, and its window opens before 08:00', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 8, 1), 24 * 40, 'BTCUSD')
    .filter((e) => e.id === 'deribit-expiry');
  assert.ok(rows.length >= 1);
  assert.equal(isoDate(rows[0].ts), '2026-09-25', 'last Friday of September 2026');
  assert.equal(utcHM(rows[0].ts), '08:00');
  // The TWAP window opens 30 minutes earlier, and the blackout starts before that.
  assert.equal(rows[0].windowStartTs, rows[0].ts - 30 * 60000);
});

test('CME settlement uses London time, so it moves with UK DST not US DST', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 8, 1), 24 * 130, 'BTCUSD')
    .filter((e) => e.id === 'cme-btc-settle');
  const sep = rows.find((r) => isoDate(r.ts) === '2026-09-25');
  const dec = rows.find((r) => isoDate(r.ts) === '2026-12-25');
  assert.equal(utcHM(sep.ts), '15:00', '16:00 London in BST is 15:00 UTC');
  assert.equal(utcHM(dec.ts), '16:00', '16:00 London in GMT is 16:00 UTC');
});

test('weekly jobless claims pull forward in a federal-holiday week', () => {
  // Thanksgiving is Thu 26 Nov 2026, so that week's claims move to Wednesday.
  const rows = getUpcomingEvents(Date.UTC(2026, 10, 20), 24 * 10, null)
    .filter((e) => e.id === 'jobless');
  const dates = rows.map((r) => isoDate(r.ts));
  assert.ok(dates.includes('2026-11-25'), `expected a Wednesday shift, got ${dates}`);
  assert.ok(!dates.includes('2026-11-26'), 'must not schedule claims on Thanksgiving');
  assert.ok(rows.find((r) => isoDate(r.ts) === '2026-11-25').dateShifted, 'the shift should be flagged');
});

test('ISM respects federal holidays when counting business days', () => {
  // 1 Jan 2026 is a Thursday holiday, so the first business day is Friday 2nd.
  const rows = getUpcomingEvents(Date.UTC(2026, 0, 1), 24 * 20, null)
    .filter((e) => e.id === 'ism-mfg');
  assert.equal(isoDate(rows[0].ts), '2026-01-02');
});

test('pair filtering keeps gold-only and bitcoin-only events apart', () => {
  const from = Date.UTC(2026, 8, 20);
  const gold = getUpcomingEvents(from, 24 * 30, 'XAUUSD').map((e) => e.id);
  const btc = getUpcomingEvents(from, 24 * 30, 'BTCUSD').map((e) => e.id);
  assert.ok(gold.includes('lbma-pm') && gold.includes('cot'));
  assert.ok(!btc.includes('lbma-pm') && !btc.includes('cot'), 'gold fixings must not appear for bitcoin');
  assert.ok(btc.includes('deribit-expiry'));
  assert.ok(!gold.includes('deribit-expiry'), 'crypto expiries must not appear for gold');
  assert.ok(gold.includes('nfp') && btc.includes('nfp'), 'macro affects both');
});

console.log('\nrelease dates in past years (data/calendar-history.json)');

const ev = (id) => EVENTS.find((e) => e.id === id);
const TABLES = ['nfp', 'cpi', 'fomc-statement', 'fomc-presser', 'pce'];
const yearsOf = (id) => [...new Set(ev(id).schedule.dates.map((d) => d.slice(0, 4)))];

test('every listed tier-1 date is a weekday, listed once, in order', () => {
  for (const id of TABLES) {
    const { dates } = ev(id).schedule;
    for (const d of dates) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      assert.ok(dow >= 1 && dow <= 5, `${id} ${d} falls on a weekend`);
    }
    assert.equal(new Set(dates).size, dates.length, `${id} lists a date twice`);
    assert.deepEqual([...dates].sort(), dates, `${id} is not in date order`);
  }
});

test('2017–2025 hold exactly the data file\'s sourced dates, never an unsourced candidate', () => {
  const fromData = { nfp: [], cpi: [], pce: [], 'fomc-statement': [], 'fomc-presser': [] };
  const candidates = { nfp: new Set(), cpi: new Set(), pce: new Set() };
  for (const id of ['nfp', 'cpi', 'pce']) {
    for (const row of Object.values(HISTORY[id])) {
      fromData[id].push(...row.dates);
      for (const c of row.unsourcedCandidates || []) candidates[id].add(c);
    }
  }
  const unscheduled = new Set(HISTORY.fomc.unscheduled.map((u) => u.date));
  for (const [y, row] of Object.entries(HISTORY.fomc)) {
    if (!/^\d{4}$/.test(y)) continue;
    const held = row.dates.filter((d) => !unscheduled.has(d));   // 15 Mar 2020: unscheduled, time unverified
    fromData['fomc-statement'].push(...held);
    fromData['fomc-presser'].push(...(Array.isArray(row.pressConference) ? row.pressConference : held));
  }
  for (const id of TABLES) {
    const past = ev(id).schedule.dates.filter((d) => d < '2026');
    assert.deepEqual(past, [...fromData[id]].sort(), id);
    for (const d of ev(id).schedule.dates) assert.ok(!(candidates[id] && candidates[id].has(d)), `${id} uses the unsourced ${d}`);
  }
  assert.ok(!ev('fomc-statement').schedule.dates.some((d) => d.startsWith('2020-03')), 'no unscheduled March 2020 action');
  assert.deepEqual(ev('fomc-presser').schedule.dates.filter((d) => d < '2019'),
    ['2017-03-15', '2017-06-14', '2017-09-20', '2017-12-13', '2018-03-21', '2018-06-13', '2018-09-26', '2018-12-19'],
    'press conferences in 2017–2018 only after the quarterly meetings');
});

test('each year\'s confidence is recorded and never claims more than the data file', () => {
  for (const id of TABLES) {
    const byYear = ev(id).schedule.confidenceByYear;
    for (const y of yearsOf(id)) {
      if (y === '2026') continue;
      assert.ok(['verified', 'likely', 'unverified'].includes(byYear[y]), `${id} ${y} has no confidence`);
      const key = id.startsWith('fomc') ? 'fomc' : id;
      // "verified" only where the data file says verified for every date listed that year.
      const said = HISTORY[key][y].confidence;
      const listed = ev(id).schedule.dates.filter((d) => d.startsWith(y));
      if (byYear[y] === 'verified') assert.ok(said === 'verified' || (said.startsWith('verified for ') && listed.every((d) => said.includes(d))), `${id} ${y}: "${said}"`);
    }
  }
  assert.equal(ev('nfp').schedule.confidenceByYear[2025], 'likely', 'March, April and September 2025 rest on one calendar each');
  assert.equal(ev('cpi').schedule.confidenceByYear[2018], 'unverified', '14 Feb 2018 is indirect only');
  // Each row carries its own year's confidence; 2026 rows the event's, so the UI's marker is unchanged.
  const row = (from, id) => getUpcomingEvents(from, 24 * 40, null).find((e) => e.id === id);
  assert.equal(row(Date.UTC(2019, 2, 1), 'fomc-statement').confidence, 'verified');
  assert.equal(row(Date.UTC(2020, 6, 1), 'fomc-statement').confidence, 'likely');
  assert.equal(row(Date.UTC(2026, 2, 1), 'fomc-statement').confidence, ev('fomc-statement').confidence);
  assert.equal(confidenceOf(ev('pce'), 2026), 'unverified');
});

test('the 2025 shutdown: releases on the days they actually came out, cancelled ones absent', () => {
  const rows = getUpcomingEvents(Date.UTC(2025, 8, 25), 24 * 90, null);
  const on = (id) => rows.filter((r) => r.id === id).map((r) => `${isoDate(r.ts)} ${utcHM(r.ts)}`);
  assert.deepEqual(on('nfp'), ['2025-11-20 13:30', '2025-12-16 13:30'], 'September\'s on Thu 20 Nov, November\'s on Tue 16 Dec, October\'s never');
  assert.deepEqual(on('cpi'), ['2025-10-24 12:30', '2025-12-18 13:30'], 'September\'s on Fri 24 Oct (still EDT), November\'s on Thu 18 Dec');
  assert.deepEqual(on('pce'), ['2025-09-26 12:30', '2025-12-05 15:00'], 'September\'s data on Fri 5 Dec at 10:00 New York');
  assert.deepEqual(on('fomc-statement'), ['2025-10-29 18:00', '2025-12-10 19:00'], 'the Fed met through the shutdown');
  // The monthly ADP keeps to the dates BLS had scheduled: Wednesdays 1 Oct, 5 Nov, 3 Dec.
  assert.deepEqual(on('adp-monthly').map((x) => x.slice(0, 10)), ['2025-10-01', '2025-11-05', '2025-12-03']);
  // A per-date time is a real blackout: 08:35 New York on 5 Dec is clear, 10:05 is not.
  assert.equal(getActiveBlackout(Date.UTC(2025, 11, 5, 13, 35), 'BTCUSD', {}, { calendar: 'full' })?.event.id ?? null, null);
  assert.equal(getActiveBlackout(Date.UTC(2025, 11, 5, 15, 5), 'XAUUSD').event.id, 'pce');
});

test('January 2026: NFP came out Wed 11 Feb and CPI Fri 13 Feb; the ADP stayed on Wed 4 Feb', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 1, 1), 24 * 20, null);
  const on = (id) => rows.filter((r) => r.id === id).map((r) => `${isoDate(r.ts)} ${utcHM(r.ts)}`);
  assert.deepEqual(on('nfp'), ['2026-02-11 13:30']);
  assert.deepEqual(on('cpi'), ['2026-02-13 13:30']);
  assert.deepEqual(on('adp-monthly'), ['2026-02-04 13:15']);
  assert.equal(getActiveBlackout(Date.UTC(2026, 1, 6, 13, 25), 'XAUUSD'), null, 'nothing at the old NFP slot on 6 Feb');
  assert.equal(getActiveBlackout(Date.UTC(2026, 1, 11, 13, 25), 'XAUUSD').event.id, 'nfp');
  assert.equal(getActiveBlackout(Date.UTC(2026, 1, 13, 13, 25), 'XAUUSD').event.id, 'cpi');
});

test('holidays move the rule-derived events in past years, not only in 2026', () => {
  const claims = (from, days) => getUpcomingEvents(from, 24 * days, null).filter((e) => e.id === 'jobless');
  // Thanksgiving, Thursday 28 November 2019: that week's claims on the Wednesday.
  const nov = claims(Date.UTC(2019, 10, 18), 14);
  assert.deepEqual(nov.map((r) => isoDate(r.ts)), ['2019-11-21', '2019-11-27']);
  assert.deepEqual(nov.map((r) => r.dateShifted), [false, true]);
  // Carter's day of mourning closed the government on Thursday 9 January 2025.
  assert.ok(claims(Date.UTC(2025, 0, 6), 5).some((r) => isoDate(r.ts) === '2025-01-08' && r.dateShifted));
  // ISM counts business days with that year's holidays: Labor Day 2025 was Monday 1 September.
  assert.equal(isoDate(getUpcomingEvents(Date.UTC(2025, 8, 1), 24 * 5, null).find((e) => e.id === 'ism-mfg').ts), '2025-09-02');
});

test('the holiday table covers 2017–2026, keeps 2026 as it was, and only verified closures', () => {
  assert.deepEqual(Object.keys(US_HOLIDAYS), ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']);
  assert.equal(US_HOLIDAYS[2026], US_HOLIDAYS_2026);
  for (const [y, row] of Object.entries(HISTORY.holidays)) assert.deepEqual(US_HOLIDAYS[y], row.dates, y);
  const verified = Object.values(HISTORY.holidays).flatMap((h) => h.additionalClosures).filter((c) => c.confidence === 'verified').map((c) => c.date);
  assert.deepEqual([...US_CLOSURES], verified);
  for (const d of [...Object.values(US_HOLIDAYS).flat(), ...US_CLOSURES]) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d} is an observed weekday`);
  }
});

console.log('\nblackout behaviour');

test('a tier-1 blackout opens before the release and closes after it', () => {
  const nfp = Date.UTC(2026, 9, 2, 12, 30);       // 2 Oct 2026, 08:30 EDT
  assert.equal(getActiveBlackout(nfp - 20 * 60000, 'XAUUSD'), null, '20 min before should be clear');
  const before = getActiveBlackout(nfp - 10 * 60000, 'XAUUSD');
  assert.ok(before && before.phase === 'before', '10 min before should be blocked');
  assert.equal(before.event.id, 'nfp');
  assert.equal(before.tier, 1);
  const after = getActiveBlackout(nfp + 20 * 60000, 'XAUUSD');
  assert.ok(after && after.phase === 'after', '20 min after should still be blocked');
  assert.equal(getActiveBlackout(nfp + 45 * 60000, 'XAUUSD'), null, '45 min after should be clear');
});

test('the FOMC blackout spans the statement AND the press conference', () => {
  const stmt = Date.UTC(2026, 8, 16, 18, 0);      // 16 Sep 2026, 14:00 EDT
  for (const mins of [-10, 5, 25, 35, 60, 90]) {
    const b = getActiveBlackout(stmt + mins * 60000, 'BTCUSD');
    assert.ok(b, `expected a blackout at statement +${mins} min — the 30-minute gap is not safe`);
  }
  assert.equal(getActiveBlackout(stmt + 170 * 60000, 'BTCUSD'), null, 'should clear eventually');
});

test('context events never produce a blackout, however close', () => {
  // LBMA PM auction, 15:00 London on a normal weekday.
  const lbma = Date.UTC(2026, 8, 23, 14, 0);
  const b = getActiveBlackout(lbma, 'XAUUSD');
  assert.ok(b === null || b.event.tier !== 'context',
    'a context event must never block trading');
  const ctx = getUpcomingEvents(lbma - 3600e3, 6, 'XAUUSD').filter((e) => e.tier === 'context');
  assert.ok(ctx.length > 0, 'context events should still be listed');
  assert.ok(ctx.every((e) => e.blackoutBefore === 0 && e.blackoutAfter === 0));
});

test('the most severe overlapping blackout wins', () => {
  // ADP (tier 2) at 08:15 ET sits inside the NFP-day cluster; on a CPI day the
  // tier-1 row must be the one reported.
  const cpi = Date.UTC(2026, 9, 14, 12, 30);
  const b = getActiveBlackout(cpi - 5 * 60000, 'XAUUSD');
  assert.ok(b);
  assert.equal(b.tier, 1, `expected the tier-1 event to win, got ${b.event.id}`);
});

test('blackout windows are user-overridable', () => {
  const nfp = Date.UTC(2026, 9, 2, 12, 30);
  const tight = getActiveBlackout(nfp - 12 * 60000, 'XAUUSD', { nfpBefore: 5 });
  assert.equal(tight, null, 'a tightened window should let 12 minutes before through');
  const wide = getActiveBlackout(nfp - 50 * 60000, 'XAUUSD', { nfpBefore: 60 });
  assert.ok(wide, 'a widened window should block 50 minutes before');
});

console.log('\nthe MT5 server-clock trap');

test('the misalignment windows are detected', () => {
  assert.ok(dstMisalignment(Date.UTC(2026, 2, 15)), 'mid-March 2026 is misaligned');
  assert.ok(dstMisalignment(Date.UTC(2026, 9, 28)), 'late October 2026 is misaligned');
  assert.equal(dstMisalignment(Date.UTC(2026, 6, 15)), null, 'mid-July is aligned');
  assert.equal(dstMisalignment(Date.UTC(2026, 11, 15)), null, 'mid-December is aligned');
});

test('US news really does land an hour earlier on a GMT+2 chart in the window', () => {
  // Outside the window, in summer: 12:30 UTC on a GMT+3 server = 15:30.
  const summer = brokerChartTime(Date.UTC(2026, 6, 3, 12, 30), 3);
  assert.equal(summer.text, '15:30');
  assert.equal(summer.misalignment, null);

  // Inside the window: US on EDT (12:30 UTC) but the broker still on GMT+2.
  const misaligned = brokerChartTime(Date.UTC(2026, 2, 13, 12, 30), 2);
  assert.equal(misaligned.text, '14:30', 'an hour earlier than the usual 15:30');
  assert.ok(misaligned.misalignment, 'and the warning must fire');
  assert.ok(/EARLIER/.test(misaligned.misalignment.message));

  // Winter, aligned: 13:30 UTC on a GMT+2 server = 15:30 again.
  const winter = brokerChartTime(Date.UTC(2026, 11, 4, 13, 30), 2);
  assert.equal(winter.text, '15:30');
});

test('broker time is never guessed when the offset is unknown', () => {
  assert.equal(brokerChartTime(Date.now ? Date.UTC(2026, 6, 3, 12, 30) : 0, null), null);
  assert.equal(brokerChartTime(Date.UTC(2026, 6, 3, 12, 30), undefined), null);
});

console.log('\nhonesty checks');

test('unverified events are flagged so the UI can mark them', () => {
  const unver = EVENTS.filter((e) => e.confidence === 'unverified');
  assert.ok(unver.length > 0, 'nothing is marked unverified — suspiciously confident');
  for (const e of unver) assert.ok(e.note, `${e.id} is unverified but offers no caveat`);
});

test('approximate dates are labelled as approximate', () => {
  for (const e of EVENTS) {
    if (e.schedule.kind === 'monthlyApprox') {
      assert.equal(e.approximate, true, `${e.id} uses an approximate rule but is not flagged`);
    }
  }
});

test('the gold/bitcoin correlation warning is present and specific', () => {
  assert.ok(CORRELATION_NOTE.value > 0.5);
  assert.ok(/double/i.test(CORRELATION_NOTE.message), 'must spell out the doubled-position risk');
});

test('the 2026 holiday list matches the observed dates', () => {
  assert.ok(US_HOLIDAYS_2026.includes('2026-07-03'), 'Independence Day observed on Friday 3 July');
  assert.ok(!US_HOLIDAYS_2026.includes('2026-07-04'), '4 July 2026 is a Saturday, not the observed day');
  assert.equal(US_HOLIDAYS_2026.length, 11);
});

test('a 48-hour horizon returns a sane number of rows, sorted', () => {
  const rows = getUpcomingEvents(Date.UTC(2026, 9, 1, 0, 0), 48, 'XAUUSD');
  assert.ok(rows.length > 0 && rows.length < 60, `got ${rows.length} rows`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts >= rows[i - 1].ts, 'not sorted');
  assert.ok(rows.every((r) => typeof r.minutesAway === 'number'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
