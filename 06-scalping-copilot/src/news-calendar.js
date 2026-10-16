/**
 * news-calendar.js — what is scheduled, when it lands, and when to be flat.
 *
 * ===========================================================================
 * TWO THINGS TO UNDERSTAND BEFORE TRUSTING THIS FILE
 * ===========================================================================
 *
 * 1. DATES ARE TABLE-DRIVEN, NOT RULE-DERIVED — ON PURPOSE.
 *
 *    "Non-Farm Payrolls is the first Friday of the month" is the most repeated
 *    claim in retail trading and it is wrong four times in twelve for 2026:
 *    9 January and 8 May are SECOND Fridays, 11 February is a WEDNESDAY (a
 *    brief federal shutdown from 31 January pushed it back five days), and
 *    2 July is a THURSDAY because Friday 3 July is the observed Independence
 *    Day holiday. CPI has no derivable rule at all. BEA moved PCE off its
 *    usual slot twice. The 2025 shutdown moved or cancelled every BLS release
 *    from October to December.
 *
 *    A rule-driven calendar would therefore tell a scalper the coast was clear
 *    on the morning of the largest print of the month, several times a year.
 *    So irregular releases carry explicit date tables, and only releases that
 *    genuinely follow a rule (weekly claims, last-Tuesday confidence,
 *    last-Friday expiries, daily funding) are computed.
 *
 * 2. THE DATES BELOW ARE NOT PRIMARY-SOURCE VERIFIED.
 *
 *    They were gathered from search results, not read off bls.gov, bea.gov or
 *    federalreserve.gov, because those domains were unreachable from the
 *    environment this was built in. Every event therefore carries a
 *    `confidence` field, and the UI renders anything below `verified` with a
 *    visible "confirm this" marker.
 *
 *    Check the tier-1 rows against your broker's own calendar before you rely
 *    on them. This file is a good default, not an authority.
 *
 *    Past years (for the history replay) come from data/calendar-history.json,
 *    researched on 16 Oct 2026 under the same restriction, with its sources.
 *    Only dates a source confirmed are typed in, never its "unsourced
 *    candidates": 2025 and the FOMC are complete, but before 2025 NFP and CPI
 *    hold only scattered months, and a missing month is simply absent. Where a
 *    year's confidence differs from 2026's it is kept per year
 *    (`confidenceByYear`, the weakest date of that year), and each listed
 *    occurrence carries the confidence of its own year.
 *
 * Times are stored as WALL-CLOCK TIME IN A NAMED IANA ZONE and converted at
 * runtime. See timezone.js for why that is non-negotiable.
 * ===========================================================================
 */

import {
  zonedTimeToUtc, nthWeekdayOfMonth, lastWeekdayOfMonth, daysInMonth,
} from './timezone.js';

const NY = 'America/New_York';
const LDN = 'Europe/London';

/* -------------------------------------------------------------- holidays */

/** US federal holidays as OBSERVED in 2026. Needed for business-day rules. */
export const US_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
];

/**
 * US federal holidays as OBSERVED, by year, 2017–2026. The rule-derived
 * events (weekly claims moving in a holiday week, ISM counting business days)
 * run in every year of the history replay, and used to do it with 2026's
 * holidays whatever the year. 2017–2025 are data/calendar-history.json's
 * statutory observed days (a computed list cross-checked against 5 U.S.C.
 * 6103; confidence "likely"). A weekend holiday lands on its observed weekday,
 * so New Year's Day 2022 sits in 2021's list (Friday 31 December 2021).
 */
