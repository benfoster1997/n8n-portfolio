/**
 * sessions.js — the trading window, and which hours inside it are worth taking.
 *
 * This file is written around ONE assumption that changes everything: the user
 * trades a fixed daily window and is not at the screen outside it. The default
 * is the London session, 08:00-16:00 Europe/London.
 *
 * That assumption makes most of a 24-hour session clock irrelevant. What
 * matters instead is: how much of my window is left, which hours inside it are
 * actually worth trading, and what is going to happen after I have stopped.
 *
 * EVERYTHING HERE IS ANCHORED TO LOCAL TIME IN A NAMED ZONE, NOT TO A UTC HOUR.
 * An earlier version keyed the quality bands to fixed UTC hours, which drifts
 * by an hour twice a year — the London open would have been graded as the
 * mid-morning lull all winter. The London session is 07:00-15:00 UTC in summer
 * and 08:00-16:00 UTC in winter; neither is "the" answer.
 */

import { zonedTimeToUtc, tzOffsetMs } from './timezone.js';

/** The user's window. Editable in Setup; this is the London default. */
export const DEFAULT_WINDOW = {
  start: { h: 8, m: 0 },
  end: { h: 16, m: 0 },
  tz: 'Europe/London',
  label: 'London session',
};

/** Fractional local hour (13.5 = 13:30) in a named zone. */
export function localHour(atMs, tz) {
  const off = tzOffsetMs(atMs, tz) / 3600e3;
  const d = new Date(atMs);
  return (((d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) + off) % 24 + 24) % 24;
}

