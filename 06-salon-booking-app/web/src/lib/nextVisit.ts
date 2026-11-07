// Booking the client's next visit while they're still in the chair. After "Mark as done" the
// checkout sheet offers the same treatment in 2, 3 or 4 weeks: on the same weekday at the same
// time when that's free, otherwise at the nearest free time. The times come from the slot
// engine New appointment uses (her opening hours and breaks, the start-time interval, the
// clean-up gap, other bookings and time off), so nothing offered clashes. Like New appointment,
// it ignores the notice and how-far-ahead rules: those are for clients booking online.
import type { Appointment, BusyRange, Service } from './types';
import { availableSlots, type SlotRules } from './slots';
import { addDays, dateInZone, fmtTime, startOfDayInstant, toMinutes, zonedToInstant } from './time';
import { firstName, money } from './text';

/** The choices after "Mark as done": the same treatment this many weeks on. */
export const NEXT_VISIT_WEEKS = [2, 3, 4] as const;

/** How many days either side of the same weekday to look for the nearest free time. Each choice keeps to its own week. */
export const NEAR_DAYS = 3;

export interface NextVisitOption {
  weeks: number;
  /** The start it would book, or null when nothing is free within 3 days either side. */
  at: Date | null;
  /** On the same weekday at the same time as this visit; false when it's the nearest free time instead. */
  same: boolean;
}

/** The calendar days ("YYYY-MM-DD", first and last) whose busy times the choices need. */
export function nextVisitDays(visitStart: string, tz: string, weeks: readonly number[] = NEXT_VISIT_WEEKS): { first: string; last: string } {
  const day = dateInZone(visitStart, tz);
  return { first: addDays(day, 7 * Math.min(...weeks) - NEAR_DAYS), last: addDays(day, 7 * Math.max(...weeks) + NEAR_DAYS) };
}

/**
 * When to book the next visit, for each choice of weeks: the same weekday and time if that's
 * free. Otherwise the nearest free time: on the same day if it has one, at the time closest to
 * the usual one; if not, on the nearest day within 3 days either side, again at the closest time.
 * When two are as near, the later one. Only times still to come; a choice whose days have all
 * gone (a visit finished weeks late) is left out.
 */
export function nextVisitOptions(
  visitStart: string, durationMin: number, rules: SlotRules, busy: BusyRange[], now = new Date(),
  weeks: readonly number[] = NEXT_VISIT_WEEKS,
): NextVisitOption[] {
  const tz = rules.timezone;
  const day = dateInZone(visitStart, tz);
  const time = fmtTime(visitStart, tz);
  const out: NextVisitOption[] = [];
  for (const w of weeks) {
    const target = addDays(day, 7 * w);
    if (startOfDayInstant(addDays(target, NEAR_DAYS + 1), tz).getTime() <= now.getTime()) continue;
    let best: Date | null = null;
    let bestCost = Infinity;
    for (let d = -NEAR_DAYS; d <= NEAR_DAYS; d++) {
      for (const slot of availableSlots(addDays(target, d), durationMin, rules, busy, now, { ignoreNotice: true })) {
        if (slot.getTime() <= now.getTime()) continue;
        // A day further away always counts for more than any difference in the time of day.
        const cost = Math.abs(d) * 1440 + Math.abs(toMinutes(fmtTime(slot, tz)) - toMinutes(time));
        if (cost < bestCost || (cost === bestCost && slot.getTime() > best!.getTime())) { best = slot; bestCost = cost; }
      }
    }
    out.push({ weeks: w, at: best, same: !!best && best.getTime() === zonedToInstant(target, time, tz).getTime() });
  }
  return out;
}

/** "Done: £35 recorded.", with the tip when there was one. */
export function doneLine(amountPence: number, tipPence: number): string {
  if (amountPence > 0 && tipPence > 0) return `Done: ${money(amountPence)} and a ${money(tipPence)} tip recorded.`;
  if (amountPence > 0) return `Done: ${money(amountPence)} recorded.`;
  if (tipPence > 0) return `Done: a ${money(tipPence)} tip recorded.`;
  return 'Done: no payment recorded today.';
}

