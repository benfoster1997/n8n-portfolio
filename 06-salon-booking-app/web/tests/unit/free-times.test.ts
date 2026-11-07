import { describe, expect, it } from 'vitest';
import {
  clock12, findTreatment, mostBookedFirst, separateTimes, shareableTimes, shareMessage, spanDays, spanRange, spreadOrder, treatmentLink,
  treatmentParam, treatmentSlug,
} from '../../src/lib/freeTimes';
import { availableSlots, type SlotRules } from '../../src/lib/slots';
import { fmtDay, fmtDayTime, zonedToInstant } from '../../src/lib/time';
import type { OpeningHours } from '../../src/lib/types';

// The booking page's rules as the demo has them: 09:30–17:30 on weekdays (19:00 on Thursdays),
// 09:00–15:00 on Saturdays, closed on Sundays; starts every 15 minutes, a 10-minute clean-up gap,
// 12 hours' notice and 60 days ahead.
const hours = (): OpeningHours[] => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday, is_open: weekday !== 7, open_time: weekday === 6 ? '09:00' : '09:30',
  close_time: weekday === 6 ? '15:00' : weekday === 4 ? '19:00' : '17:30', break_start: null, break_end: null,
}));
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  timezone: 'Europe/London', slot_interval_min: 15, buffer_min: 10, min_notice_hours: 12, max_days_ahead: 60, hours: hours(), ...over,
});
const at = (day: string, hhmm: string) => zonedToInstant(day, hhmm);
const NOW = at('2026-11-04', '17:00'); // Wednesday 4 November 2026
const shown = (times: Date[]) => times.map((d) => fmtDayTime(d));
const MIN = 60e3;

