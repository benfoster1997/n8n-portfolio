// "Share free times": a short message listing times a client could book online for one
// treatment, for her to post on a Story or Status, or send to someone who asked. It follows the
// booking page's own rules (lib/slots: minimum notice, how far ahead, the start-time interval,
// opening hours and breaks, other bookings with their clean-up gap, and time off), so every time
// listed can really be booked from the link. Text only: she shares it herself.
import type { Appointment, BusyRange, Service } from './types';
import { availableSlots, openDays, type SlotRules } from './slots';
import { addDays, fmt, fmtDay, todayInZone } from './time';

/** At most this many times in one message. */
export const SHARE_MAX = 8;

export type ShareSpan = 'week' | 'fortnight';
/** "This week" is today and the 6 days after it; "Next 2 weeks" is 14 days. */
export const SPAN_DAYS: Record<ShareSpan, number> = { week: 7, fortnight: 14 };

/** How far back her bookings count towards "most-booked first" (with everything booked ahead). */
export const BOOKED_LOOKBACK_DAYS = 60;

/** The open days a span covers ("YYYY-MM-DD"), from today, up to the booking page's horizon. */
export function spanDays(rules: SlotRules, span: ShareSpan, now = new Date()): string[] {
  const end = addDays(todayInZone(rules.timezone, now), SPAN_DAYS[span]);
  return openDays(rules, now).filter((d) => d < end);
}

/** The first and last calendar days a span covers, within the booking page's horizon. */
export function spanRange(rules: SlotRules, span: ShareSpan, now = new Date()): { first: string; last: string } {
  const today = todayInZone(rules.timezone, now);
  return { first: today, last: addDays(today, Math.min(SPAN_DAYS[span] - 1, rules.max_days_ahead)) };
}

/**
 * Free start times that could all be booked together: each one starts once the one before has
 * finished and been cleaned up after. So no two times listed are really the same space.
 */
export function separateTimes(starts: Date[], durationMin: number, bufferMin: number): Date[] {
  const out: Date[] = [];
  const step = (durationMin + bufferMin) * 60e3;
  for (const s of starts) if (!out.length || s.getTime() >= out[out.length - 1].getTime() + step) out.push(s);
  return out;
}

/** A day's times in the order they're picked: the earliest, the latest, then each time farthest from those already picked. */
export function spreadOrder(times: Date[]): Date[] {
  if (times.length <= 2) return [...times];
  const picked = [times[0], times[times.length - 1]];
  const left = times.slice(1, -1);
  while (left.length) {
    let at = 0;
    let far = -1;
    left.forEach((t, i) => {
      const near = Math.min(...picked.map((p) => Math.abs(p.getTime() - t.getTime())));
      if (near > far) { far = near; at = i; } // the earlier of two as far
    });
    picked.push(left.splice(at, 1)[0]);
  }
  return picked;
}

/** n items spread evenly from first to last. */
function evenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  if (n <= 1) return items.slice(0, n);
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

/**
 * Up to `max` times a client could book online for a treatment this long, spread over the days:
 * a time on each day first (on as many days as fit, spread out), then a second on each, and so
 * on, keeping a day's times apart. Where a day gets one time, it's alternately the day's
 * earliest and latest, so the list has mornings and later times. In time order.
 */
export function shareableTimes(rules: SlotRules, durationMin: number, days: string[], busy: BusyRange[], now = new Date(), max = SHARE_MAX): Date[] {
  const perDay = days
    .map((d) => spreadOrder(separateTimes(availableSlots(d, durationMin, rules, busy, now), durationMin, rules.buffer_min)))
    .filter((t) => t.length > 0);
  const chosen = evenly(perDay, max).map((t, i) => (i % 2 && t.length > 1 ? [t[1], t[0], ...t.slice(2)] : t));
  const out: Date[] = [];
  for (let round = 0; out.length < max && chosen.some((t) => t.length > round); round++) {
    for (const t of chosen) if (round < t.length && out.length < max) out.push(t[round]);
  }
  return out.sort((x, y) => x.getTime() - y.getTime());
}

/** "2pm", "10:30am", "12pm": how clients write times. */
export function clock12(d: Date | string, tz: string): string {
  const h = Number(fmt(d, 'H', tz));
  const m = fmt(d, 'mm', tz);
  return `${h % 12 || 12}${m === '00' ? '' : `:${m}`}${h < 12 ? 'am' : 'pm'}`;
}

/** "Spaces for BIAB infill: Tue 10 Nov 2pm · Thu 12 Nov 10:30am, 3pm · Sat 14 Nov 9am. Book here: <link>" */
export function shareMessage(treatment: string, times: Date[], tz: string, link: string): string {
  const days = new Map<string, string[]>();
  for (const t of [...times].sort((x, y) => x.getTime() - y.getTime())) {
    const day = fmtDay(t, tz);
    days.set(day, [...(days.get(day) ?? []), clock12(t, tz)]);
  }
  const list = [...days].map(([day, ts]) => `${day} ${ts.join(', ')}`).join(' · ');
  return `Spaces for ${treatment}: ${list}. Book here: ${link}`;
}

/** "Gel polish — hands" → "gel-polish-hands": a treatment's name as it reads in a link. */
export function treatmentSlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

type Named = Pick<Service, 'id' | 'name'>;

/** What the booking link carries for a treatment: its name, or its id when the name won't do (two alike, or no letters). */
export function treatmentParam(s: Named, services: Named[]): string {
  const slug = treatmentSlug(s.name);
  const alike = services.filter((x) => treatmentSlug(x.name) === slug).length;
  return slug && alike === 1 ? slug : s.id;
}

/**
 * Her booking link, opening straight on this treatment's free times: ".../book?treatment=biab-infill".
 * With `from`, it also says where it was shared (".../book?treatment=biab-infill&from=free-times"), so
 * Money can tell which links bring new clients (LINK_FROM in lib/source).
 */
export function treatmentLink(bookingUrl: string, s: Named, services: Named[], from?: string): string {
  const link = `${bookingUrl}?treatment=${encodeURIComponent(treatmentParam(s, services))}`;
  return from ? `${link}&from=${encodeURIComponent(from)}` : link;
}

/** The treatment a booking link names (by id or by name), if clients can book it online; otherwise null. */
export function findTreatment<S extends Named>(param: string | null | undefined, services: S[]): S | null {
  const p = (param ?? '').trim();
  if (!p) return null;
  return services.find((x) => x.id === p) ?? services.find((x) => treatmentSlug(x.name) === p.toLowerCase()) ?? null;
}

/** Her treatments, most-booked first (bookings that weren't cancelled); her own order where it's a tie. */
export function mostBookedFirst<S extends Pick<Service, 'id'>>(services: S[], appts: Pick<Appointment, 'service_id' | 'status'>[]): S[] {
  const count = new Map<string, number>();
  for (const a of appts) if (a.service_id && a.status !== 'cancelled') count.set(a.service_id, (count.get(a.service_id) ?? 0) + 1);
  return services.map((s, i) => ({ s, i, n: count.get(s.id) ?? 0 })).sort((x, y) => y.n - x.n || x.i - y.i).map((x) => x.s);
}