/** "Book Jess’s next BIAB infill?" */
export function nextVisitQuestion(fullName: string | null | undefined, treatment: string): string {
  const first = firstName(fullName);
  return `Book ${first ? `${first}’s` : 'their'} next ${treatment}?`;
}

/** A treatment as New appointment fills it in: one from her list, or "Something else…" with its own name, length and price. */
export interface Treatment {
  /** Null for "Something else…". */
  serviceId: string | null;
  name: string;
  minutes: number;
  pricePence: number;
}

/**
 * The same treatment as this booking: from her list while she still offers it (at its length and
 * price now), otherwise as "Something else…" with this booking's own name, length and price.
 */
export function sameTreatment(
  a: Pick<Appointment, 'service_id' | 'service_name' | 'duration_min' | 'price_pence'>,
  services: Pick<Service, 'id' | 'name' | 'duration_min' | 'price_pence' | 'is_active'>[],
): Treatment {
  const s = a.service_id ? services.find((x) => x.id === a.service_id && x.is_active) : undefined;
  return s
    ? { serviceId: s.id, name: s.name, minutes: s.duration_min, pricePence: s.price_pence }
    : { serviceId: null, name: a.service_name, minutes: a.duration_min, pricePence: a.price_pence };
}

/** A client's latest booking that wasn't cancelled: usually their last visit, or one already coming up. */
export function latestBooking<T extends Pick<Appointment, 'status' | 'starts_at'>>(appts: T[]): T | null {
  return appts.filter((a) => a.status !== 'cancelled').reduce<T | null>((x, a) => (!x || a.starts_at > x.starts_at ? a : x), null);
}

/** 1500 → "15", 1550 → "15.50": how she'd type it. */
const poundsText = (pence: number) => (pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2));

/**
 * New appointment, filled in: the client, the treatment and, when given, the day and time.
 * "/appointments/new?client=…&service=…&d=2026-12-01&t=14:00"; a treatment that isn't on her
 * list goes as service=custom with its name, minutes and price.
 */
export function newAppointmentLink(clientId: string, t?: Treatment | null, when?: { day: string; time: string } | null): string {
  const p = new URLSearchParams({ client: clientId });
  if (t?.serviceId) p.set('service', t.serviceId);
  else if (t) {
    p.set('service', 'custom');
    p.set('name', t.name);
    p.set('mins', String(t.minutes));
    p.set('price', poundsText(t.pricePence));
  }
  if (when) {
    p.set('d', when.day);
    p.set('t', when.time);
  }
  return `/appointments/new?${p}`;
}

/** What New appointment starts with, read from its link. Anything missing or malformed is left out. */
export interface NewAppointmentStart {
  clientId: string | null;
  /** A service id, "custom", or null for her first treatment. */
  serviceId: string | null;
  /** "Something else…" as the link gave it (the form's own text: minutes and pounds). */
  custom: { name: string; duration: string; price: string } | null;
  day: string | null;
  time: string | null;
}

export function readNewAppointmentLink(params: URLSearchParams): NewAppointmentStart {
  const day = params.get('d');
  const time = params.get('t');
  const service = params.get('service');
  const mins = Number(params.get('mins'));
  const price = params.get('price') ?? '';
  const custom = service === 'custom' ? {
    name: (params.get('name') ?? '').trim().slice(0, 80),
    duration: Number.isInteger(mins) && mins >= 5 && mins <= 600 ? String(mins) : '60',
    price: /^\d+(\.\d{1,2})?$/.test(price) ? price : '',
  } : null;
  return {
    clientId: params.get('client') || null,
    serviceId: service || null,
    custom,
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day ? day : null,
    time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
  };
}