describe('which days "This week" and "Next 2 weeks" cover', () => {
  it('takes today and the 6 or 13 days after it that are open, up to how far ahead clients can book', () => {
    expect(spanDays(rules(), 'week', NOW)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10']);
    expect(spanDays(rules(), 'fortnight', NOW)).toHaveLength(12);
    expect(spanDays(rules({ max_days_ahead: 3 }), 'fortnight', NOW)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect(spanRange(rules(), 'week', NOW)).toEqual({ first: '2026-11-04', last: '2026-11-10' });
    expect(spanRange(rules(), 'fortnight', NOW)).toEqual({ first: '2026-11-04', last: '2026-11-17' });
    expect(spanRange(rules({ max_days_ahead: 3 }), 'fortnight', NOW)).toEqual({ first: '2026-11-04', last: '2026-11-07' });
  });
});

describe('free times worth listing', () => {
  it('lists only separate spaces: each starts once the one before has finished and been cleaned up after', () => {
    const starts = ['09:00', '09:15', '09:30', '10:00', '10:15', '10:30', '12:00', '12:15'].map((t) => at('2026-11-05', t));
    expect(separateTimes(starts, 60, 10).map((d) => fmtDayTime(d))).toEqual(['Thu 5 Nov, 09:00', 'Thu 5 Nov, 10:15', 'Thu 5 Nov, 12:00']);
  });

  it('picks a day’s times earliest, latest, then each farthest from those already picked', () => {
    const t = ['09:00', '10:00', '11:00', '12:00', '13:00'].map((x) => at('2026-11-05', x));
    expect(spreadOrder(t).map((d) => fmtDayTime(d).slice(-5))).toEqual(['09:00', '13:00', '11:00', '10:00', '12:00']);
  });

  it('spreads up to 8 times over the days: one on each day, then a second on each, earliest and latest', () => {
    // Monday to Wednesday 9–11 November, nothing booked: 8 times, 3 + 3 + 2.
    const days = ['2026-11-09', '2026-11-10', '2026-11-11'];
    // Each day has room for 09:30, 10:45, 12:00, 13:15, 14:30 and 15:45 (an hour, then 10 minutes' clean-up).
    expect(shown(shareableTimes(rules(), 60, days, [], NOW))).toEqual([
      'Mon 9 Nov, 09:30', 'Mon 9 Nov, 12:00', 'Mon 9 Nov, 15:45',
      'Tue 10 Nov, 09:30', 'Tue 10 Nov, 12:00', 'Tue 10 Nov, 15:45',
      'Wed 11 Nov, 09:30', 'Wed 11 Nov, 15:45',
    ]);
  });

  it('with more days than times, takes one on each of 8 days spread out, alternately early and late', () => {
    // 11 days have times (today is inside the notice): 8 of them, from the first to the last.
    const times = shareableTimes(rules(), 60, spanDays(rules(), 'fortnight', NOW), [], NOW);
    expect(shown(times)).toEqual([
      'Thu 5 Nov, 09:30', 'Fri 6 Nov, 15:45', 'Mon 9 Nov, 09:30', 'Tue 10 Nov, 15:45',
      'Thu 12 Nov, 09:30', 'Fri 13 Nov, 15:45', 'Mon 16 Nov, 09:30', 'Tue 17 Nov, 15:45',
    ]);
  });

  it('follows the booking page’s rules: notice, how far ahead, the interval, other bookings and time off', () => {
    const busy = [
      // Thursday: someone 10:00–12:00 (busy to 12:10); the afternoon off from 15:00.
      { starts_at: at('2026-11-05', '10:00').toISOString(), ends_at: at('2026-11-05', '12:10').toISOString() },
      { starts_at: at('2026-11-05', '15:00').toISOString(), ends_at: at('2026-11-06', '00:00').toISOString() },
    ];
    const r = rules({ slot_interval_min: 30 });
    const days = ['2026-11-04', '2026-11-05'];
    const times = shareableTimes(r, 60, days, busy, NOW);
    // Today is inside the 12 hours' notice. Thursday: before 10:00 and from 12:10 to 15:00, every 30 minutes from 09:30.
    expect(shown(times)).toEqual(['Thu 5 Nov, 12:30']);
    // Every time listed is one the booking page offers.
    for (const t of shareableTimes(rules(), 45, spanDays(rules(), 'fortnight', NOW), busy, NOW)) {
      const day = t.toISOString().slice(0, 10);
      expect(availableSlots(day, 45, rules(), busy, NOW).map((d) => d.getTime())).toContain(t.getTime());
    }
    // How far ahead: nothing past the horizon.
    expect(shareableTimes(rules({ max_days_ahead: 2 }), 60, ['2026-11-09'], [], NOW)).toEqual([]);
  });

  it('never lists two times that overlap', () => {
    const times = shareableTimes(rules(), 75, ['2026-11-05'], [], NOW, 20);
    for (let i = 1; i < times.length; i++) expect(times[i].getTime() - times[i - 1].getTime()).toBeGreaterThanOrEqual((75 + 10) * MIN);
  });

  it('gives nothing when nothing is free', () => {
    const off = [{ starts_at: at('2026-11-04', '00:00').toISOString(), ends_at: at('2026-11-20', '00:00').toISOString() }];
    expect(shareableTimes(rules(), 60, spanDays(rules(), 'fortnight', NOW), off, NOW)).toEqual([]);
  });
});

describe('the message', () => {
  it('writes times the way clients do', () => {
    expect(clock12(at('2026-11-10', '14:00'), 'Europe/London')).toBe('2pm');
    expect(clock12(at('2026-11-10', '10:30'), 'Europe/London')).toBe('10:30am');
    expect(clock12(at('2026-11-10', '09:00'), 'Europe/London')).toBe('9am');
    expect(clock12(at('2026-11-10', '12:00'), 'Europe/London')).toBe('12pm');
    expect(clock12(at('2026-11-10', '12:45'), 'Europe/London')).toBe('12:45pm');
    expect(clock12(at('2026-11-10', '00:30'), 'Europe/London')).toBe('12:30am');
    expect(clock12('2026-06-10T13:00:00Z', 'Europe/London')).toBe('2pm'); // summer time
  });

  it('lists the times by day, in order, with her link', () => {
    const times = [at('2026-11-14', '09:00'), at('2026-11-12', '15:00'), at('2026-11-10', '14:00'), at('2026-11-12', '10:30')];
    expect(shareMessage('BIAB infill', times, 'Europe/London', 'https://studio.example/book?treatment=biab-infill')).toBe(
      'Spaces for BIAB infill: Tue 10 Nov 2pm · Thu 12 Nov 10:30am, 3pm · Sat 14 Nov 9am. Book here: https://studio.example/book?treatment=biab-infill');
  });
});

describe('a booking link for one treatment', () => {
  const services = [
    { id: 'id-gel', name: 'Gel polish — hands' },
    { id: 'id-infill', name: 'BIAB infill' },
    { id: 'id-ombre', name: 'Ombré & chrome' },
  ];

  it('names the treatment in words', () => {
    expect(treatmentSlug('Gel polish — hands')).toBe('gel-polish-hands');
    expect(treatmentSlug('BIAB infill')).toBe('biab-infill');
    expect(treatmentSlug('Ombré & chrome')).toBe('ombre-and-chrome');
    expect(treatmentSlug('💅')).toBe('');
    expect(treatmentLink('https://studio.example/book', services[1], services)).toBe('https://studio.example/book?treatment=biab-infill');
  });

  it('uses the id when the words would be the same as another treatment’s, or there are none', () => {
    const alike = [...services, { id: 'id-gel-2', name: 'Gel polish - hands' }];
    expect(treatmentParam(alike[0], alike)).toBe('id-gel');
    expect(treatmentParam(alike[3], alike)).toBe('id-gel-2');
    expect(treatmentParam({ id: 'id-nail', name: '💅' }, services)).toBe('id-nail');
  });

  it('is read back by id or by name; anything else opens the usual page', () => {
    expect(findTreatment('biab-infill', services)?.id).toBe('id-infill');
    expect(findTreatment('BIAB-Infill', services)?.id).toBe('id-infill');
    expect(findTreatment('id-gel', services)?.id).toBe('id-gel');
    expect(findTreatment('ombre-and-chrome', services)?.id).toBe('id-ombre');
    // Not bookable online (so not in the booking page's list), renamed, or nothing at all.
    expect(findTreatment('removal-only', services)).toBeNull();
    expect(findTreatment('', services)).toBeNull();
    expect(findTreatment(null, services)).toBeNull();
  });
});

describe('her most-booked treatments first', () => {
  it('counts bookings that weren’t cancelled, and keeps her own order for a tie', () => {
    const services = [{ id: 'gel' }, { id: 'biab' }, { id: 'infill' }, { id: 'toes' }];
    const appts = [
      { service_id: 'infill', status: 'completed' as const }, { service_id: 'infill', status: 'confirmed' as const },
      { service_id: 'infill', status: 'no_show' as const },
      { service_id: 'biab', status: 'confirmed' as const }, { service_id: 'gel', status: 'pending_deposit' as const },
      { service_id: 'toes', status: 'cancelled' as const }, { service_id: 'toes', status: 'cancelled' as const },
      { service_id: null, status: 'completed' as const },
    ];
    expect(mostBookedFirst(services, appts).map((s) => s.id)).toEqual(['infill', 'gel', 'biab', 'toes']);
    expect(mostBookedFirst(services, []).map((s) => s.id)).toEqual(['gel', 'biab', 'infill', 'toes']);
  });
});

describe('dates in the sheet', () => {
  it('shows a span as "Wed 4 Nov to Tue 10 Nov"', () => {
    const r = spanRange(rules(), 'week', NOW);
    expect(`${fmtDay(`${r.first}T12:00:00Z`)} to ${fmtDay(`${r.last}T12:00:00Z`)}`).toBe('Wed 4 Nov to Tue 10 Nov');
  });
});