export const US_HOLIDAYS = Object.freeze({
  2017: ['2017-01-02', '2017-01-16', '2017-02-20', '2017-05-29', '2017-07-04', '2017-09-04', '2017-10-09', '2017-11-10', '2017-11-23', '2017-12-25'],
  2018: ['2018-01-01', '2018-01-15', '2018-02-19', '2018-05-28', '2018-07-04', '2018-09-03', '2018-10-08', '2018-11-12', '2018-11-22', '2018-12-25'],
  2019: ['2019-01-01', '2019-01-21', '2019-02-18', '2019-05-27', '2019-07-04', '2019-09-02', '2019-10-14', '2019-11-11', '2019-11-28', '2019-12-25'],
  2020: ['2020-01-01', '2020-01-20', '2020-02-17', '2020-05-25', '2020-07-03', '2020-09-07', '2020-10-12', '2020-11-11', '2020-11-26', '2020-12-25'],
  2021: ['2021-01-01', '2021-01-18', '2021-02-15', '2021-05-31', '2021-06-18', '2021-07-05', '2021-09-06', '2021-10-11', '2021-11-11', '2021-11-25', '2021-12-24', '2021-12-31'],
  2022: ['2022-01-17', '2022-02-21', '2022-05-30', '2022-06-20', '2022-07-04', '2022-09-05', '2022-10-10', '2022-11-11', '2022-11-24', '2022-12-26'],
  2023: ['2023-01-02', '2023-01-16', '2023-02-20', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04', '2023-10-09', '2023-11-10', '2023-11-23', '2023-12-25'],
  2024: ['2024-01-01', '2024-01-15', '2024-02-19', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-10-14', '2024-11-11', '2024-11-28', '2024-12-25'],
  2025: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25'],
  2026: US_HOLIDAYS_2026,
});

/**
 * One-off closures of the federal government: not holidays, but agencies
 * shut, so a release due that day moves as it would for a holiday. Only the
 * VERIFIED ones: Carter's national day of mourning (Thu 9 Jan 2025, so the
 * claims due that day are placed on the Wednesday) and Executive Order 14371
 * (24 and 26 Dec 2025). The data file's 2018–2020 Christmas-Eve and Bush
 * closures and the 2024 Christmas Eve are unverified or single-mention, and
 * left out.
 */
export const US_CLOSURES = Object.freeze(['2025-01-09', '2025-12-24', '2025-12-26']);

const HOLIDAY_SET = new Set([...Object.values(US_HOLIDAYS).flat(), ...US_CLOSURES]);

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function isBusinessDay(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAY_SET.has(iso(y, m, d));
}

/** Day-of-month of the nth US business day of a month (1-based). */
function nthBusinessDay(y, m, n) {
  let count = 0;
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    if (isBusinessDay(y, m, d)) { count++; if (count === n) return d; }
  }
  return null;
}

/* ------------------------------------------------- DST misalignment ----- */

/**
 * The windows where the US and EU/UK clocks are out of step.
 *
 * This is the single most useful thing this tool knows, and no retail calendar
 * shows it. Most retail MT5 servers run GMT+2 in winter and GMT+3 in summer,
 * on the EUROPEAN schedule. Outside these windows, 08:30 New York always lands
 * at 15:30 server time, so a trader learns "US news is at 15:30 on my chart".
 *
 * Inside these windows the US has changed and Europe has not (or vice versa),
 * so 08:30 New York lands at 14:30 server time — an hour EARLIER than the
 * candle they are used to. Both windows shift it earlier, never later.
 */
export const DST_MISALIGNMENT_WINDOWS = [
  { from: '2026-03-08', to: '2026-03-29', note: 'US on DST, Europe not yet', confidence: 'likely' },
  { from: '2026-10-25', to: '2026-11-01', note: 'Europe off DST, US still on', confidence: 'likely' },
  { from: '2027-03-14', to: '2027-03-28', note: 'US on DST, Europe not yet', confidence: 'likely' },
  { from: '2027-10-31', to: '2027-11-07', note: 'Europe off DST, US still on', confidence: 'likely' },
];

export function dstMisalignment(atMs) {
  const d = new Date(atMs);
  const key = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  const w = DST_MISALIGNMENT_WINDOWS.find((x) => key >= x.from && key < x.to);
  if (!w) return null;
  return {
    active: true,
    ...w,
    message: 'US releases are landing ONE HOUR EARLIER on a GMT+2/+3 broker chart this week than they do the rest of the year.',
  };
}

/* ------------------------------------------------------------- the data */

/**
 * tier 1 — stand aside entirely. Flat before, no new entry after.
 * tier 2 — reduce. Flat briefly either side.
 * tier 3 — stay aware. No NEW entry in the couple of minutes either side.
 * context — never a reason to go flat. Background only, no countdown urgency.
 *
 * Blackout minutes are deliberately conservative professional judgement, not a
 * sourced figure. They are yours to change in Settings.
 */
export const EVENTS = [
  /* ---------------------------------------------------------- TIER 1 --- */
  {
    id: 'nfp', name: 'Non-Farm Payrolls', short: 'NFP', agency: 'BLS',
    affects: 'both', tier: 1, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'dates', dates: [
      // 2017–2024: only the months a source confirmed (data/calendar-history.json).
      '2017-01-06', '2017-02-03', '2017-04-07', '2017-06-02', '2017-07-07', '2017-08-04',
      '2018-08-03',
      '2019-01-04', '2019-08-02',
      '2020-07-02',   // a Thursday: Friday 3 July 2020 was the observed holiday
      // 2021–2023: no source found, so none.
      '2024-01-05', '2024-02-02', '2024-03-08', '2024-09-06', '2024-10-04', '2024-12-06',
      // 2025, complete as published. The shutdown (1 Oct – 12 Nov) moved September's
      // report to Thu 20 Nov and November's to Tue 16 Dec; October's never came out.
      '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02', '2025-06-06',
      '2025-07-03', '2025-08-01', '2025-09-05', '2025-11-20', '2025-12-16',
      // 2026. January's report came out Wed 11 Feb, not Fri 6 Feb: a brief shutdown
      // from 31 January delayed it (verified, three sources; this table had 6 Feb).
      '2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05',
      '2026-07-02', '2026-08-07', '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
    ],
    // Release date → the date BLS had scheduled, where a shutdown moved it; and the
    // scheduled dates of reports never published. The monthly ADP keys off these.
    rescheduledFrom: { '2025-11-20': '2025-10-03', '2025-12-16': '2025-12-05', '2026-02-11': '2026-02-06' },
    cancelled: ['2025-11-07'],
    confidenceByYear: { 2017: 'likely', 2018: 'likely', 2019: 'likely', 2020: 'verified', 2024: 'likely', 2025: 'likely' } },
    blackoutBefore: 15, blackoutAfter: 30,
    why: 'The month\'s single biggest repricing of Fed expectations. Gold moves on the rate path; bitcoin moves on risk appetite.',
    typicalMove: { XAUUSD: '0.5-1.2% of price, tails past 2%', BTCUSD: '1-3%' },
    confidence: 'likely',
    note: 'NOT the first Friday — Jan, Feb, May and Jul 2026 all differ (February\'s was delayed to Wednesday the 11th). Table-driven for exactly this reason. Before 2025 the history is partial: 2017 has 6 months, 2018 one, 2019 two, 2020 one, 2021–2023 none, 2024 six.',
  },
  {
    id: 'cpi', name: 'US CPI / Core CPI', short: 'CPI', agency: 'BLS',
    affects: 'both', tier: 1, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'dates', dates: [
      // 2017–2023: only the months a source confirmed; 2024: none found.
      '2017-01-18', '2017-02-15',
      '2018-02-14', '2018-03-13', '2018-06-12',   // 14 Feb 2018 from indirect evidence only
      '2019-04-10',
      '2020-02-13', '2020-12-10',
      '2021-05-12', '2021-12-10',
      '2022-05-11', '2022-10-13', '2022-12-13',
      '2023-07-12',
      // 2025, complete as published. The shutdown moved September's CPI to Fri 24 Oct and
      // November's to Thu 18 Dec; October's was cancelled outright.
      '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11',
      '2025-07-15', '2025-08-12', '2025-09-11', '2025-10-24', '2025-12-18',
      // 2026. January's CPI came out Fri 13 Feb, not Wed 11 Feb: the same brief shutdown
      // (likely, two sources; this table had 11 Feb).
      '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10',
      '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10',
    ],
    rescheduledFrom: { '2025-10-24': '2025-10-15', '2025-12-18': '2025-12-10', '2026-02-13': '2026-02-11' },
    confidenceByYear: { 2017: 'likely', 2018: 'unverified', 2019: 'likely', 2020: 'likely', 2021: 'likely', 2022: 'likely', 2023: 'likely', 2025: 'likely' } },
    blackoutBefore: 15, blackoutAfter: 30,
    why: 'Core CPI month-on-month is the number that moves gold. Headline is comparative noise.',
    typicalMove: { XAUUSD: 'comparable to NFP', BTCUSD: 'the highest macro R-squared of 2026' },
    confidence: 'likely',
    note: 'Roughly the 10th-14th with no derivable rule. Verify against your broker calendar. Before 2025 the history is partial: one to three months a year for 2017–2023, none for 2024.',
  },
  {
    id: 'fomc-statement', name: 'FOMC rate decision', short: 'FOMC', agency: 'Federal Reserve',
    affects: 'both', tier: 1, tz: NY, at: { h: 14, m: 0 },
    // Every scheduled meeting's decision day (its second day), 2017–2026. Three fell
    // on a Thursday, the meeting moved back a day after a US election: 8 Nov 2018,
    // 5 Nov 2020 and 7 Nov 2024. Left out on purpose, because their times are not
    // verified: the unscheduled actions of 3 Mar 2020 (an emergency cut, mid-morning
    // New York), 15 Mar 2020 (a Sunday-evening meeting that replaced the scheduled
    // 17–18 March one, so March 2020 has no row), 23 Mar 2020 (open-ended purchases,
    // pre-market) and the 11 Oct 2019 bill-purchase notation vote.
    schedule: { kind: 'dates', dates: [
      '2017-02-01', '2017-03-15', '2017-05-03', '2017-06-14', '2017-07-26', '2017-09-20', '2017-11-01', '2017-12-13',
      '2018-01-31', '2018-03-21', '2018-05-02', '2018-06-13', '2018-08-01', '2018-09-26', '2018-11-08', '2018-12-19',
      '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18', '2019-10-30', '2019-12-11',
      '2020-01-29', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
      '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
      '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
      '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
      '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
      '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
      '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    ],
    confidenceByYear: { 2017: 'verified', 2018: 'verified', 2019: 'verified', 2020: 'likely', 2021: 'verified', 2022: 'verified', 2023: 'verified', 2024: 'verified', 2025: 'verified' } },
    blackoutBefore: 20, blackoutAfter: 100,
    why: 'The statement at 14:00 and the press conference at 14:30 are two separate events, and the 30 minutes between them is not safe. The blackout deliberately spans both.',
    typicalMove: { XAUUSD: 'largest scheduled mover of the month', BTCUSD: 'large' },
    confidence: 'likely',
    note: 'March, June, September and December also carry the SEP and dot plot, which land with the statement and make those meetings heavier. Every scheduled meeting since 2017 is listed; the unscheduled 2020 actions are not.',
  },
  {
    id: 'fomc-presser', name: 'Fed Chair press conference', short: 'Presser', agency: 'Federal Reserve',
    affects: 'both', tier: 1, tz: NY, at: { h: 14, m: 30 },
    // 2017–2018: only after the March, June, September and December meetings.
    // Every meeting from 2019 (announced by Powell in June 2018).
    schedule: { kind: 'dates', dates: [
      '2017-03-15', '2017-06-14', '2017-09-20', '2017-12-13',
      '2018-03-21', '2018-06-13', '2018-09-26', '2018-12-19',
      '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18', '2019-10-30', '2019-12-11',
      '2020-01-29', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
      '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
      '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
      '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
      '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
      '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
      '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    ],
    confidenceByYear: { 2017: 'verified', 2018: 'verified', 2019: 'verified', 2020: 'likely', 2021: 'verified', 2022: 'verified', 2023: 'verified', 2024: 'verified', 2025: 'verified' } },
    blackoutBefore: 10, blackoutAfter: 60,
    why: 'Frequently a bigger mover than the statement, and often in the opposite direction. The Q&A does the damage, not the prepared remarks.',
    confidence: 'likely',
    note: 'Kevin Warsh became Chair in May 2026, so there is little history to calibrate his reaction function. Do not size these days from 2024-25 volatility.',
  },
  {
    id: 'pce', name: 'Core PCE price index', short: 'PCE', agency: 'BEA',
    affects: 'both', tier: 1, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'dates', dates: [
      // 2025 as published (January's release is unsourced and left out). The shutdown
      // moved September's data to Fri 5 Dec at 10:00; there was no release in November.
      '2025-02-28', '2025-03-28', '2025-04-30', '2025-05-30', '2025-06-27', '2025-07-31',
      '2025-08-29', '2025-09-26', '2025-12-05',
      '2026-07-30', '2026-08-26', '2026-09-30', '2026-10-06', '2026-10-29', '2026-11-20',
    ],
    // Releases off the usual 08:30 slot (New York time).
    times: { '2025-04-30': { h: 10, m: 0 }, '2025-12-05': { h: 10, m: 0 } },
    rescheduledFrom: { '2025-12-05': '2025-10-31' },
    confidenceByYear: { 2025: 'likely' } },
    blackoutBefore: 10, blackoutAfter: 20,
    why: 'The Fed\'s own target measure. Usually a smaller impulse than CPI because CPI and PPI have already telegraphed it.',
    confidence: 'unverified',
    note: 'BEA broke its own last-business-day pattern twice in 2026 and issued a schedule advisory. This list is partial — check before relying on it. January to June 2026 are missing (the shutdown catch-up moved them), and nothing before 2025 is listed.',
  },

  /* ---------------------------------------------------------- TIER 2 --- */
  {
    id: 'jobless', name: 'Initial jobless claims', short: 'Claims', agency: 'DOL',
    affects: 'both', tier: 2, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'weekly', weekday: 4, shiftsOnHolidayWeek: true },
    blackoutBefore: 5, blackoutAfter: 10,
    why: 'Weekly, and normally minor — but it shares the 08:30 slot and escalates whenever the labour market is the live Fed question, which it is in 2026.',
    confidence: 'likely',
    note: 'Moves forward to Wednesday in weeks containing a federal holiday. The tool shifts it automatically; confirm in holiday weeks.',
  },
  {
    id: 'ism-services', name: 'ISM Services PMI', short: 'ISM Svc', agency: 'ISM',
    affects: 'both', tier: 2, tz: NY, at: { h: 10, m: 0 },
    schedule: { kind: 'nthBusinessDay', n: 3 },
    blackoutBefore: 5, blackoutAfter: 15,
    why: 'The bigger gold mover of the two ISM surveys. Can share the 10:00 slot with JOLTS, which stacks them.',
    confidence: 'likely',
  },
  {
    id: 'ism-mfg', name: 'ISM Manufacturing PMI', short: 'ISM Mfg', agency: 'ISM',
    affects: 'both', tier: 2, tz: NY, at: { h: 10, m: 0 },
    schedule: { kind: 'nthBusinessDay', n: 1 },
    blackoutBefore: 5, blackoutAfter: 15,
    why: 'First business day of the month, respecting federal holidays.',
    confidence: 'likely',
  },
  {
    id: 'adp-monthly', name: 'ADP employment (monthly)', short: 'ADP', agency: 'ADP',
    affects: 'both', tier: 2, tz: NY, at: { h: 8, m: 15 },
    // Two days before the date BLS SCHEDULED the report (nfp's rescheduledFrom and
    // cancelled): ADP is a private payroll firm, so a shutdown that delays the BLS
    // report does not move ADP's. Anchoring on the delayed date put it on a Sunday
    // (14 Dec 2025) and moved February 2026's off Wednesday the 4th.
    schedule: { kind: 'weekdayBeforeEvent', eventId: 'nfp', offsetDays: -2 },
    blackoutBefore: 5, blackoutAfter: 15,
    why: 'A read on NFP two days early.',
    confidence: 'likely',
    note: 'Lands at 08:15, not 08:30 — fifteen minutes before the slot most people guard.',
  },
  {
    id: 'adp-pulse', name: 'ADP weekly NER Pulse', short: 'ADP wk', agency: 'ADP',
    affects: 'both', tier: 3, tz: NY, at: { h: 8, m: 15 },
    schedule: { kind: 'weekly', weekday: 2 },
    blackoutBefore: 2, blackoutAfter: 3,
    why: 'New in 2026 and absent from most economic calendars: a weekly preliminary employment estimate, roughly 40 extra scheduled events a year.',
    confidence: 'unverified',
    note: 'Skips the week of the monthly report. Minor individually, but it is a real spread event at an unusual time.',
  },
  {
    id: 'fomc-minutes', name: 'FOMC minutes', short: 'Minutes', agency: 'Federal Reserve',
    affects: 'both', tier: 2, tz: NY, at: { h: 14, m: 0 },
    schedule: { kind: 'daysAfterDates', dates: [
      '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
      '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    ], offsetDays: 21 },
    blackoutBefore: 5, blackoutAfter: 20,
    why: 'Routinely produces a sharp 5-15 minute move when the tone diverges from the statement.',
    confidence: 'likely',
    note: 'Exactly three weeks after the SECOND day of each meeting — anchoring to day one gives the wrong date every time.',
  },
  {
    id: 'retail-sales', name: 'US retail sales (advance)', short: 'Retail', agency: 'Census',
    affects: 'both', tier: 2, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'monthlyApprox', day: 16 },
    blackoutBefore: 5, blackoutAfter: 15,
    why: 'The control-group figure is what traders read.',
    confidence: 'unverified',
    note: 'Approximate — mid-month, no published rule. Treat the date as indicative.',
    approximate: true,
  },
  {
    id: 'ecb', name: 'ECB decision and press conference', short: 'ECB', agency: 'ECB',
    affects: 'XAUUSD', tier: 2, tz: 'Europe/Berlin', at: { h: 14, m: 15 },
    schedule: { kind: 'dates', dates: ['2026-09-10', '2026-10-29', '2026-12-17'] },
    blackoutBefore: 5, blackoutAfter: 45,
    why: 'Moves gold through the euro and the dollar index. In US summer the 14:15 CET decision sits 15 minutes BEFORE the US 08:30 slot, so an ECB day with US data means two events a quarter-hour apart.',
    confidence: 'unverified',
    note: 'Decision 14:15 CET, press conference 14:45 CET. Meeting dates partially verified only.',
  },

  /* ---------------------------------------------------------- TIER 3 --- */
  {
    id: 'flash-pmi', name: 'S&P Global flash PMIs', short: 'Flash PMI', agency: 'S&P Global',
    affects: 'both', tier: 3, tz: NY, at: { h: 9, m: 45 },
    schedule: { kind: 'monthlyApprox', day: 23 },
    blackoutBefore: 2, blackoutAfter: 3,
    why: 'An off-grid 09:45 slot, 15 minutes before the 10:00 cluster. The European and UK flash PMIs earlier the same morning can pre-load the dollar move.',
    confidence: 'unverified', approximate: true,
    note: 'Third or fourth week of the month, exact date not confirmed. The 09:45 time is the well-known slot but was not verified against S&P Global directly.',
  },
  {
    id: 'consumer-confidence', name: 'CB Consumer Confidence', short: 'Conf', agency: 'Conference Board',
    affects: 'XAUUSD', tier: 3, tz: NY, at: { h: 10, m: 0 },
    schedule: { kind: 'lastWeekdayOfMonth', weekday: 2 },
    blackoutBefore: 2, blackoutAfter: 3,
    why: 'One of the few US releases that genuinely does follow a clean calendar rule: the last Tuesday of every month.',
    confidence: 'likely',
  },
  {
    id: 'umich', name: 'UoM sentiment (preliminary)', short: 'UoM', agency: 'Univ. of Michigan',
    affects: 'XAUUSD', tier: 3, tz: NY, at: { h: 10, m: 0 },
    schedule: { kind: 'nthWeekdayOfMonth', weekday: 5, n: 2 },
    blackoutBefore: 2, blackoutAfter: 3,
    why: 'The inflation-expectations components move gold, not the headline. A big revision to the 5-10 year number can produce a tier-2 candle from a tier-3 event.',
    confidence: 'unverified', approximate: true,
    note: 'Preliminary lands roughly the second Friday and the final roughly the last, but neither is a firm rule and the dates were not confirmed at source.',
  },

  /* -------------------------------------------------- CRYPTO-NATIVE ---- */
  {
    id: 'deribit-expiry', name: 'Deribit monthly options expiry', short: 'Deribit', agency: 'Deribit',
    affects: 'BTCUSD', tier: 2, tz: 'UTC', at: { h: 8, m: 0 },
    schedule: { kind: 'lastWeekdayOfMonth', weekday: 5 },
    settlementWindowMin: 30,
    blackoutBefore: 35, blackoutAfter: 10,
    why: 'Settlement is a 07:30-08:00 UTC TWAP, not an instant at 08:00, so the window is what matters. Quarterlies (Mar, Jun, Sep, Dec) are the large ones.',
    confidence: 'likely',
    note: 'Max pain is context at best. Deribit itself said a $12bn quarterly expiry was unlikely to cause a major reaction, and 2026 repeatedly bore that out. Ignore daily expiries entirely.',
  },
  {
    id: 'cme-btc-settle', name: 'CME bitcoin futures settlement', short: 'CME', agency: 'CME',
    affects: 'BTCUSD', tier: 3, tz: LDN, at: { h: 16, m: 0 },
    schedule: { kind: 'lastWeekdayOfMonth', weekday: 5 },
    blackoutBefore: 5, blackoutAfter: 5,
    why: 'Settles to the BRR at 16:00 London. Note the zone: London, not New York — during the late-October misalignment week that is an hour out from where a fixed offset would put it.',
    confidence: 'likely',
  },
  {
    id: 'funding', name: 'Perp funding settlement', short: 'Funding', agency: 'Binance / Bybit / OKX',
    affects: 'BTCUSD', tier: 'context', tz: 'UTC',
    schedule: { kind: 'dailyTimes', times: [{ h: 0, m: 0 }, { h: 8, m: 0 }, { h: 16, m: 0 }] },
    blackoutBefore: 0, blackoutAfter: 0,
    why: 'Positioning context, not a trade trigger. Funding RATE and its trend tell you about crowding; the settlement timestamp does not.',
    confidence: 'likely',
    note: 'Binance has moved some contracts to 4-hour cycles and can drop to hourly under stress, so do not treat 8-hourly as fixed.',
  },
  {
    id: 'mtgox', name: 'Mt Gox repayment deadline', short: 'Mt Gox', agency: 'Trustee',
    affects: 'BTCUSD', tier: 'context', tz: 'UTC', at: { h: 0, m: 0 },
    schedule: { kind: 'dates', dates: ['2026-10-31'] },
    blackoutBefore: 0, blackoutAfter: 0,
    why: 'A known overhang with roughly 34,500 BTC still held. A date to be aware of, not a minute to be flat for.',
    confidence: 'unverified',
    note: 'The deadline has been extended repeatedly in past years and the figure held is an estimate. Treat as background, and do not expect it to resolve on the date shown.',
  },

  /* -------------------------------------------------- GOLD CONTEXT ----- */
  {
    id: 'lbma-pm', name: 'LBMA PM gold auction', short: 'LBMA PM', agency: 'ICE Benchmark Admin.',
    affects: 'XAUUSD', tier: 'context', tz: LDN, at: { h: 15, m: 0 },
    schedule: { kind: 'weekdays' },
    blackoutBefore: 0, blackoutAfter: 0,
    why: 'Reliably produces a brief liquidity and volatility pocket as participants hedge the fix. Worth knowing about; not worth going flat for.',
    confidence: 'likely',
    note: 'The LBMA opened a consultation in 2026 on moving the MORNING auction earlier for Asian hours. Treat the times as configurable, not fixed.',
  },
  {
    id: 'cot', name: 'CFTC Commitments of Traders', short: 'COT', agency: 'CFTC',
    affects: 'XAUUSD', tier: 'context', tz: NY, at: { h: 15, m: 30 },
    schedule: { kind: 'weekly', weekday: 5 },
    blackoutBefore: 0, blackoutAfter: 0,
    why: 'Positioning context only. The data is already three days stale when published — it reflects the preceding Tuesday\'s close.',
    confidence: 'likely',
    note: 'A crowded speculative long is a squeeze-risk flag, nothing more. Never a reason to go flat on M5.',
  },
];