/** Local calendar date in a named zone, as {y, m, d}. */
function localDate(atMs, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(atMs))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** Local weekday in a named zone. 0 = Sunday. */
export function localWeekday(atMs, tz) {
  const { y, m, d } = localDate(atMs, tz);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Where the clock is relative to the trading window.
 *
 * Phases are deliberately more granular than open/closed, because the last
 * hour of a session is a distinct state that deserves different handling from
 * the middle of one.
 */
export function windowState(atMs, win = DEFAULT_WINDOW) {
  const { y, m, d } = localDate(atMs, win.tz);
  const opens = zonedTimeToUtc(y, m, d, win.start.h, win.start.m, win.tz);
  const closes = zonedTimeToUtc(y, m, d, win.end.h, win.end.m, win.tz);
  const dow = localWeekday(atMs, win.tz);
  const weekend = dow === 0 || dow === 6;

  const minutesLeft = Math.round((closes - atMs) / 60000);
  const minutesIn = Math.round((atMs - opens) / 60000);
  const total = Math.round((closes - opens) / 60000);

  let phase;
  if (weekend) phase = 'weekend';
  else if (atMs < opens) phase = 'before';
  else if (atMs >= closes) phase = 'after';
  else if (minutesLeft <= 30) phase = 'last-30';
  else if (minutesLeft <= 60) phase = 'closing';
  else if (minutesIn <= 15) phase = 'opening';
  else phase = 'open';

  return {
    phase,
    open: phase === 'open' || phase === 'opening' || phase === 'closing' || phase === 'last-30',
    weekend,
    opensAtMs: opens,
    closesAtMs: closes,
    minutesLeft: Math.max(0, minutesLeft),
    minutesIn: Math.max(0, minutesIn),
    totalMinutes: total,
    fractionElapsed: total > 0 ? Math.min(1, Math.max(0, minutesIn / total)) : 0,
    localHour: localHour(atMs, win.tz),
    tz: win.tz,
  };
}

/** Is a given instant inside the window on its own local day? */
export function insideWindow(atMs, win = DEFAULT_WINDOW) {
  const { y, m, d } = localDate(atMs, win.tz);
  const opens = zonedTimeToUtc(y, m, d, win.start.h, win.start.m, win.tz);
  const closes = zonedTimeToUtc(y, m, d, win.end.h, win.end.m, win.tz);
  const dow = localWeekday(atMs, win.tz);
  if (dow === 0 || dow === 6) return false;
  return atMs >= opens && atMs < closes;
}

/**
 * Quality bands, in LONDON LOCAL HOURS.
 *
 * The two instruments differ sharply for a London-hours trader, and the honest
 * summary is that they are not equally well served by this window:
 *
 *  - Gold gets a volatility burst at the open, a genuinely poor mid-morning
 *    grind, and then its best liquidity of the day from 12:30 as US data lands
 *    and New York arrives. Most of a London session's opportunity in gold sits
 *    in its last three and a half hours.
 *
 *  - Bitcoin is largely asleep through the European morning. Its volume and
 *    range concentrate in US hours, which only begin as this window is ending.
 *    A London-session trader catches the start of bitcoin's best stretch and
 *    then stops. That is worth saying plainly rather than colouring in.
 */
const BANDS = {
  XAUUSD: [
    { from: 8, to: 9, band: 'amber', name: 'London satellite',
      note: 'Some genuine activity as London arrives, but gold is not an FX pair and it does not hand over liquidity at 08:00 the way the folklore says. Tradeable in small size; not the main event.' },
    { from: 9, to: 12.5, band: 'dead', name: 'Dead zone',
      note: 'The structural low of your day. Volume thins, the range collapses and the spread does not, so cost takes a far larger share of every trade. The 10:30 LBMA auction is statistically a non-event and will not rescue it. This is the stretch to sit out.' },
    { from: 12.5, to: 13.3, band: 'amber', name: 'Pre-data build',
      note: 'Books thickening ahead of the US data slot. Worth watching, not yet worth paying the spread for.' },
    { from: 13.3, to: 15, band: 'green', name: 'COMEX ramp and US data',
      note: 'Your day. COMEX regular hours open around 13:20, US data lands 13:30, New York equities at 14:30. The liquidity handover that matters for gold is this one, not the London open.' },
    { from: 15, to: 15.95, band: 'green', name: 'Late overlap',
      note: '15:00 carries the US 10:00 ET data slot AND the LBMA PM auction on the same minute — they are confounded, so read it as a data event that happens to coincide with an auction.' },
    { from: 15.95, to: 16.05, band: 'amber', name: 'The 16:00 fix',
      note: 'The WM/Reuters fix window. A documented volatility burst rather than a wind-down, and at month-end it is the most extreme flow of the day. Not a quiet way to finish.' },
  ],
  BTCUSD: [
    { from: 8, to: 12, band: 'dead', name: 'Worst hours of your day',
      note: 'These are the poorest bitcoin hours you could pick. The range is near its daily low while the CFD spread is unchanged, so it takes roughly a fifth of a typical candle. Gold is the better use of this stretch.' },
    { from: 12, to: 13.3, band: 'amber', name: 'Waking up',
      note: 'US participants beginning to arrive. Improving, not yet good.' },
    { from: 13.3, to: 16, band: 'green', name: 'Your bitcoin window',
      note: 'The only genuinely good bitcoin hours your schedule reaches — and its single most volatile hour falls in your last one. Roughly 38% of bitcoin\'s daily range comes in the seven hours after you close, so this is the end of your day, not the middle of its.' },
  ],
};

/**
 * Which of the two instruments is worth watching right now.
 *
 * This split is anchored to the London clock and is stable across both
 * seasons, which is a genuinely useful property: the LBMA auctions are defined
 * in London time and do not move, while bitcoin's peak tracks New York, so the
 * handover lands in the same place year-round.
 */
export function preferredInstrument(atMs, win = DEFAULT_WINDOW) {
  const h = localHour(atMs, win.tz);
  const dow = localWeekday(atMs, win.tz);
  if (dow === 0 || dow === 6) {
    return { pair: 'BTCUSD', confident: false, reason: 'Gold is closed at the weekend. Bitcoin trades on, but broker CFD feeds thin out and spreads widen.' };
  }
  if (h < 8 || h >= 16) return { pair: null, confident: false, reason: 'Outside your window.' };
  if (h < 13.3) {
    return {
      pair: 'XAUUSD', confident: true,
      reason: 'Before roughly 13:20 London, gold is the better of your two. Bitcoin is in its worst hours of the day and its spread does not shrink to match the smaller range.',
    };
  }
  return {
    pair: 'BTCUSD', confident: false,
    reason: 'From the US data slot onward both are live. Bitcoin only becomes properly tradeable here, and gold is at its best too — so this is a choice, not a steer.',
  };
}

/**
 * The cost floor: what one round trip costs before the chart is even consulted.
 *
 * Probably the single most actionable number for a trader running both of
 * these. It does not vary with the hour, and it says plainly that bitcoin
 * needs several times the move gold does just to get back to flat.
 */
export function costFloorBps(spread, price) {
  if (!(spread > 0) || !(price > 0)) return null;
  return +((spread / price) * 10000).toFixed(2);
}

export function sessionQuality(atMs, pair, win = DEFAULT_WINDOW) {
  const h = localHour(atMs, win.tz);
  const dow = localWeekday(atMs, win.tz);
  if (dow === 0 || dow === 6) {
    return {
      band: 'dead', name: 'Weekend',
      note: pair === 'BTCUSD'
        ? 'Bitcoin trades on, but many broker CFD feeds close or widen sharply at the weekend, and liquidity is thin.'
        : 'Gold is closed. Nothing here is live.',
      localHour: h, outsideWindow: true,
    };
  }

  const table = BANDS[pair] || BANDS.XAUUSD;
  const hit = table.find((b) => h >= b.from && h < b.to);
  if (!hit) {
    return {
      band: 'red', name: 'Outside your hours',
      note: `Outside ${win.start.h}:00-${win.end.h}:00 ${win.label || win.tz}. The tool still reads the chart, but this is not a window you have said you trade.`,
      localHour: h, outsideWindow: true,
    };
  }
  return { ...hit, localHour: h, outsideWindow: false };
}

/**
 * The gold rollover window. Most brokers run a GMT+2/+3 server clock, so the
 * day rolls at 21:00 or 22:00 UTC — comfortably outside a London session, which
 * is one of the quiet advantages of trading these hours. Kept because the tool
 * should still say so if the window is ever moved.
 */
export function rolloverWindow(atMs, serverUtcOffsetHours) {
  if (serverUtcOffsetHours === null || serverUtcOffsetHours === undefined) return null;
  const d = new Date(atMs);
  const rolloverUtcHour = (24 - serverUtcOffsetHours) % 24;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const inside = h >= rolloverUtcHour - 0.5 && h <= rolloverUtcHour + 0.75;
  return {
    utcHour: rolloverUtcHour,
    inside,
    text: `Broker day rolls at ${String(rolloverUtcHour).padStart(2, '0')}:00 UTC`,
    warning: inside
      ? 'Inside the rollover window. Spreads widen sharply, fills get poor and swap is charged.'
      : null,
  };
}

/**
 * Algorithmic order flow clusters on round clock boundaries, strongest at :00,
 * :15, :30 and :45. A five-minute bar closing exactly on one is systematically
 * contaminated, so a signal from that candle alone deserves more scepticism.
 */
export function barBoundaryNote(atMs) {
  const m = new Date(atMs).getUTCMinutes();
  const strong = [0, 15, 30, 45].includes(m);
  return strong
    ? { strong: true, note: 'This bar closes on a :00/:15/:30/:45 boundary, where scheduled algorithmic flow clusters. Treat a signal from this candle alone with more scepticism than usual.' }
    : { strong: false, note: null };
}

/**
 * A plain-language plan for the rest of the window: which bands are still to
 * come today, so the first thing the user sees at 08:00 is what their day
 * actually looks like rather than a snapshot of one bar.
 */
export function remainingBands(atMs, pair, win = DEFAULT_WINDOW) {
  const table = BANDS[pair] || BANDS.XAUUSD;
  const h = localHour(atMs, win.tz);
  const { y, m, d } = localDate(atMs, win.tz);
  return table
    .filter((b) => b.to > h)
    .map((b) => ({
      ...b,
      startsAtMs: zonedTimeToUtc(y, m, d, Math.floor(b.from), Math.round((b.from % 1) * 60), win.tz),
      endsAtMs: zonedTimeToUtc(y, m, d, Math.floor(b.to), Math.round((b.to % 1) * 60), win.tz),
      current: h >= b.from && h < b.to,
    }));
}

export { BANDS };
