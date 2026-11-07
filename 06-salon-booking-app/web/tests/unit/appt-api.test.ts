import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { supabaseApi } from '../../src/api/supabaseApi';
import { demoApi } from '../../src/api/demoApi';
import type { Api } from '../../src/api/api';

// What an appointment comes with, the same in the live API (supabaseApi, against stand-in
// answers from Supabase) and the demo (demoApi): lists only know whether a client has
// allergies, consent and a form recorded; one appointment brings the client's health
// information; and Today's one extra question, the appointments that are over but not finished.
type Call = { url: URL; method: string; headers: Headers };
function serve(answer: (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...a.headers } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

const live = supabaseApi('https://example.supabase.co', 'sb_publishable_test');
const ALLERGY = 'Sensitive to HEMA — use HEMA-free gel only.';
const row = (over: Record<string, unknown> = {}, client: Record<string, unknown> = {}) => ({
  id: 'a1', client_id: 'c1', service_id: null, service_name: 'BIAB infill', price_pence: 3000, duration_min: 60,
  starts_at: '2026-11-02T14:00:00+00:00', ends_at: '2026-11-02T15:00:00+00:00', status: 'confirmed', source: 'owner',
  booking_name: null, is_new_client: false, deposit_required_pence: 0, deposit_due_at: null, deposit_paid_at: null,
  reference: 'K3Q7XP', public_token: 't', client_notes: null, cancellation_policy_agreed: null, owner_notes: null,
  reminder_email_sent_at: null, whatsapp_reminder_sent_at: null, cancelled_at: null, cancel_reason: null, cancelled_by: null,
  cancelled_late: false, client_change_count: 0, client_changed_at: null, details_sent_at: null, moved_at: null,
  late_fee_pence: null, booking_phone: null, created_at: '2026-10-20T09:00:00+00:00',
  client: { id: 'c1', full_name: 'Grace Patel', email: 'grace@example.com', phone: '07700 900102', phone_e164: '447700900102',
    allergies: ALLERGY, health_consent_at: '2026-09-12T12:00:00+00:00', consultation_forms: [{ count: 0 }], ...client },
  ...over,
});
// supabase-js sends the select list without its spaces.
const select = (c: Call) => c.url.searchParams.get('select') ?? '';
const compact = (s: string) => s.replace(/\s+/g, '');

describe('the live API', () => {
  it('lists say whether a client has allergies, consent and a form, but never what the allergies are', async () => {
    const calls = serve(() => ({ body: [row()] }));
    const [a] = await live.listAppointments('2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    expect(select(calls[0])).toContain(compact('client:clients(id, full_name, email, phone, phone_e164, allergies, health_consent_at, consultation_forms(count))'));
    expect(a).toMatchObject({ has_allergies: true, has_consent: true, has_form: false, starts_at: '2026-11-02T14:00:00.000Z' });
    expect(a.client).toEqual({ id: 'c1', full_name: 'Grace Patel', email: 'grace@example.com', phone: '07700 900102', phone_e164: '447700900102' });
    expect(JSON.stringify(a)).not.toContain(ALLERGY);
    expect(a.health).toBeUndefined();
  });

  it('a blank allergies box isn’t an allergy, and no consent is no consent', async () => {
    serve(() => ({ body: [row({}, { allergies: '  ', health_consent_at: null, consultation_forms: [{ count: 2 }] })] }));
    const [a] = await live.listAppointments('2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    expect(a).toMatchObject({ has_allergies: false, has_consent: false, has_form: true });
  });

  it('one appointment comes with the client’s allergies, consent, patch tests and forms, newest first', async () => {
    const calls = serve(() => ({
      body: [row({}, {
        is_regular: true, health_consent_note: 'Paper consultation form',
        consultation_forms: [{ submitted_at: '2025-08-01T10:00:00+00:00' }, { submitted_at: '2026-09-12T18:30:00+00:00' }],
        patch_tests: [{ tested_on: '2026-03-01', result: 'pending' }, { tested_on: '2026-10-03', result: 'pass' }],
      })],
    }));
    const a = await live.getAppointment('a1');
    const sel = select(calls[0]);
    for (const part of ['allergies', 'is_regular', 'health_consent_at', 'health_consent_note', 'consultation_forms(submitted_at)', 'patch_tests(tested_on, result)']) {
      expect(sel).toContain(compact(part));
    }
    expect(a!.health).toEqual({
      allergies: ALLERGY, consent_at: '2026-09-12T12:00:00.000Z', consent_note: 'Paper consultation form', is_regular: true,
      patch_tests: [{ tested_on: '2026-10-03', result: 'pass' }, { tested_on: '2026-03-01', result: 'pending' }],
      forms: ['2026-09-12T18:30:00.000Z', '2025-08-01T10:00:00.000Z'],
    });
    expect(a).toMatchObject({ has_form: true, has_consent: true, has_allergies: true });
  });

  it('saving a change to the appointment brings the health information back too', async () => {
    const calls = serve(() => ({ status: 200, body: row({ owner_notes: 'HEMA-free gel!' }, { consultation_forms: [], patch_tests: [] }) }));
    const a = await live.updateAppointment('a1', { owner_notes: 'HEMA-free gel!' });
    expect(calls[0].method).toBe('PATCH');
    expect(select(calls[0])).toContain(compact('patch_tests(tested_on, result)'));
    expect(a.health).toMatchObject({ allergies: ALLERGY, forms: [], patch_tests: [] });
    expect(a.has_form).toBe(false);
  });

  it('not finished yet: one question, for the oldest few that are over but still Confirmed or Deposit due, and how many in all', async () => {
    const calls = serve(() => ({ body: [row(), row({ id: 'a2', status: 'pending_deposit' })], headers: { 'content-range': '0-1/7' } }));
    const r = await live.listUnfinished('2026-11-06T17:00:00.000Z', 5);
    expect(calls).toHaveLength(1);
    const q = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/rest/v1/appointments');
    expect(q.get('status')).toBe('in.(confirmed,pending_deposit)');
    expect(q.get('ends_at')).toBe('lte.2026-11-06T17:00:00.000Z');
    expect(q.get('order')).toBe('starts_at.asc,id.asc');
    expect(q.get('limit')).toBe('5');
    expect(calls[0].headers.get('prefer')).toMatch(/count=exact/);
    expect(r.total).toBe(7);
    expect(r.appts.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(JSON.stringify(r)).not.toContain(ALLERGY);
  });
});

describe('the demo, the same way', () => {
  let demo: Api;
  beforeAll(async () => {
    demo = demoApi();
    await demo.signIn('owner@example.com', '');
  });

  it('not finished yet: oldest first, a few at a time, with how many in all', async () => {
    const now = new Date().toISOString();
    const all = await demo.listUnfinished(now, 50);
    // The seed: a new client who never paid or came (5 days ago), and a visit nobody finished (4 days ago),
    // then today's, once they're over.
    expect(all.appts.slice(0, 2).map((a) => [a.booking_name, a.status])).toEqual([['Jess Collins', 'pending_deposit'], ['Grace Patel', 'confirmed']]);
    expect(all.total).toBe(all.appts.length);
    for (const a of all.appts) {
      expect(['confirmed', 'pending_deposit']).toContain(a.status);
      expect(new Date(a.ends_at).getTime()).toBeLessThanOrEqual(new Date(now).getTime());
    }
    expect(all.appts.map((a) => a.starts_at)).toEqual([...all.appts.map((a) => a.starts_at)].sort());
    const one = await demo.listUnfinished(now, 1);
    expect(one).toMatchObject({ total: all.total });
    expect(one.appts.map((a) => a.id)).toEqual([all.appts[0].id]);
  });

  it('lists know only whether there are allergies; one appointment brings the details', async () => {
    const from = new Date(Date.now() - 30 * 86400e3).toISOString();
    const to = new Date(Date.now() + 30 * 86400e3).toISOString();
    const list = await demo.listAppointments(from, to);
    const grace = list.filter((a) => a.client?.full_name === 'Grace Patel');
    expect(grace.length).toBeGreaterThan(0);
    for (const a of grace) expect(a).toMatchObject({ has_allergies: true, has_consent: true, has_form: false });
    // (Her own note on one booking says "HEMA-free gel!": that's hers to see. The allergy text isn't there.)
    expect(JSON.stringify(list)).not.toContain(ALLERGY);
    const one = await demo.getAppointment(grace[0].id);
    expect(one!.health).toMatchObject({ allergies: ALLERGY, consent_note: 'Paper consultation form', is_regular: false, forms: [] });
    expect(one!.health!.patch_tests).toEqual([{ tested_on: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), result: 'pass' }]);
  });
});
