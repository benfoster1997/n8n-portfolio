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
 *    9 January, 8 May and 7 August are SECOND Fridays, and 2 July is a
 *    THURSDAY because Friday 3 July is the observed Independence Day holiday.
 *    CPI has no derivable rule at all. BEA moved PCE off its usual slot twice.
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
const HOLIDAY_SET = new Set(US_HOLIDAYS_2026);

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
      '2026-01-09', '2026-02-06', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05',
      '2026-07-02', '2026-08-07', '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
    ] },
    blackoutBefore: 15, blackoutAfter: 30,
    why: 'The month\'s single biggest repricing of Fed expectations. Gold moves on the rate path; bitcoin moves on risk appetite.',
    typicalMove: { XAUUSD: '0.5-1.2% of price, tails past 2%', BTCUSD: '1-3%' },
    confidence: 'likely',
    note: 'NOT the first Friday — Jan, May and Jul 2026 all differ. Table-driven for exactly this reason.',
  },
  {
    id: 'cpi', name: 'US CPI / Core CPI', short: 'CPI', agency: 'BLS',
    affects: 'both', tier: 1, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'dates', dates: [
      '2026-01-13', '2026-02-11', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10',
      '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10',
    ] },
    blackoutBefore: 15, blackoutAfter: 30,
    why: 'Core CPI month-on-month is the number that moves gold. Headline is comparative noise.',
    typicalMove: { XAUUSD: 'comparable to NFP', BTCUSD: 'the highest macro R-squared of 2026' },
    confidence: 'likely',
    note: 'Roughly the 10th-14th with no derivable rule. Verify against your broker calendar.',
  },
  {
    id: 'fomc-statement', name: 'FOMC rate decision', short: 'FOMC', agency: 'Federal Reserve',
    affects: 'both', tier: 1, tz: NY, at: { h: 14, m: 0 },
    schedule: { kind: 'dates', dates: [
      '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
      '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    ] },
    blackoutBefore: 20, blackoutAfter: 100,
    why: 'The statement at 14:00 and the press conference at 14:30 are two separate events, and the 30 minutes between them is not safe. The blackout deliberately spans both.',
    typicalMove: { XAUUSD: 'largest scheduled mover of the month', BTCUSD: 'large' },
    confidence: 'likely',
    note: 'March, June, September and December also carry the SEP and dot plot, which land with the statement and make those meetings heavier.',
  },
  {
    id: 'fomc-presser', name: 'Fed Chair press conference', short: 'Presser', agency: 'Federal Reserve',
    affects: 'both', tier: 1, tz: NY, at: { h: 14, m: 30 },
    schedule: { kind: 'dates', dates: [
      '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
      '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
    ] },
    blackoutBefore: 10, blackoutAfter: 60,
    why: 'Frequently a bigger mover than the statement, and often in the opposite direction. The Q&A does the damage, not the prepared remarks.',
    confidence: 'likely',
    note: 'Kevin Warsh became Chair in May 2026, so there is little history to calibrate his reaction function. Do not size these days from 2024-25 volatility.',
  },
  {
    id: 'pce', name: 'Core PCE price index', short: 'PCE', agency: 'BEA',
    affects: 'both', tier: 1, tz: NY, at: { h: 8, m: 30 },
    schedule: { kind: 'dates', dates: [
      '2026-07-30', '2026-08-26', '2026-09-30', '2026-10-06', '2026-10-29', '2026-11-20',
    ] },
    blackoutBefore: 10, blackoutAfter: 20,
    why: 'The Fed\'s own target measure. Usually a smaller impulse than CPI because CPI and PPI have already telegraphed it.',
    confidence: 'unverified',
    note: 'BEA broke its own last-business-day pattern twice in 2026 and issued a schedule advisory. This list is partial — check before relying on it.',
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

/** Concrete { y, m, d } occurrences of one event within a UTC range. */
function occurrences(ev, fromMs, toMs) {
  const out = [];
  const s = ev.schedule;
  const startY = new Date(fromMs).getUTCFullYear();
  const endY = new Date(toMs).getUTCFullYear();

  const pushDate = (str, extra = {}) => {
    const [y, m, d] = str.split('-').map(Number);
    out.push({ y, m, d, ...extra });
  };

  switch (s.kind) {
    case 'dates':
      s.dates.forEach((x) => pushDate(x));
      break;

    case 'daysAfterDates':
      for (const base of s.dates) {
        const [by, bm, bd] = base.split('-').map(Number);
        const t = Date.UTC(by, bm - 1, bd) + s.offsetDays * 86400e3;
        const dt = new Date(t);
        out.push({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
      }
      break;

    case 'weekdayBeforeEvent': {
      const anchor = EVENTS.find((e) => e.id === s.eventId);
      if (anchor && anchor.schedule.kind === 'dates') {
        for (const base of anchor.schedule.dates) {
          const [by, bm, bd] = base.split('-').map(Number);
          const t = Date.UTC(by, bm - 1, bd) + s.offsetDays * 86400e3;
          const dt = new Date(t);
          out.push({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
        }
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
 * Concrete upcoming events, sorted, for one pair.
 * `pair` is 'XAUUSD', 'BTCUSD', or null for both.
 */
export function getUpcomingEvents(fromMs, horizonHours = 48, pair = null, opts = {}) {
  const { includeContext = true, minTier = 3 } = opts;
  const toMs = fromMs + horizonHours * 3600e3;
  const rows = [];

  for (const ev of EVENTS) {
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
 * keep a scalper out of good trades for no reason.
 */
export function getActiveBlackout(atMs, pair = null, overrides = {}) {
  const candidates = getUpcomingEvents(atMs - 6 * 3600e3, 12, pair, { includeContext: false });
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
