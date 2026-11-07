import { describe, expect, it } from 'vitest';
import { consentOnly, formLine, formOnFile, latestPatchTest, needingForms, patchTestLine } from '../../src/lib/health';
import type { ApptHealth, ApptStatus } from '../../src/lib/types';

// The health strip at the top of an appointment, and Today's list of anyone without a form.
const tz = 'Europe/London';
const STARTS = '2026-11-10T10:00:00.000Z';
const health = (over: Partial<ApptHealth> = {}): ApptHealth =>
  ({ allergies: null, consent_at: null, consent_note: null, is_regular: false, patch_tests: [], forms: [], ...over });

describe('patch test line', () => {
  it('none on file', () => {
    expect(patchTestLine([], tz, STARTS)).toEqual({ text: 'none on file', tone: 'quiet' });
  });

  it('the app’s three results: no reaction, reaction, waiting', () => {
    expect(patchTestLine([{ tested_on: '2026-10-03', result: 'pass' }], tz, STARTS)).toEqual({ text: 'no reaction 3 Oct', tone: 'ok' });
    expect(patchTestLine([{ tested_on: '2026-10-03', result: 'reaction' }], tz, STARTS)).toEqual({ text: 'reaction 3 Oct', tone: 'danger' });
    expect(patchTestLine([{ tested_on: '2026-11-08', result: 'pending' }], tz, STARTS)).toEqual({ text: 'waiting since 8 Nov', tone: 'warn' });
  });

  it('the newest counts, with the year when it’s from another one', () => {
    const tests = [{ tested_on: '2025-06-01', result: 'reaction' as const }, { tested_on: '2025-09-14', result: 'pass' as const }];
    expect(patchTestLine(tests, tz, STARTS).text).toBe('no reaction 14 Sep 2025');
  });

  it('on a day with two, a reaction comes before no reaction, and both before waiting', () => {
    expect(latestPatchTest([
      { tested_on: '2026-10-03', result: 'pending' }, { tested_on: '2026-10-03', result: 'pass' },
    ])?.result).toBe('pass');
    expect(latestPatchTest([
      { tested_on: '2026-10-03', result: 'pass' }, { tested_on: '2026-10-03', result: 'reaction' },
    ])?.result).toBe('reaction');
  });
});

describe('consultation form line', () => {
  it('none on file', () => {
    expect(formLine(health(), tz, STARTS)).toEqual({ text: 'none on file', onFile: false, old: false });
  });

  it('the online form: on file, with the date of the newest', () => {
    const h = health({ forms: ['2026-09-12T18:30:00.000Z', '2025-08-01T10:00:00.000Z'], consent_at: '2026-09-12T18:30:00.000Z', consent_note: 'Online consultation form' });
    expect(formLine(h, tz, STARTS)).toEqual({ text: 'on file, 12 Sep', onFile: true, old: false });
  });

  it('consent she recorded counts as on file, and says how it was given', () => {
    const at = '2026-09-12T12:00:00.000Z';
    expect(formLine(health({ consent_at: at, consent_note: 'Paper consultation form' }), tz, STARTS).text).toBe('on file, 12 Sep (paper)');
    expect(formLine(health({ consent_at: at, consent_note: 'Paper consultation form' }), tz, STARTS).onFile).toBe(true);
  });

  it('consent from a WhatsApp message or an email is consent recorded, not a form, though it still counts', () => {
    const at = '2026-09-12T12:00:00.000Z';
    expect(formLine(health({ consent_at: at, consent_note: 'WhatsApp message' }), tz, STARTS))
      .toEqual({ text: 'consent recorded, 12 Sep (by WhatsApp)', onFile: true, old: false });
    expect(formLine(health({ consent_at: at, consent_note: 'Email' }), tz, STARTS))
      .toEqual({ text: 'consent recorded, 12 Sep (by email)', onFile: true, old: false });
    expect(consentOnly(formOnFile(health({ consent_at: at, consent_note: 'WhatsApp message' })))).toBe(true);
    // A paper form, or the online one, is a form.
    expect(consentOnly(formOnFile(health({ consent_at: at, consent_note: 'Paper consultation form' })))).toBe(false);
    expect(consentOnly(formOnFile(health({ forms: [at], consent_at: at, consent_note: 'Online consultation form' })))).toBe(false);
    expect(consentOnly(null)).toBe(false);
    // An online form filled in since a WhatsApp consent is what's on file.
    expect(formLine(health({ forms: ['2026-10-01T10:00:00.000Z'], consent_at: at, consent_note: 'WhatsApp message' }), tz, STARTS).text)
      .toBe('on file, 1 Oct');
  });

  it('whichever is newer: a form, or consent she recorded since', () => {
    const form = '2025-03-01T10:00:00.000Z';
    expect(formOnFile(health({ forms: [form], consent_at: '2026-09-12T12:00:00.000Z', consent_note: 'Paper consultation form' })))
      .toEqual({ date: '2026-09-12T12:00:00.000Z', how: 'paper' });
    expect(formOnFile(health({ forms: ['2026-10-01T10:00:00.000Z'], consent_at: form, consent_note: 'Paper consultation form' })))
      .toEqual({ date: '2026-10-01T10:00:00.000Z', how: null });
  });

  it('over a year before the appointment is worth a fresh one', () => {
    expect(formLine(health({ forms: ['2025-11-09T10:00:00.000Z'] }), tz, STARTS)).toEqual({ text: 'on file, 9 Nov 2025', onFile: true, old: true });
    expect(formLine(health({ forms: ['2025-11-11T10:00:00.000Z'] }), tz, STARTS).old).toBe(false);
    expect(formLine(health({ consent_at: '2025-01-05T12:00:00.000Z', consent_note: 'Paper consultation form' }), tz, STARTS).old).toBe(true);
  });
});

