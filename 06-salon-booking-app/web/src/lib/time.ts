// All diary times are shown in the business's own time zone (Europe/London by
// default), whatever time zone the phone happens to be in, and BST/GMT changes
// are handled by date-fns-tz.
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { enGB } from 'date-fns/locale';

export const DEFAULT_TZ = 'Europe/London';

/** "2026-10-27" + "10:30" in the shop's time zone → the real instant. */
export function zonedToInstant(dateStr: string, hhmm: string, tz = DEFAULT_TZ): Date {
  return fromZonedTime(`${dateStr}T${hhmm}:00`, tz);
}

export function fmt(date: Date | string, pattern: string, tz = DEFAULT_TZ): string {
  return formatInTimeZone(typeof date === 'string' ? new Date(date) : date, tz, pattern, { locale: enGB });
}

/** e.g. "Tue 27 Oct" */
export const fmtDay = (d: Date | string, tz?: string) => fmt(d, 'EEE d MMM', tz);
/** e.g. "Tuesday 27 October" */
export const fmtDayLong = (d: Date | string, tz?: string) => fmt(d, 'EEEE d MMMM', tz);
/** e.g. "10:30" */
export const fmtTime = (d: Date | string, tz?: string) => fmt(d, 'HH:mm', tz);
/** e.g. "Tue 27 Oct, 10:30" */
export const fmtDayTime = (d: Date | string, tz?: string) => fmt(d, 'EEE d MMM, HH:mm', tz);

/** The calendar date ("YYYY-MM-DD") an instant falls on in the shop's time zone. */
export function dateInZone(d: Date | string, tz = DEFAULT_TZ): string {
  return fmt(d, 'yyyy-MM-dd', tz);
}

export function todayInZone(tz = DEFAULT_TZ, now = new Date()): string {
  return dateInZone(now, tz);
}

/** Add whole days to a "YYYY-MM-DD" date string (calendar arithmetic, no time zones involved). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO weekday of a "YYYY-MM-DD" date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Monday of the week containing dateStr. */
export function startOfWeek(dateStr: string): string {
  return addDays(dateStr, 1 - isoWeekday(dateStr));
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The instant at the very start of a calendar day in the shop's zone. */
export function startOfDayInstant(dateStr: string, tz = DEFAULT_TZ): Date {
  return zonedToInstant(dateStr, '00:00', tz);
}

export function minutesLabel(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
