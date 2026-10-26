import { describe, expect, it } from 'vitest';
import { availableSlots, openDays, type SlotRules } from '../../src/lib/slots';
import { addDays, fmtTime, isoWeekday, startOfWeek, zonedToInstant } from '../../src/lib/time';
import {
  fillTemplate, friendlyError, money, normalizeUkPhone, parsePounds, taxYearOf, toCsv, whatsappLink, DEFAULT_TEMPLATES,
} from '../../src/lib/text';
import { blankAnswers, describeAnswers, validateAnswers } from '../../src/lib/consultation';
import { dueWhatsAppReminders, reminderDates, reminderDays, reminderRange } from '../../src/lib/reminders';
import type { Appointment, OpeningHours, Settings } from '../../src/lib/types';

const allWeek = (open = '09:00', close = '17:00', extra: Partial<OpeningHours> = {}): OpeningHours[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, is_open: true, open_time: open, close_time: close, break_start: null, break_end: null, ...extra }));

const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  timezone: 'Europe/London', slot_interval_min: 15, buffer_min: 10, min_notice_hours: 0, max_days_ahead: 400, hours: allWeek(), ...over,
});

// A fixed "now" well before the test dates, so notice rules don't interfere.
const NOW = new Date('2026-01-01T00:00:00Z');

describe('slots', () => {
  it('offers every interval from opening until the treatment would overrun closing', () => {
    const s = availableSlots('2026-06-10', 60, rules(), [], NOW).map((d) => fmtTime(d));
    expect(s[0]).toBe('09:00');
    expect(s.at(-1)).toBe('16:00');
    expect(s).toHaveLength(29);
  });

  it('uses London wall-clock time in summer (BST) and winter (GMT)', () => {
    expect(availableSlots('2026-06-10', 60, rules(), [], NOW)[0].toISOString()).toBe('2026-06-10T08:00:00.000Z');
    expect(availableSlots('2026-12-10', 60, rules(), [], NOW)[0].toISOString()).toBe('2026-12-10T09:00:00.000Z');
  });

  it('skips times that do not exist when the clocks go forward', () => {
    const night = rules({ hours: allWeek('00:00', '04:00') });
    const s = availableSlots('2026-03-29', 30, night, [], NOW).map((d) => fmtTime(d));
    expect(s).not.toContain('01:00');
    expect(s).not.toContain('01:30');
    expect(s).toContain('02:00');
  });

  it('keeps the clean-up buffer around existing appointments', () => {
    // Existing 10:00–10:45, busy until 10:55.
    const busy = [{ starts_at: '2026-06-10T09:00:00Z', ends_at: '2026-06-10T09:55:00Z' }];
    const s = availableSlots('2026-06-10', 45, rules(), busy, NOW).map((d) => fmtTime(d));
    expect(s).toContain('09:00');    // 09:00 + 45 + 10 = 09:55 ≤ 10:00
    expect(s).not.toContain('09:15'); // would run into 10:00
    expect(s).not.toContain('10:45');
    expect(s).toContain('11:00');
  });

  it('respects breaks, closed days, notice and the horizon', () => {
    const lunch = rules({ hours: allWeek('09:00', '17:00', { break_start: '13:00', break_end: '14:00' }) });
    const s = availableSlots('2026-06-10', 60, lunch, [], NOW).map((d) => fmtTime(d));
    expect(s).toContain('12:00');
    expect(s).not.toContain('12:15');
    expect(s).not.toContain('13:30');
    expect(s).toContain('14:00');

    const closedWed = rules({ hours: allWeek().map((h) => (h.weekday === 3 ? { ...h, is_open: false } : h)) });
    expect(availableSlots('2026-06-10', 60, closedWed, [], NOW)).toEqual([]);

    const now = zonedToInstant('2026-06-10', '10:00');
    const notice = availableSlots('2026-06-10', 30, rules({ min_notice_hours: 3 }), [], now).map((d) => fmtTime(d));
    expect(notice[0]).toBe('13:00');
    expect(availableSlots('2026-06-10', 30, rules({ min_notice_hours: 3 }), [], now, { ignoreNotice: true })[0]).toBeDefined();
    expect(availableSlots('2026-09-01', 30, rules({ max_days_ahead: 30 }), [], now)).toEqual([]);
  });

  it('lists open days up to the horizon', () => {
    const now = new Date('2026-06-08T12:00:00Z'); // a Monday
    const weekdaysOnly = rules({ max_days_ahead: 6, hours: allWeek().map((h) => ({ ...h, is_open: h.weekday <= 5 })) });
    expect(openDays(weekdaysOnly, now)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12']);
  });
});

describe('calendar arithmetic', () => {
  it('adds days and finds weekdays without time-zone surprises', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoWeekday('2026-06-07')).toBe(7);
    expect(isoWeekday('2026-06-08')).toBe(1);
    expect(startOfWeek('2026-06-07')).toBe('2026-06-01');
  });
});

