import assert from 'node:assert/strict';
import {
  EVENTS, getUpcomingEvents, getActiveBlackout, dstMisalignment,
  brokerChartTime, DST_MISALIGNMENT_WINDOWS, CORRELATION_NOTE, US_HOLIDAYS_2026,
} from '../src/news-calendar.js';

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
    ['2026-02-06', '13:30'],
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