describe('Today: anyone booked in the next 14 days with no form and no recorded consent', () => {
  const NOW = new Date('2026-11-06T09:00:00Z');
  let n = 0;
  const appt = (client_id: string, starts: string, over: { status?: ApptStatus; has_form?: boolean; has_consent?: boolean; is_new_client?: boolean } = {}) =>
    ({ id: `a${++n}`, client_id, starts_at: new Date(starts).toISOString(), ends_at: new Date(new Date(starts).getTime() + 3600e3).toISOString(),
      status: 'confirmed' as ApptStatus, has_form: false, has_consent: false, is_new_client: false, ...over });

  it('regulars as well as new clients, once each, at their soonest booking', () => {
    const list = needingForms([
      appt('regular', '2026-11-12T10:00:00Z'),
      appt('new', '2026-11-07T10:00:00Z', { is_new_client: true, status: 'pending_deposit' }),
      appt('regular', '2026-11-08T10:00:00Z'),
    ], NOW);
    expect(list.map((a) => [a.client_id, a.starts_at.slice(0, 10)])).toEqual([['new', '2026-11-07'], ['regular', '2026-11-08']]);
  });

  it('not anyone with a form or consent she recorded, nor bookings that are over or cancelled, nor more than 14 days ahead', () => {
    const list = needingForms([
      appt('form', '2026-11-07T10:00:00Z', { has_form: true }),
      appt('paper', '2026-11-07T11:00:00Z', { has_consent: true }),
      appt('done', '2026-11-06T08:00:00Z', { status: 'completed' }),
      appt('cancelled', '2026-11-07T12:00:00Z', { status: 'cancelled' }),
      appt('noshow', '2026-11-06T08:00:00Z', { status: 'no_show' }),
      appt('later', '2026-11-21T10:00:00Z'),
      appt('soon', '2026-11-20T08:00:00Z'),
    ], NOW);
    expect(list.map((a) => a.client_id)).toEqual(['soon']);
  });

  it('not a visit that’s over (it’s under Not finished yet): the client’s next one instead, if any; one still on stays', () => {
    const list = needingForms([
      appt('isla', '2026-11-06T07:00:00Z'), // 07:00–08:00 today: over, never finished
      appt('isla', '2026-11-10T10:00:00Z'),
      appt('grace', '2026-11-06T07:30:00Z'), // over, and nothing else booked
      appt('ruby', '2026-11-06T08:30:00Z'), // on now, until 09:30
    ], NOW);
    expect(list.map((a) => [a.client_id, a.starts_at.slice(0, 10)])).toEqual([['ruby', '2026-11-06'], ['isla', '2026-11-10']]);
  });
});