describe('phones, money and links', () => {
  it('normalises UK numbers the same way as the database', () => {
    expect(normalizeUkPhone('07700 900123')).toBe('447700900123');
    expect(normalizeUkPhone('+44 (0)7700 900123')).toBe('447700900123');
    expect(normalizeUkPhone('0044 7700 900123')).toBe('447700900123');
    expect(normalizeUkPhone('7700900123')).toBe('447700900123');
    expect(normalizeUkPhone('')).toBeNull();
  });

  it('formats and parses pounds', () => {
    expect(money(2500)).toBe('£25');
    expect(money(2550)).toBe('£25.50');
    expect(money(-1000)).toBe('−£10');
    expect(money(123456)).toBe('£1,234.56');
    expect(parsePounds('£25.5')).toBe(2550);
    expect(parsePounds('1,250')).toBe(125000);
    expect(parsePounds('25,50')).toBe(2550);
    expect(parsePounds('7,5')).toBe(750);
    expect(parsePounds('1,250.50')).toBe(125050);
    expect(parsePounds('12,34,5')).toBeNull();
    expect(parsePounds('12.345')).toBeNull();
    expect(parsePounds('abc')).toBeNull();
  });

  it('builds WhatsApp links with the message encoded', () => {
    expect(whatsappLink('447700900123', 'Hi Jess & co!')).toBe('https://wa.me/447700900123?text=Hi%20Jess%20%26%20co!');
  });
});

describe('UK tax year', () => {
  it('runs 6 April to 5 April', () => {
    expect(taxYearOf('2026-04-05')).toEqual({ label: '2025–26', from: '2025-04-06', to: '2026-04-05' });
    expect(taxYearOf('2026-04-06')).toEqual({ label: '2026–27', from: '2026-04-06', to: '2027-04-05' });
    expect(taxYearOf('2027-01-15').label).toBe('2026–27');
  });
});

