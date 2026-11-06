import { afterEach, describe, expect, it, vi } from 'vitest';
import { friendlyError, isNetworkError, NO_SIGNAL } from '../../src/lib/text';
import { isStale, RETURN_DELAY_MS, STALE_AFTER_MS } from '../../src/components/ui';
import { bookingFailure } from '../../src/pages/public/Book';
import { demoApi, resetDemo } from '../../src/api/demoApi';
import { availableSlots } from '../../src/lib/slots';
import { dateInZone } from '../../src/lib/time';

// Plain "no signal" wording, the booking page when the signal drops at Confirm booking, and
// when a screen left open on her phone reloads itself.
vi.mock('../../src/api', () => ({ api: {} }));

describe('no signal, in plain words', () => {
  it('every browser’s way of saying a request got no answer', () => {
    for (const raw of [
      'TypeError: Load failed', // Safari on an iPhone, through the Supabase client
      'Load failed',
      'TypeError: Failed to fetch', // Chrome and Edge
      'TypeError: NetworkError when attempting to fetch resource.', // Firefox
      'The Internet connection appears to be offline.', // older iPhones
      'The network connection was lost.',
      'AuthRetryableFetchError: Load failed', // signing in
    ]) {
      expect(isNetworkError(new Error(raw))).toBe(true);
      expect(friendlyError(new Error(raw))).toBe('No signal: check your connection and try again.');
      // The Supabase client's errors are plain objects too.
      expect(friendlyError({ message: raw })).toBe(NO_SIGNAL);
    }
  });

  it('everything else keeps its own wording', () => {
    expect(isNetworkError(new Error('slot_taken'))).toBe(false);
    expect(friendlyError(new Error('slot_taken'))).toBe('Sorry, that time has just been taken. Please pick another.');
    expect(friendlyError(new Error('Something odd'))).toBe('Something odd');
    expect(friendlyError(new Error('booking_no_reply'))).toBe('No signal: we couldn’t tell whether your booking went through. '
      + 'Check your email for a confirmation (it can take up to 10 minutes) before you try again.');
  });
});

describe('the booking page when Confirm booking fails', () => {
  it('no signal: the booking may have gone through', () => {
    expect(bookingFailure(new Error('TypeError: Load failed'))).toBe('no_reply');
    expect(bookingFailure({ message: 'TypeError: Failed to fetch' })).toBe('no_reply');
  });
  it('the time has just gone (or is now too soon): back to the free times', () => {
    for (const code of ['slot_taken', 'too_soon', 'too_far', 'closed', 'outside_hours', 'invalid_time']) {
      expect(bookingFailure(new Error(code))).toBe('time_gone');
    }
  });
  it('anything else stays on their details', () => {
    for (const code of ['busy_try_later', 'invalid_email', 'policy_required', 'booking_disabled']) {
      expect(bookingFailure(new Error(code))).toBe('other');
    }
  });
});

describe('the demo, like the real thing with no signal', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetDemo(); });
  const online = { onLine: true };
  const offline = { onLine: false };

  it('nothing goes through while the phone is offline, in the same words as the live app on an iPhone', async () => {
    vi.stubGlobal('navigator', offline);
    const api = demoApi();
    const err = await api.getBookingInfo().catch((e) => e);
    expect(err.message).toBe('TypeError: Load failed');
    expect(friendlyError(err)).toBe(NO_SIGNAL);
    // Being signed in is kept on the phone, as it is in the live app.
    await expect(api.getSession()).resolves.toBeNull();
  });

  it('a booking that reached the server but whose answer was lost: made, so trying the same time again says it’s taken', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T09:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const nav = { ...online };
    vi.stubGlobal('navigator', nav);
    const api = demoApi();
    const loading = api.getBookingInfo();
    await vi.advanceTimersByTimeAsync(100);
    const info = await loading;
    const service = info.services[0];
    const day = '2026-11-10';
    const busy = api.getBusyTimes(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(100);
    const slot = availableSlots(day, service.duration_min, info, await busy)[0];
    expect(dateInZone(slot)).toBe(day);
    const request = {
      service_id: service.id, starts_at: slot.toISOString(), full_name: 'Poppy Tester', email: 'poppy@example.com', phone: '07700 900777',
      notes: null, consultation: null, health_consent: false, signed_name: null, policy_accepted: true,
    };
    // The signal drops while the answer is on its way back.
    const first = api.createBooking(request).catch((e) => e);
    nav.onLine = false;
    await vi.advanceTimersByTimeAsync(100);
    const lost = await first;
    expect(bookingFailure(lost)).toBe('no_reply');
    // Back online, the same time again: it's theirs now, so it's "taken".
    nav.onLine = true;
    const again = api.createBooking(request).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(bookingFailure(await again)).toBe('time_gone');
  });
});

describe('when a screen left open reloads itself', () => {
  const TZ = 'Europe/London';
  const at = (iso: string) => new Date(iso).getTime();
  it('never before it has loaded', () => {
    expect(isStale(null, at('2026-11-05T08:31:00Z'), TZ)).toBe(false);
  });
  it('after a few minutes', () => {
    expect(STALE_AFTER_MS).toBe(5 * 60e3);
    expect(isStale(at('2026-11-05T08:00:00Z'), at('2026-11-05T08:04:59Z'), TZ)).toBe(false);
    expect(isStale(at('2026-11-05T08:00:00Z'), at('2026-11-05T08:05:00Z'), TZ)).toBe(true);
  });
  it('as soon as the day has changed in London, even a minute later', () => {
    expect(isStale(at('2026-11-04T23:59:00Z'), at('2026-11-05T00:01:00Z'), TZ)).toBe(true);
    // In summer, midnight in London is 23:00 in UTC.
    expect(isStale(at('2026-06-01T22:58:00Z'), at('2026-06-01T23:01:00Z'), TZ)).toBe(true);
    expect(isStale(at('2026-06-01T23:10:00Z'), at('2026-06-01T23:12:00Z'), TZ)).toBe(false);
  });
  it('waits about a second after she comes back (iOS can fail a request made the instant it does)', () => {
    expect(RETURN_DELAY_MS).toBeGreaterThanOrEqual(800);
    expect(RETURN_DELAY_MS).toBeLessThanOrEqual(1500);
  });
});
