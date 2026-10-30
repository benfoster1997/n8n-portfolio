// Which start times can a client pick on a given day?
//
// This mirrors public.check_bookable_time() and the no-overlap rule in the
// database exactly, so the page only offers times the database will accept.
// The database still has the final say (two people can race for one slot).
import type { BusyRange, OpeningHours } from './types';
import { addDays, fromMinutes, isoWeekday, toMinutes, todayInZone, zonedToInstant } from './time';

export interface SlotRules {
  timezone: string;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_hours: number;
  max_days_ahead: number;
  hours: OpeningHours[];
}

export interface SlotOptions {
  /** Owner bookings ignore the notice period and the booking horizon. */
  ignoreNotice?: boolean;
}

export function availableSlots(
  dateStr: string,
  durationMin: number,
  rules: SlotRules,
  busy: BusyRange[],
  now: Date = new Date(),
  opts: SlotOptions = {},
): Date[] {
  const h = rules.hours.find((x) => x.weekday === isoWeekday(dateStr));
  if (!h || !h.is_open) return [];

  const open = toMinutes(h.open_time);
  const close = toMinutes(h.close_time);
  const brk = h.break_start && h.break_end ? [toMinutes(h.break_start), toMinutes(h.break_end)] : null;
  const earliest = now.getTime() + rules.min_notice_hours * 3600e3;
  const latest = now.getTime() + rules.max_days_ahead * 86400e3;
  const busyMs = busy.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);

  const out: Date[] = [];
  for (let m = open; m + durationMin <= close; m += rules.slot_interval_min) {
    if (brk && m < brk[1] && m + durationMin > brk[0]) continue;
    const start = zonedToInstant(dateStr, fromMinutes(m), rules.timezone);
    const s = start.getTime();
    // A wall-clock time that doesn't exist (the hour skipped when clocks go
    // forward) comes back shifted; skip it rather than offer a wrong time.
    if (zonedMinutes(start, rules.timezone) !== m) continue;
    if (!opts.ignoreNotice && (s < earliest || s > latest)) continue;
    const busyEnd = s + (durationMin + rules.buffer_min) * 60e3;
    if (busyMs.some(([bs, be]) => s < be && busyEnd > bs)) continue;
    out.push(start);
  }
  return out;
}

/** Days (YYYY-MM-DD) from today up to the booking horizon on which the shop is open. */
export function openDays(rules: SlotRules, now: Date = new Date()): string[] {
  const today = todayInZone(rules.timezone, now);
  const days: string[] = [];
  for (let i = 0; i <= rules.max_days_ahead; i++) {
    const d = addDays(today, i);
    const h = rules.hours.find((x) => x.weekday === isoWeekday(d));
    if (h?.is_open) days.push(d);
  }
  return days;
}

function zonedMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value);
  return hh * 60 + mm;
}