describe('CSV export', () => {
  it('quotes awkward values and blocks spreadsheet formulas', () => {
    const csv = toCsv([['Name', 'Note'], ['Smith, Jo', 'said "hi"'], ['=HYPERLINK("x")', '-12.50']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"Smith, Jo","said ""hi"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")",-12.50`);
  });
});

describe('message templates', () => {
  const s = {
    business_name: 'Test Studio', timezone: 'Europe/London', deposit_amount_pence: 1000,
    bank_account_name: 'T Studio', bank_sort_code: '00-00-00', bank_account_number: '12345678',
    wa_template_reminder: null, wa_template_deposit: null, wa_template_confirmed: null,
  } as unknown as Settings;
  const a = {
    service_name: 'BIAB infill', starts_at: '2026-06-10T09:30:00Z', price_pence: 3000, deposit_required_pence: 1000,
    reference: 'K3Q7XP', booking_name: 'Jess Example', client: { full_name: 'Jess Example' },
  } as unknown as Appointment;

  it('fills in the details in London time', () => {
    const text = fillTemplate(DEFAULT_TEMPLATES.reminder, a, s);
    expect(text).toContain('Hi Jess!');
    expect(text).toContain('BIAB infill');
    expect(text).toContain('Wednesday 10 June at 10:30');
  });

  it('puts the bank details and reference in a deposit request', () => {
    const text = fillTemplate(DEFAULT_TEMPLATES.deposit, a, s);
    expect(text).toContain('£10');
    expect(text).toContain('Sort code: 00-00-00');
    expect(text).toContain('Reference: K3Q7XP');
  });

  it('leaves unknown placeholders as typed', () => {
    expect(fillTemplate('Hi {first_name} {nonsense}', a, s)).toBe('Hi Jess {nonsense}');
  });
});

describe('WhatsApp reminders', () => {
  const rules = (hours = 72) => ({ timezone: 'Europe/London', reminder_hours_before: hours });
  let n = 0;
  type Over = Partial<Pick<Appointment, 'status' | 'whatsapp_reminder_sent_at'>> & { client?: { phone_e164: string | null } | null };
  const appt = (starts_at: string, over: Over = {}) => ({
    id: `a${++n}`, starts_at, status: 'confirmed' as Appointment['status'], whatsapp_reminder_sent_at: null as string | null,
    client: { phone_e164: '447700900101' } as { phone_e164: string | null } | null, ...over,
  });
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it('counts the reminder setting in whole days, never less than tomorrow', () => {
    expect(reminderDays(72)).toBe(3);
    expect(reminderDays(48)).toBe(2);
    expect(reminderDays(25)).toBe(2);
    expect(reminderDays(24)).toBe(1);
    expect(reminderDays(2)).toBe(1);
    expect(reminderDays(0)).toBe(1);
    expect(reminderDays(168)).toBe(7);
  });

  it('covers tomorrow up to three days ahead for 72 hours, up to the last minute of the last day', () => {
    const now = new Date('2026-06-10T09:00:00Z'); // Wed 10:00 BST
    expect(reminderDates(rules(), now)).toEqual(['2026-06-11', '2026-06-12', '2026-06-13']);
    const today = appt('2026-06-10T15:00:00Z');
    const firstThing = appt('2026-06-10T23:00:00Z'); // 00:00 BST Thursday: tomorrow
    const lastDay = appt('2026-06-13T22:59:00Z'); // 23:59 BST Saturday
    const tooFar = appt('2026-06-13T23:00:00Z'); // 00:00 BST Sunday
    expect(ids(dueWhatsAppReminders([tooFar, lastDay, today, firstThing], rules(), now))).toEqual([firstThing.id, lastDay.id]);
    // 24 hours means tomorrow only.
    expect(ids(dueWhatsAppReminders([tooFar, lastDay, today, firstThing], rules(24), now))).toEqual([firstThing.id]);
  });

  it('uses London calendar days when the clocks go back', () => {
    // Saturday 24 Oct 2026, 23:30 BST. The clocks go back at 02:00 on Sunday.
    const now = new Date('2026-10-24T22:30:00Z');
    expect(reminderDates(rules(), now)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    const lateTonight = appt('2026-10-24T22:45:00Z'); // 23:45 BST Saturday: still today
    const afterMidnight = appt('2026-10-24T23:30:00Z'); // 00:30 BST Sunday (still the 24th in UTC)
    const lastEvening = appt('2026-10-27T23:30:00Z'); // 23:30 GMT Tuesday
    const wednesday = appt('2026-10-28T00:15:00Z'); // 00:15 GMT Wednesday
    expect(ids(dueWhatsAppReminders([lateTonight, afterMidnight, lastEvening, wednesday], rules(), now)))
      .toEqual([afterMidnight.id, lastEvening.id]);
    // The list loads from midnight BST today to midnight GMT after the last day.
    expect(reminderRange(rules(), now)).toEqual({ fromIso: '2026-10-23T23:00:00.000Z', toIso: '2026-10-28T00:00:00.000Z' });
  });

  it('uses London calendar days when the clocks go forward', () => {
    const now = new Date('2026-03-28T23:30:00Z'); // Saturday 23:30 GMT
    const tuesdayNight = appt('2026-03-31T22:30:00Z'); // 23:30 BST Tuesday 31 March
    const wednesday = appt('2026-03-31T23:30:00Z'); // 00:30 BST Wednesday 1 April (31 March in UTC)
    expect(ids(dueWhatsAppReminders([tuesdayNight, wednesday], rules(), now))).toEqual([tuesdayNight.id]);
  });

  it('leaves out ones already sent, cancelled or finished, and clients without a mobile', () => {
    const now = new Date('2026-06-10T09:00:00Z');
    const at = '2026-06-11T10:00:00Z';
    const due = appt(at);
    const deposit = appt('2026-06-12T10:00:00Z', { status: 'pending_deposit' });
    const list = [
      due, deposit,
      appt(at, { whatsapp_reminder_sent_at: '2026-06-10T08:00:00Z' }),
      appt(at, { status: 'cancelled' }),
      appt(at, { status: 'completed' }),
      appt(at, { status: 'no_show' }),
      appt(at, { client: { phone_e164: null } }),
      appt(at, { client: null }),
    ];
    expect(ids(dueWhatsAppReminders(list, rules(), now))).toEqual([due.id, deposit.id]);
  });
});

describe('consultation form', () => {
  it('requires every yes/no answer, and details for a yes', () => {
    const a = blankAnswers();
    expect(validateAnswers(a)).toMatch(/allergies/i);
    a.allergies = 'yes';
    expect(validateAnswers(a)).toMatch(/details/i);
    a.allergies_details = 'HEMA';
    a.previous_reaction = 'no';
    a.medication = 'no';
    expect(validateAnswers(a)).toBeNull();
    const rows = describeAnswers(a);
    expect(rows.find((r) => r.flag)?.answer).toBe('Yes — HEMA');
  });
});

describe('error wording', () => {
  it('turns database codes into plain English', () => {
    expect(friendlyError(new Error('slot_taken'))).toMatch(/just been taken/);
    expect(friendlyError({ message: 'conflicting key value violates exclusion constraint "appointments_no_overlap"' })).toMatch(/clashes/);
    expect(friendlyError(new Error('Something odd'))).toBe('Something odd');
  });
});
