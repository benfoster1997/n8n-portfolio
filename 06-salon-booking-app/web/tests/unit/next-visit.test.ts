import { describe, expect, it } from 'vitest';
import {
  doneLine, latestBooking, newAppointmentLink, nextVisitDays, nextVisitOptions, nextVisitQuestion, readNewAppointmentLink, sameTreatment,
} from '../../src/lib/nextVisit';
import type { SlotRules } from '../../src/lib/slots';
import { fmtDayTime, zonedToInstant } from '../../src/lib/time';
import type { BusyRange, OpeningHours } from '../../src/lib/types';

// Opening hours like the demo's: 09:30–17:30 on weekdays (19:00 on Thursdays), 09:00–15:00 on
// Saturdays, closed on Sundays.
const hours = (over: (h: OpeningHours) => Partial<OpeningHours> = () => ({})): OpeningHours[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const h: OpeningHours = {
      weekday, is_open: weekday !== 7, open_time: weekday === 6 ? '09:00' : '09:30',
      close_time: weekday === 6 ? '15:00' : weekday === 4 ? '19:00' : '17:30', break_start: null, break_end: null,
    };
    return { ...h, ...over(h) };
  });
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  timezone: 'Europe/London', slot_interval_min: 15, buffer_min: 10, min_notice_hours: 12, max_days_ahead: 60, hours: hours(), ...over,
});
const at = (day: string, hhmm: string) => zonedToInstant(day, hhmm).toISOString();
/** An appointment from–to, busy until the clean-up gap after it. */
const booked = (day: string, from: string, to: string): BusyRange => ({ starts_at: at(day, from), ends_at: new Date(new Date(at(day, to)).getTime() + 10 * 60e3).toISOString() });
const shown = (opts: ReturnType<typeof nextVisitOptions>) =>
  opts.map((o) => `${o.weeks}: ${o.at ? `${fmtDayTime(o.at)}${o.same ? '' : ' (nearest)'}` : 'none'}`);

// A BIAB infill (60 minutes) on Tuesday 3 November 2026 at 14:00, finished that afternoon.
const VISIT = at('2026-11-03', '14:00');
const NOW = new Date(at('2026-11-03', '15:10'));

