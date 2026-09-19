/**
 * sessions.js — when it is worth scalping, and when it is a chop trap.
 *
 * Presenting all 24 hours as equally tradeable is the most common failure of a
 * trading dashboard. They are not remotely equal, and for a five-minute
 * scalper the hour of the day is a bigger determinant of outcome than most of
 * the indicators in this tool.
 *
 * Session boundaries are a market CONVENTION, not an exchange rule — nothing
 * rings a bell at the London open. They are computed from real local times in
 * real IANA zones so they follow DST rather than drifting an hour twice a year.
 */

import { zonedTimeToUtc } from './timezone.js';

export const SESSIONS = [
  { id: 'sydney', label: 'Sydney', tz: 'Australia/Sydney', open: 8, close: 17 },
  { id: 'tokyo', label: 'Tokyo', tz: 'Asia/Tokyo', open: 9, close: 18 },
  { id: 'london', label: 'London', tz: 'Europe/London', open: 8, close: 16, key: true },
  { id: 'newyork', label: 'New York', tz: 'America/New_York', open: 8, close: 17, key: true },
];

/** Which sessions are open at a given instant, DST handled. */
export function openSessions(atMs) {
  const d = new Date(atMs);
  const out = [];
  for (const s of SESSIONS) {
    // Check today and yesterday, since a session can span the UTC date line.
    for (const offset of [-1, 0]) {
      const probe = new Date(atMs + offset * 86400e3);
      const y = probe.getUTCFullYear(), m = probe.getUTCMonth() + 1, day = probe.getUTCDate();
      const openTs = zonedTimeToUtc(y, m, day, s.open, 0, s.tz);
      const closeTs = zonedTimeToUtc(y, m, day, s.close, 0, s.tz);
      if (atMs >= openTs && atMs < closeTs) {
        out.push({ ...s, openTs, closeTs, closesInMin: Math.round((closeTs - atMs) / 60000) });
        break;
      }
    }
  }
  void d;
  return out;
}

/**
 * Quality band for the current hour.
 *
 * The two instruments genuinely differ, so they get separate maps:
 *  - Gold's worst hour is the broker rollover, when the spread blows out and
 *    swap is charged. Its best is the London/New York overlap.
 *  - Bitcoin's variance is heavily concentrated in US hours; roughly half its
 *    daily realised variance falls in the 13:00-22:00 UTC window, and it is
 *    quietest around 02:00-06:00.
 *
 * Bands are by UTC hour. They shift by an hour across DST, which is why the
 * rollover window is given as a range rather than a fixed hour.
 */
const BANDS = {
  XAUUSD: {
    green: [[12, 17]],
    amber: [[7, 12], [17, 20]],
    red: [[0, 7], [20, 24]],
    notes: {
      green: 'London/New York overlap — the deepest liquidity of the day and where the M5 range is worth trading.',
      amber: 'Tradeable but thinner. London morning before US data, or the post-New-York drift.',
      red: 'Asian session chop, or the broker rollover window where the spread widens sharply and swap is charged. Costs dominate.',
    },
  },
  BTCUSD: {
    green: [[13, 18]],
    amber: [[12, 13], [18, 22]],
    red: [[0, 2], [2, 6], [6, 12], [22, 24]],
    notes: {
      green: 'US equity hours. Roughly half of bitcoin\'s daily realised variance falls in this window.',
      amber: 'Moving, but less reliably. The European morning and the US afternoon.',
      red: 'Asian and pre-European hours are bitcoin\'s quietest. The CFD spread does not shrink to match, so it is a larger share of a smaller range.',
    },
  },
};

export function sessionQuality(atMs, pair) {
  const h = new Date(atMs).getUTCHours() + new Date(atMs).getUTCMinutes() / 60;
  const map = BANDS[pair] || BANDS.XAUUSD;
  for (const band of ['green', 'amber', 'red']) {
    for (const [from, to] of map[band]) {
      if (h >= from && h < to) return { band, note: map.notes[band], utcHour: h };
    }
  }
  return { band: 'amber', note: map.notes.amber, utcHour: h };
}

/**
 * The gold rollover window, computed rather than hardcoded.
 *
 * Most brokers run a GMT+2/+3 server clock, so 00:00 server time — where the
 * day rolls, swap is charged and the spread blows out — is 21:00 or 22:00 UTC
 * depending on the season. Returns null for instruments it does not apply to.
 */
export function rolloverWindow(atMs, serverUtcOffsetHours) {
  if (serverUtcOffsetHours === null || serverUtcOffsetHours === undefined) return null;
  const d = new Date(atMs);
  const rolloverUtcHour = (24 - serverUtcOffsetHours) % 24;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const start = rolloverUtcHour - 0.5;
  const end = rolloverUtcHour + 0.75;
  const inside = h >= start && h <= end;
  return {
    utcHour: rolloverUtcHour,
    inside,
    text: `Broker day rolls at ${String(rolloverUtcHour).padStart(2, '0')}:00 UTC`,
    warning: inside
      ? 'Inside the rollover window. Spreads widen sharply, fills get poor and swap is charged. This is the worst hour of the day to hold a scalp.'
      : null,
  };
}

/**
 * Algorithmic order bursts cluster on round clock boundaries, strongest at
 * :00, :15, :30 and :45. A five-minute bar closing exactly on one of those is
 * systematically contaminated, so an entry triggered purely by that bar's
 * close is worth a second look.
 */
export function barBoundaryNote(atMs) {
  const m = new Date(atMs).getUTCMinutes();
  const strong = [0, 15, 30, 45].includes(m);
  return strong
    ? { strong: true, note: 'This bar closes on a :00/:15/:30/:45 boundary, where scheduled algorithmic flow clusters. Treat a signal from this candle alone with more scepticism than usual.' }
    : { strong: false, note: null };
}
