import { describe, expect, it } from 'vitest';
import { isUnfinished, noShowQuestion, todayNote } from '../../src/lib/unfinished';
import type { ApptStatus } from '../../src/lib/types';

// Appointments that are over but still say Confirmed or Deposit due, and what Today and the
// appointment screen say about them.
const NOW = new Date('2026-11-06T17:00:00Z'); // a Friday, 17:00 in London (GMT)
const appt = (status: ApptStatus, starts: string, mins = 60) => ({
  status, starts_at: new Date(starts).toISOString(), ends_at: new Date(new Date(starts).getTime() + mins * 60e3).toISOString(),
});

describe('which appointments are not finished', () => {
  it('is over and still says Confirmed or Deposit due', () => {
    expect(isUnfinished(appt('confirmed', '2026-11-02T14:00:00Z'), NOW.getTime())).toBe(true);
    expect(isUnfinished(appt('pending_deposit', '2026-10-01T10:00:00Z'), NOW.getTime())).toBe(true);
    // Ended at exactly this moment counts too.
    expect(isUnfinished(appt('confirmed', '2026-11-06T16:00:00Z'), NOW.getTime())).toBe(true);
  });

  it('isn’t while it’s still on, or still to come', () => {
    expect(isUnfinished(appt('confirmed', '2026-11-06T16:30:00Z'), NOW.getTime())).toBe(false);
    expect(isUnfinished(appt('pending_deposit', '2026-11-07T10:00:00Z'), NOW.getTime())).toBe(false);
  });

  it('isn’t once it’s been finished, marked a no-show or cancelled', () => {
    for (const status of ['completed', 'no_show', 'cancelled'] as const) {
      expect(isUnfinished(appt(status, '2026-11-02T14:00:00Z'), NOW.getTime())).toBe(false);
    }
  });
});

describe('Today’s first tile', () => {
  const tz = 'Europe/London';
  it('says what’s next, or what’s on', () => {
    expect(todayNote([appt('confirmed', '2026-11-06T18:00:00Z')], 0, tz, NOW)).toBe('Next 18:00');
    expect(todayNote([appt('confirmed', '2026-11-06T16:30:00Z')], 0, tz, NOW)).toBe('On now');
    // Something earlier left unfinished doesn't hide what's next.
    expect(todayNote([appt('confirmed', '2026-11-06T10:00:00Z'), appt('confirmed', '2026-11-06T18:00:00Z')], 1, tz, NOW)).toBe('Next 18:00');
  });

  it('says "All done" only when nothing needs finishing', () => {
    const over = [appt('completed', '2026-11-06T10:00:00Z'), appt('no_show', '2026-11-06T13:00:00Z')];
    expect(todayNote(over, 0, tz, NOW)).toBe('All done');
    expect(todayNote(over, 3, tz, NOW)).toBe('3 to finish');
    expect(todayNote([appt('confirmed', '2026-11-06T10:00:00Z')], 1, tz, NOW)).toBe('1 to finish');
  });

  it('a day with nothing booked is a free day', () => {
    expect(todayNote([], 0, tz, NOW)).toBe('Free day');
    expect(todayNote([], 2, tz, NOW)).toBe('Free day');
  });
});

describe('the No-show question', () => {
  const base = 'Mark Jess as a no-show? It can’t be undone, and they aren’t emailed.';
  const again = 'if they book online again with the email address on their record.';

  it('a new client is still asked for the deposit next time', () => {
    expect(noShowQuestion({ name: 'Jess', visits: 0, regular: false, hasEmail: true, depositPence: 1000 }))
      .toBe(`${base} Jess hasn’t had a visit marked as done, so they’ll still be asked for a £10 deposit if they book online again.`);
  });

  it('a returning client isn’t, and the question doesn’t say they are', () => {
    const q = noShowQuestion({ name: 'Jess', visits: 4, regular: false, hasEmail: true, depositPence: 1000 });
    expect(q).toBe(`${base} As Jess has had a visit marked as done before, they won’t be asked for a £10 deposit ${again}`);
    expect(q).not.toMatch(/new client|deposit required|still be asked/);
  });

  it('nor is a regular moved across from another app', () => {
    expect(noShowQuestion({ name: 'Jess', visits: 0, regular: true, hasEmail: true, depositPence: 1500 }))
      .toBe(`${base} As Jess is ticked as a regular, they won’t be asked for a £15 deposit ${again}`);
  });

  it('with deposits switched off it doesn’t mention one', () => {
    expect(noShowQuestion({ name: 'Jess', visits: 0, regular: false, hasEmail: true, depositPence: 0 })).toBe(base);
    expect(noShowQuestion({ name: 'Jess', visits: 3, regular: false, hasEmail: false, depositPence: 0 })).toBe(base);
  });

  it('when the visits couldn’t be checked, it gives the rule rather than guess', () => {
    expect(noShowQuestion({ name: 'Jess', visits: null, regular: false, hasEmail: true, depositPence: 1000 }))
      .toBe(`${base} Anyone who hasn’t had a visit marked as done, and isn’t ticked as a regular, is asked for a £10 deposit when they book online.`);
  });

  it('a regular is told so even when the visits couldn’t be checked', () => {
    expect(noShowQuestion({ name: 'Jess', visits: null, regular: true, hasEmail: true, depositPence: 1000 }))
      .toBe(`${base} As Jess is ticked as a regular, they won’t be asked for a £10 deposit ${again}`);
  });

  it('a client with no email address on their record would be a new client online, visits or not', () => {
    const noEmail = `${base} Jess has no email address on their record, so if they book online they’ll be asked for the £10 deposit like a new client.`;
    expect(noShowQuestion({ name: 'Jess', visits: 1, regular: false, hasEmail: false, depositPence: 1000 })).toBe(noEmail);
    expect(noShowQuestion({ name: 'Jess', visits: 0, regular: true, hasEmail: false, depositPence: 1000 })).toBe(noEmail);
    expect(noShowQuestion({ name: 'Jess', visits: null, regular: false, hasEmail: false, depositPence: 1000 })).toBe(noEmail);
  });

  it('with no name, says “the client”', () => {
    expect(noShowQuestion({ name: '', visits: 0, regular: false, hasEmail: true, depositPence: 1000 }))
      .toBe('Mark the client as a no-show? It can’t be undone, and they aren’t emailed. The client hasn’t had a visit marked as done, '
        + 'so they’ll still be asked for a £10 deposit if they book online again.');
    expect(noShowQuestion({ name: '', visits: 2, regular: false, hasEmail: false, depositPence: 1000 }))
      .toBe('Mark the client as a no-show? It can’t be undone, and they aren’t emailed. The client has no email address on their record, '
        + 'so if they book online they’ll be asked for the £10 deposit like a new client.');
  });
});
