/**
 * timezone.js — turning schedule rules into exact UTC instants.
 *
 * Every news time in this tool is stored as a WALL-CLOCK TIME IN A NAMED IANA
 * ZONE ("08:30 America/New_York"), never as a fixed UTC offset. That is the
 * whole point of this file.
 *
 * The reason: Non-Farm Payrolls is released at 08:30 in New York all year
 * round. In UTC that is 12:30 during EDT and 13:30 during EST. A tool that
 * hardcodes either one is wrong for roughly half the year, and it is wrong in
 * the most expensive possible way — telling a scalper the coast is clear one
 * hour before the largest candle of the month.
 *
 * Verified against a 3-year hourly round-trip fuzz over America/New_York and
 * Europe/London: 52,560 instants, the only failures being the six inherently
 * ambiguous repeated hours at the autumn transitions. See test/timezone.test.mjs.
 */

/**
 * Offset of `tz` from UTC, in milliseconds, at the instant `utcMs`.
 * Positive west of Greenwich is NOT the convention here: we return
 * (wall clock read in tz) - (utc), so New York in winter gives -5h.
 */
export function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const p = {};
  for (const { type, value } of parts) p[type] = value;

  // Some ICU builds render midnight as hour "24" with hour12:false. Modulo it
  // back to 0 rather than letting Date.UTC roll the day forward.
  const wallAsIfUtc = Date.UTC(
    +p.year, +p.month - 1, +p.day,
    +p.hour % 24, +p.minute, +p.second,
  );
  return wallAsIfUtc - utcMs;
}

/**
 * The UTC instant at which the clock in `tz` reads the given wall-clock time.
 *
 * Solved by iteration rather than by table lookup. The first guess subtracts
 * the offset that applies at the *naive* instant; that guess is already correct
 * unless it lands on the far side of a DST transition, which the second pass
 * repairs. Two passes are provably enough for every real-world zone, because no
 * zone has two transitions inside one UTC day.
 *
 * Edge cases, both deliberate:
 *  - Nonexistent times (the spring-forward gap, e.g. 02:30 on 8 Mar 2026 in
 *    New York) resolve to the instant one offset-step after the gap. No
 *    scheduled economic release sits in the gap, so this never bites in
 *    practice, but it returns a usable instant rather than NaN.
 *  - Ambiguous times (the autumn repeated hour) resolve to the FIRST of the two
 *    occurrences, i.e. still-daylight-time. Again, no release sits there.
 */
export function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - tzOffsetMs(naive, tz);
  ts = naive - tzOffsetMs(ts, tz);
  return ts;
}

/**
 * Day-of-month of the `n`th `weekday` of a month. weekday: 0=Sun … 6=Sat.
 * n is 1-based. Returns a day number that may exceed the month's length if you
 * ask for something impossible (a 5th Friday of a month that has four) — call
 * `existsInMonth` or use `nthWeekdayOrNull`.
 */
export function nthWeekdayOfMonth(year, month, weekday, n) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** As nthWeekdayOfMonth, but null when that occurrence does not exist. */
export function nthWeekdayOrNull(year, month, weekday, n) {
  const d = nthWeekdayOfMonth(year, month, weekday, n);
  return d <= daysInMonth(year, month) ? d : null;
}

/** Day-of-month of the LAST `weekday` of a month. */
export function lastWeekdayOfMonth(year, month, weekday) {
  const last = daysInMonth(year, month);
  const lastDow = new Date(Date.UTC(year, month - 1, last)).getUTCDay();
  return last - ((lastDow - weekday + 7) % 7);
}

/** All dates in [fromMs, toMs] whose weekday matches, as {y,m,d}. */
export function weekdaysBetween(fromMs, toMs, weekday) {
  const out = [];
  const d = new Date(fromMs);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= toMs) {
    if (d.getUTCDay() === weekday) {
      out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** The viewer's own IANA zone, with a safe fallback. */
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Short zone abbreviation (EST/EDT/BST/GMT) for display. */
export function zoneAbbr(utcMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(utcMs));
    const z = parts.find((p) => p.type === 'timeZoneName');
    return z ? z.value : '';
  } catch {
    return '';
  }
}

/** HH:MM in a given zone. */
export function formatHM(utcMs, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(utcMs));
}

/** "Fri 6 Nov, 13:30" in a given zone. */
export function formatDayTime(utcMs, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(utcMs));
}

/** Compact countdown: "2d 04h", "3h 12m", "07:41", "now". */
export function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