/* --------------------------------------------------- date expansion ---- */

function shiftForHoliday(y, m, d) {
  // Weekly releases move EARLIER in a week containing a federal holiday.
  let day = d;
  for (let i = 0; i < 3; i++) {
    if (isBusinessDay(y, m, day)) break;
    day -= 1;
  }
  // If any holiday falls earlier in the same week, the release pulls forward.
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  for (let back = 1; back <= dow; back++) {
    const probe = day - back;
    if (probe >= 1 && HOLIDAY_SET.has(iso(y, m, probe))) return day - 1;
  }
  return day;
}

/**
 * The dates an event was SCHEDULED for: its release dates mapped back through
 * `rescheduledFrom`, plus the scheduled dates of releases that were cancelled.
 * Equal to `dates` for an event no shutdown touched.
 */
function scheduledDates(s) {
  const moved = s.rescheduledFrom || {};
  return [...s.dates.map((x) => moved[x] || x), ...(s.cancelled || [])];
}

/** Concrete { y, m, d } occurrences of one event within a UTC range. */
function occurrences(ev, fromMs, toMs) {
  const out = [];
  const s = ev.schedule;
  const startY = new Date(fromMs).getUTCFullYear();
  const endY = new Date(toMs).getUTCFullYear();
  // Date tables now run 2017–2026; a date more than two days outside the range
  // cannot land inside it in any zone, so it is skipped before the costly
  // wall-clock conversion (the gate looks up blackouts at every check).
  const lo = new Date(fromMs - 2 * 86400e3).toISOString().slice(0, 10);
  const hi = new Date(toMs + 2 * 86400e3).toISOString().slice(0, 10);
  const near = (str) => str >= lo && str <= hi;

  const pushDate = (str, extra = {}) => {
    const [y, m, d] = str.split('-').map(Number);
    out.push({ y, m, d, ...extra });
  };
  const pushOffset = (base, offsetDays) => {
    const [by, bm, bd] = base.split('-').map(Number);
    const dt = new Date(Date.UTC(by, bm - 1, bd) + offsetDays * 86400e3);
    const str = dt.toISOString().slice(0, 10);
    if (near(str)) pushDate(str);
  };

  switch (s.kind) {
    case 'dates':
      // A date can carry its own time (`times`) where it left the usual slot.
      for (const x of s.dates) if (near(x)) pushDate(x, s.times && s.times[x] ? { at: s.times[x] } : {});
      break;

    case 'daysAfterDates':
      for (const base of s.dates) pushOffset(base, s.offsetDays);
      break;

    case 'weekdayBeforeEvent': {
      const anchor = EVENTS.find((e) => e.id === s.eventId);
      if (anchor && anchor.schedule.kind === 'dates') {
        for (const base of scheduledDates(anchor.schedule)) pushOffset(base, s.offsetDays);
      }
      break;
    }

    case 'weekly': {
      const d = new Date(fromMs);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - 7);
      while (d.getTime() <= toMs + 86400e3) {
        if (d.getUTCDay() === s.weekday) {
          const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
          let day = d.getUTCDate();
          if (s.shiftsOnHolidayWeek) day = shiftForHoliday(y, m, day);
          out.push({ y, m, d: day, shifted: day !== d.getUTCDate() });
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      break;
    }

    case 'weekdays': {
      const d = new Date(fromMs);
      d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() <= toMs + 86400e3) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) {
          out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      break;
    }

    case 'dailyTimes': {
      const d = new Date(fromMs);
      d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() <= toMs + 86400e3) {
        for (const t of s.times) {
          out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), at: t });
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      break;
    }

    default:
      for (let y = startY; y <= endY; y++) {
        for (let m = 1; m <= 12; m++) {
          let d = null;
          if (s.kind === 'nthWeekdayOfMonth') d = nthWeekdayOfMonth(y, m, s.weekday, s.n);
          else if (s.kind === 'lastWeekdayOfMonth') d = lastWeekdayOfMonth(y, m, s.weekday);
          else if (s.kind === 'nthBusinessDay') d = nthBusinessDay(y, m, s.n);
          else if (s.kind === 'monthlyApprox') d = Math.min(s.day, daysInMonth(y, m));
          if (d && d >= 1 && d <= daysInMonth(y, m)) out.push({ y, m, d });
        }
      }
  }
  return out;
}

