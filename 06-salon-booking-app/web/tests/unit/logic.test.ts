import { describe, expect, it } from 'vitest';
import { availableSlots, openDays, type SlotRules } from '../../src/lib/slots';
import { addDays, fmtTime, isoWeekday, startOfWeek, zonedToInstant } from '../../src/lib/time';
import {
  fillTemplate, friendlyError, money, normalizeUkPhone, parsePounds, taxYearOf, toCsv, whatsappLink, DEFAULT_TEMPLATES,
} from '../../src/lib/text';
import { blankAnswers, describeAnswers, validateAnswers } from '../../src/lib/consultation';
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