describe('the next visit after "Mark as done"', () => {
  it('offers the same weekday and time in 2, 3 and 4 weeks when they are free', () => {
    expect(shown(nextVisitOptions(VISIT, 60, rules(), [], NOW))).toEqual([
      '2: Tue 17 Nov, 14:00', '3: Tue 24 Nov, 14:00', '4: Tue 1 Dec, 14:00',
    ]);
  });

  it('otherwise the nearest free time that day, keeping the clean-up gap either side', () => {
    // 24 Nov: someone else 13:30–14:30, so busy until 14:40. 12:15 would run into 13:30 with its gap;
    // 12:15 is 105 minutes early and 14:45 is 45 minutes late.
    const busy = [booked('2026-11-24', '13:30', '14:30')];
    expect(shown(nextVisitOptions(VISIT, 60, rules(), busy, NOW))[1]).toBe('3: Tue 24 Nov, 14:45 (nearest)');
  });

  it('takes the later of two times as near', () => {
    // Free at 13:00 and 15:00 only, each an hour away from 14:00.
    const busy = [{ starts_at: at('2026-11-17', '14:15'), ends_at: at('2026-11-17', '14:55') }];
    expect(shown(nextVisitOptions(VISIT, 60, rules(), busy, NOW))[0]).toBe('2: Tue 17 Nov, 15:00 (nearest)');
  });

  it('never offers time off: with the day blocked, the same time on the nearest day (the later of two)', () => {
    const off = [{ starts_at: at('2026-11-17', '00:00'), ends_at: at('2026-11-18', '00:00') }];
    expect(shown(nextVisitOptions(VISIT, 60, rules(), off, NOW))[0]).toBe('2: Wed 18 Nov, 14:00 (nearest)');
    // Off from 15:00: 14:00 would end at 15:00, but its clean-up gap would run into the time off. 13:45 leaves room.
    const afternoon = [{ starts_at: at('2026-11-17', '15:00'), ends_at: at('2026-11-17', '18:00') }];
    expect(shown(nextVisitOptions(VISIT, 60, rules(), afternoon, NOW))[0]).toBe('2: Tue 17 Nov, 13:45 (nearest)');
  });

  it('never offers a time outside opening hours or in a break', () => {
    // Closed on Tuesdays: Monday and Wednesday at 14:00 are as near, so Wednesday.
    const closedTue = rules({ hours: hours((h) => (h.weekday === 2 ? { is_open: false } : {})) });
    expect(shown(nextVisitOptions(VISIT, 60, closedTue, [], NOW))).toEqual([
      '2: Wed 18 Nov, 14:00 (nearest)', '3: Wed 25 Nov, 14:00 (nearest)', '4: Wed 2 Dec, 14:00 (nearest)',
    ]);
    // Tuesdays close at 14:30 now: 14:00 would run past it, so 13:30.
    const early = rules({ hours: hours((h) => (h.weekday === 2 ? { close_time: '14:30' } : {})) });
    expect(shown(nextVisitOptions(VISIT, 60, early, [], NOW))[0]).toBe('2: Tue 17 Nov, 13:30 (nearest)');
    // A lunch break 13:30–14:30: 12:30 (90 minutes early) or 14:30 (30 late).
    const lunch = rules({ hours: hours(() => ({ break_start: '13:30', break_end: '14:30' })) });
    expect(shown(nextVisitOptions(VISIT, 60, lunch, [], NOW))[0]).toBe('2: Tue 17 Nov, 14:30 (nearest)');
    // A visit she put in before opening (07:00): never 07:00 again, but opening time.
    expect(shown(nextVisitOptions(at('2026-11-03', '07:00'), 60, rules(), [], NOW))[0]).toBe('2: Tue 17 Nov, 09:30 (nearest)');
  });

  it('keeps to the start-time interval', () => {
    // Starts every 30 minutes from 09:30: a visit she put in at 14:05 comes back at 14:00.
    const visit = at('2026-11-03', '14:05');
    expect(shown(nextVisitOptions(visit, 60, rules({ slot_interval_min: 30 }), [], NOW))[0]).toBe('2: Tue 17 Nov, 14:00 (nearest)');
  });

  it('looks no more than 3 days either side, so each choice keeps to its own week', () => {
    // 14 Nov to 20 Nov all taken: nothing for "In 2 weeks", the others as usual.
    const off = [{ starts_at: at('2026-11-14', '00:00'), ends_at: at('2026-11-21', '00:00') }];
    expect(shown(nextVisitOptions(VISIT, 60, rules(), off, NOW))).toEqual([
      '2: none', '3: Tue 24 Nov, 14:00', '4: Tue 1 Dec, 14:00',
    ]);
  });

  it('ignores the notice and how-far-ahead rules, which are for clients booking online', () => {
    expect(shown(nextVisitOptions(VISIT, 60, rules({ min_notice_hours: 24 * 30, max_days_ahead: 7 }), [], NOW))).toEqual([
      '2: Tue 17 Nov, 14:00', '3: Tue 24 Nov, 14:00', '4: Tue 1 Dec, 14:00',
    ]);
  });

  it('keeps the same wall-clock time when the clocks change', () => {
    // Tuesday 20 October 2026 at 14:00 is 13:00 UTC (summer time); three weeks later, 14:00 is 14:00 UTC.
    const visit = at('2026-10-20', '14:00');
    const [two, three] = nextVisitOptions(visit, 60, rules(), [], new Date(at('2026-10-20', '15:10')));
    expect(two.at!.toISOString()).toBe('2026-11-03T14:00:00.000Z');
    expect(three.at!.toISOString()).toBe('2026-11-10T14:00:00.000Z');
    expect(two.same && three.same).toBe(true);
  });

  it('only offers times still to come, and leaves out choices whose days have all gone', () => {
    // Finished three weeks late, on 24 November at 14:30: "In 2 weeks" (14–20 Nov) has gone; on
    // "In 3 weeks" the day itself has only later times left.
    const late = new Date(at('2026-11-24', '14:30'));
    expect(shown(nextVisitOptions(VISIT, 60, rules(), [], late))).toEqual(['3: Tue 24 Nov, 14:45 (nearest)', '4: Tue 1 Dec, 14:00']);
    expect(nextVisitOptions(VISIT, 60, rules(), [], new Date(at('2027-01-01', '12:00')))).toEqual([]);
  });

  it('says which days need their busy times', () => {
    expect(nextVisitDays(VISIT, 'Europe/London')).toEqual({ first: '2026-11-14', last: '2026-12-04' });
  });
});

describe('what the next-visit step says', () => {
  it('says what was recorded', () => {
    expect(doneLine(3500, 0)).toBe('Done: £35 recorded.');
    expect(doneLine(2550, 500)).toBe('Done: £25.50 and a £5 tip recorded.');
    expect(doneLine(0, 300)).toBe('Done: a £3 tip recorded.');
    expect(doneLine(0, 0)).toBe('Done: no payment recorded today.');
  });

  it('asks about the next visit by first name', () => {
    expect(nextVisitQuestion('Jess Collins', 'BIAB infill')).toBe('Book Jess’s next BIAB infill?');
    expect(nextVisitQuestion(null, 'BIAB infill')).toBe('Book their next BIAB infill?');
  });
});