/* ------------------------------------------------------------- the API */

/**
 * Calendar modes, for reading history.
 *
 * Live, the calendar is always 'full'. Over past years it is not the same
 * calendar in every year: the date-listed events (NFP, CPI, FOMC, PCE, ECB,
 * FOMC minutes, and the monthly ADP that is placed two days before each listed
 * NFP) exist only where their dates were typed in from sources, while the
 * rule-derived ones (weekly claims, ISM by business day, approximate retail
 * sales and flash PMI, month-end expiries, the weekly ADP pulse) compute for
 * any year. A multi-year history therefore states which it used:
 *   'full'   every event, as live
 *   'rules'  only the rule-derived events — the same calendar in every year
 *   'none'   no events at all: no blackouts, no "major release soon"
 * Which events count as table-driven is decided by their schedule kind, so an
 * event added later is classified without anyone remembering to.
 */
export const CALENDAR_MODES = ['full', 'rules', 'none'];
const TABLE_KINDS = new Set(['dates', 'daysAfterDates', 'weekdayBeforeEvent']);
export function fromDateTable(ev) {
  return TABLE_KINDS.has(ev.schedule.kind);
}
function inCalendar(ev, calendar) {
  if (calendar === 'none') return false;
  if (calendar === 'rules') return !fromDateTable(ev);
  return true;
}