describe('the same treatment, and their last one', () => {
  const services = [
    { id: 'infill', name: 'BIAB infill', duration_min: 70, price_pence: 3200, is_active: true },
    { id: 'acrylic', name: 'Acrylic full set', duration_min: 105, price_pence: 4000, is_active: false },
  ];
  const appt = { service_id: 'infill', service_name: 'BIAB infill', duration_min: 60, price_pence: 3000 };

  it('books one of her treatments at its length and price now', () => {
    expect(sameTreatment(appt, services)).toEqual({ serviceId: 'infill', name: 'BIAB infill', minutes: 70, pricePence: 3200 });
  });

  it('books "Something else…" with the booking’s own details when it isn’t on her list, or isn’t offered now', () => {
    expect(sameTreatment({ ...appt, service_id: null, service_name: 'Nail repair', duration_min: 20, price_pence: 800 }, services))
      .toEqual({ serviceId: null, name: 'Nail repair', minutes: 20, pricePence: 800 });
    expect(sameTreatment({ service_id: 'acrylic', service_name: 'Acrylic full set', duration_min: 105, price_pence: 3800 }, services))
      .toEqual({ serviceId: null, name: 'Acrylic full set', minutes: 105, pricePence: 3800 });
  });

  it('finds the latest booking that wasn’t cancelled, including one coming up', () => {
    const list = [
      { id: 'a', status: 'completed' as const, starts_at: '2026-10-01T10:00:00.000Z' },
      { id: 'b', status: 'cancelled' as const, starts_at: '2026-12-01T10:00:00.000Z' },
      { id: 'c', status: 'confirmed' as const, starts_at: '2026-11-20T10:00:00.000Z' },
      { id: 'd', status: 'no_show' as const, starts_at: '2026-10-20T10:00:00.000Z' },
    ];
    expect(latestBooking(list)?.id).toBe('c');
    expect(latestBooking(list.slice(0, 2))?.id).toBe('a');
    expect(latestBooking([list[1]])).toBeNull();
    expect(latestBooking([])).toBeNull();
  });
});

describe('the New appointment link', () => {
  it('carries the client, the treatment, the day and the time', () => {
    const link = newAppointmentLink('client-1', { serviceId: 'infill', name: 'BIAB infill', minutes: 60, pricePence: 3000 }, { day: '2026-12-01', time: '14:00' });
    expect(link).toBe('/appointments/new?client=client-1&service=infill&d=2026-12-01&t=14%3A00');
    expect(readNewAppointmentLink(new URL(link, 'http://x').searchParams)).toEqual({
      clientId: 'client-1', serviceId: 'infill', custom: null, day: '2026-12-01', time: '14:00',
    });
  });

  it('carries "Something else…" with its name, minutes and price', () => {
    const link = newAppointmentLink('client-1', { serviceId: null, name: 'Nail repair & gems', minutes: 20, pricePence: 850 });
    expect(readNewAppointmentLink(new URL(link, 'http://x').searchParams)).toEqual({
      clientId: 'client-1', serviceId: 'custom', custom: { name: 'Nail repair & gems', duration: '20', price: '8.50' }, day: null, time: null,
    });
    expect(readNewAppointmentLink(new URLSearchParams(newAppointmentLink('c', { serviceId: null, name: 'Repair', minutes: 30, pricePence: 1500 }).split('?')[1])).custom)
      .toEqual({ name: 'Repair', duration: '30', price: '15' });
  });

  it('is just the client without a treatment, as it was before', () => {
    expect(newAppointmentLink('client-1')).toBe('/appointments/new?client=client-1');
    expect(readNewAppointmentLink(new URLSearchParams('client=client-1&d=2026-11-20'))).toEqual({
      clientId: 'client-1', serviceId: null, custom: null, day: '2026-11-20', time: null,
    });
  });

  it('leaves out anything malformed', () => {
    const read = readNewAppointmentLink(new URLSearchParams('d=2026-13-45&t=25:00&service=custom&mins=4&price=£5&name=' + 'x'.repeat(90)));
    expect(read).toMatchObject({ clientId: null, day: null, time: null, custom: { duration: '60', price: '' } });
    expect(read.custom!.name).toHaveLength(80);
    expect(readNewAppointmentLink(new URLSearchParams('t=9:00')).time).toBeNull();
  });
});