/**
 * How well one year's dates of an event are established: the year's entry in
 * `confidenceByYear` (the weakest date that year), else the event's own
 * confidence, which describes 2026. Never stronger than the data file says.
 */
export function confidenceOf(ev, year) {
  const byYear = ev.schedule && ev.schedule.confidenceByYear;
  return (byYear && byYear[year]) || ev.confidence;
}

/**
 * Concrete upcoming events, sorted, for one pair.
 * `pair` is 'XAUUSD', 'BTCUSD', or null for both.
 */
export function getUpcomingEvents(fromMs, horizonHours = 48, pair = null, opts = {}) {
  const { includeContext = true, minTier = 3, calendar = 'full' } = opts;
  const toMs = fromMs + horizonHours * 3600e3;
  const rows = [];

  for (const ev of EVENTS) {
    if (!inCalendar(ev, calendar)) continue;
    if (pair && ev.affects !== 'both' && ev.affects !== pair) continue;
    if (!includeContext && ev.tier === 'context') continue;
    if (typeof ev.tier === 'number' && ev.tier > minTier) continue;

    for (const occ of occurrences(ev, fromMs - 6 * 3600e3, toMs)) {
      const at = occ.at || ev.at || { h: 0, m: 0 };
      const ts = ev.tz === 'UTC'
        ? Date.UTC(occ.y, occ.m - 1, occ.d, at.h, at.m)
        : zonedTimeToUtc(occ.y, occ.m, occ.d, at.h, at.m, ev.tz);
      if (ts < fromMs - 3 * 3600e3 || ts > toMs) continue;

      rows.push({
        ...ev,
        // The confidence of this occurrence's own year where the table keeps one,
        // so a 2019 FOMC row reads "verified" and a 2018 CPI row "unverified";
        // otherwise the event's (2026's), as before.
        confidence: confidenceOf(ev, occ.y),
        at,
        ts,
        msAway: ts - fromMs,
        minutesAway: Math.round((ts - fromMs) / 60000),
        dateShifted: !!occ.shifted,
        // Settlement-window events start their blackout before the window opens.
        windowStartTs: ev.settlementWindowMin ? ts - ev.settlementWindowMin * 60000 : ts,
      });
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Is a blackout in force right now for this pair?
 *
 * Returns the single most severe active window, or null. `context` events never
 * produce a blackout however close they are — treating them as blockers would
 * keep a scalper out of good trades for no reason. `calendar` is one of
 * CALENDAR_MODES; live callers leave it at 'full'.
 */
export function getActiveBlackout(atMs, pair = null, overrides = {}, { calendar = 'full' } = {}) {
  const candidates = getUpcomingEvents(atMs - 6 * 3600e3, 12, pair, { includeContext: false, calendar });
  let best = null;

  for (const ev of candidates) {
    if (ev.tier === 'context') continue;
    const before = overrides[`${ev.id}Before`] ?? ev.blackoutBefore;
    const after = overrides[`${ev.id}After`] ?? ev.blackoutAfter;
    if (!before && !after) continue;

    const opens = ev.windowStartTs - before * 60000;
    const closes = ev.ts + after * 60000;
    if (atMs < opens || atMs > closes) continue;

    const phase = atMs < ev.ts ? 'before' : 'after';
    const row = {
      active: true,
      event: ev,
      phase,
      minutesAway: Math.max(0, Math.round((ev.ts - atMs) / 60000)),
      minutesSince: Math.max(0, Math.round((atMs - ev.ts) / 60000)),
      tier: ev.tier,
      endsAtMs: closes,
    };
    if (!best || row.tier < best.tier) best = row;
  }
  return best;
}

/**
 * Where a UTC instant lands on the user's MT5 chart, plus the misalignment
 * warning. `serverUtcOffsetHours` comes from the user reading their broker's
 * Market Watch clock — it is never assumed.
 */
export function brokerChartTime(ts, serverUtcOffsetHours) {
  if (serverUtcOffsetHours === null || serverUtcOffsetHours === undefined) return null;
  const shifted = new Date(ts + serverUtcOffsetHours * 3600e3);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return { text: `${hh}:${mm}`, offset: serverUtcOffsetHours, misalignment: dstMisalignment(ts) };
}

/**
 * Correlation warning. The user trades BOTH of these pairs, and in 2026 they
 * are unusually tightly linked — a 90-day BTC/gold correlation around 0.56,
 * a nine-year high, against only ~0.33 for BTC and the Nasdaq.
 *
 * Taking the same direction on both after a macro print is one doubled
 * position, not two diversified ones. This is stated up front rather than
 * buried, because it is the mistake the dashboard itself could encourage.
 */
export const CORRELATION_NOTE = {
  pairs: 'XAUUSD / BTCUSD',
  value: 0.56,
  window: '90 day',
  asOf: '2026-09',
  confidence: 'likely',
  message: 'Gold and bitcoin are currently about 0.56 correlated on a 90-day basis, near a nine-year high. Long both, or short both, is one position at double size — especially in the hour after a US macro print. Size accordingly.',
};

/** Events the calendar deliberately does NOT try to time. */
export const UNSCHEDULABLE = [
  'Geopolitical escalation',
  'Surprise central-bank action',
  'US government shutdown and debt-ceiling brinkmanship',
  'Banking stress',
  'Bitcoin liquidation cascades',
  'Exchange outages, hacks and depegs',
];
