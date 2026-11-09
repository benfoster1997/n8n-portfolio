import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { supabaseApi } from '../../src/api/supabaseApi';
import { demoApi } from '../../src/api/demoApi';
import { NeedsUpdateError, type Api } from '../../src/api/api';
import { friendlyError, isNetworkError } from '../../src/lib/text';
import { summariseNewClients } from '../../src/lib/source';
import { availableSlots } from '../../src/lib/slots';
import { addDays, todayInZone } from '../../src/lib/time';
import type { BookingRequest } from '../../src/lib/types';

// Where clients come from and short-notice spaces in the API: the live one (supabaseApi) against
// stand-in answers from Supabase, including a project that hasn't run
// supabase/updates/2026-11-growth.sql yet, and the demo.

type Call = { url: URL; method: string; body: Record<string, unknown> | null };
type Answer = { status?: number; body: unknown };
function serve(answer: (c: Call, n: number) => Answer | Error) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: new URL(input instanceof Request ? input.url : String(input)), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const a = answer(c, calls.length);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

const live = supabaseApi('https://example.supabase.co', 'sb_publishable_test');
const REQUEST: BookingRequest = {
  service_id: 's1', starts_at: '2026-11-20T10:00:00.000Z', full_name: 'Amy Example', email: 'amy@example.com', phone: '07700 900111',
  notes: null, consultation: null, health_consent: false, signed_name: null, policy_accepted: true,
};
const TEN = ['p_consultation', 'p_email', 'p_full_name', 'p_health_consent', 'p_notes', 'p_phone', 'p_policy_accepted', 'p_service_id',
  'p_signed_name', 'p_starts_at'];
const BOOKED: Answer = { body: { reference: 'K3Q7XP', starts_at: '2026-11-20T10:00:00+00:00' } };
// What PostgREST says when there's no function that takes those inputs: the update hasn't been run.
const NO_SUCH_FUNCTION: Answer = {
  status: 404,
  body: { code: 'PGRST202', details: 'Searched for the function public.public_create_booking with parameter p_extras…',
    hint: 'Perhaps you meant to call the function public.public_create_booking(p_consultation, p_email, …)',
    message: 'Could not find the function public.public_create_booking(p_consultation, p_email, p_extras, p_full_name, '
      + 'p_health_consent, p_notes, p_phone, p_policy_accepted, p_service_id, p_signed_name, p_starts_at) in the schema cache' },
};
const isBooking = (c: Call) => c.url.pathname === '/rest/v1/rpc/public_create_booking' && c.method === 'POST';

describe('a booking with the optional answers, in the live app', () => {
  it('sends them, tidied, with the booking: one call', async () => {
    const calls = serve(() => BOOKED);
    const r = await live.createBooking({ ...REQUEST, extras: { link_source: 'Instagram!!', heard_from: 'friend', heard_from_detail: ' Sam ',
      first_visit: true, marketing_ok: true } });
    expect(r).toEqual({ reference: 'K3Q7XP', starts_at: '2026-11-20T10:00:00+00:00' });
    expect(calls).toHaveLength(1);
    expect(isBooking(calls[0])).toBe(true);
    expect(calls[0].body!.p_extras).toEqual({ link_source: 'instagram', heard_from: 'friend', heard_from_detail: 'Sam', first_visit: true,
      marketing_ok: true });
    expect(Object.keys(calls[0].body!).sort()).toEqual([...TEN, 'p_extras'].sort());
  });

  it('with no answers, or only blank ones, sends the ten inputs it always has', async () => {
    const calls = serve(() => BOOKED);
    await live.createBooking(REQUEST);
    await live.createBooking({ ...REQUEST, extras: { link_source: '', heard_from: null, first_visit: null, marketing_ok: false } });
    await live.createBooking({ ...REQUEST, extras: { heard_from_detail: 'Sam' } });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(Object.keys(c.body!).sort()).toEqual(TEN);
  });

  it('“No, I’ve been before” is still sent', async () => {
    const calls = serve(() => BOOKED);
    await live.createBooking({ ...REQUEST, extras: { first_visit: false } });
    expect(calls[0].body!.p_extras).toEqual({ first_visit: false });
  });

  it('before the database update: no function takes the answers, so it books again without them, once', async () => {
    const calls = serve((_c, n) => (n === 1 ? NO_SUCH_FUNCTION : BOOKED));
    const r = await live.createBooking({ ...REQUEST, extras: { link_source: 'card', marketing_ok: true } });
    expect(r.reference).toBe('K3Q7XP');
    expect(calls).toHaveLength(2);
    expect(calls[0].body!.p_extras).toEqual({ link_source: 'card', marketing_ok: true });
    expect(Object.keys(calls[1].body!).sort()).toEqual(TEN);
    expect(calls[1].body).toEqual(Object.fromEntries(Object.entries(calls[0].body!).filter(([k]) => k !== 'p_extras')));
  });

  it('never tries more than twice, or again without answers', async () => {
    const twice = serve(() => NO_SUCH_FUNCTION);
    await expect(live.createBooking({ ...REQUEST, extras: { link_source: 'card' } })).rejects.toThrow(/Could not find the function/);
    expect(twice).toHaveLength(2);
    const once = serve(() => NO_SUCH_FUNCTION);
    await expect(live.createBooking(REQUEST)).rejects.toThrow(/Could not find the function/);
    expect(once).toHaveLength(1);
  });

  it('any other answer stands: a time that’s gone, or a reply lost on the way back (it may have booked)', async () => {
    const taken = serve(() => ({ status: 400, body: { code: 'P0001', details: null, hint: null, message: 'slot_taken' } }));
    const e = await live.createBooking({ ...REQUEST, extras: { link_source: 'card' } }).catch((x: unknown) => x);
    expect(friendlyError(e)).toBe('Sorry, that time has just been taken. Please pick another.');
    expect(taken).toHaveLength(1);
    const lost = serve(() => new TypeError('Load failed'));
    const e2 = await live.createBooking({ ...REQUEST, extras: { link_source: 'card' } }).catch((x: unknown) => x);
    expect(isNetworkError(e2)).toBe(true);
    expect(lost).toHaveLength(1);
  });
});

describe('the owner’s new lists, in the live app', () => {
  it('new clients’ bookings: booked in the period, online first visits and her own bookings for new clients', async () => {
    const calls = serve(() => ({
      body: [{ id: 'a1', client_id: 'c1', status: 'completed', created_at: '2026-11-02T10:00:00+00:00', link_source: 'instagram', heard_from: null,
        heard_from_detail: null, client: { full_name: 'Amy Example' } },
      { id: 'a2', client_id: 'c2', status: 'confirmed', created_at: '2026-11-03T10:00:00+00:00', link_source: null, heard_from: 'friend',
        heard_from_detail: 'Sam', client: null }],
    }));
    const rows = await live.listNewClientBookings('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    const q = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/rest/v1/appointments');
    expect(q.get('select')).toBe('id,client_id,status,created_at,link_source,heard_from,heard_from_detail,client:clients(full_name)');
    expect(q.getAll('created_at')).toEqual(['gte.2026-11-01T00:00:00.000Z', 'lt.2026-12-01T00:00:00.000Z']);
    // An online booking with no answer (made before this version, or before the database update) counts by
    // the database's own rule, so the months before the update aren't empty.
    expect(q.get('or')).toBe('(and(source.eq.online,first_visit_said.is.true),'
      + 'and(source.eq.online,first_visit_said.is.null,is_new_client.is.true),and(source.eq.owner,is_new_client.is.true))');
    expect(q.get('order')).toBe('created_at.asc,id.asc');
    expect(rows).toEqual([
      { id: 'a1', client_id: 'c1', status: 'completed', created_at: '2026-11-02T10:00:00.000Z', link_source: 'instagram', heard_from: null,
        heard_from_detail: null, full_name: 'Amy Example' },
      { id: 'a2', client_id: 'c2', status: 'confirmed', created_at: '2026-11-03T10:00:00.000Z', link_source: null, heard_from: 'friend',
        heard_from_detail: 'Sam', full_name: null },
    ]);
  });

  it('the short-notice list: clients who said yes and have a mobile, by name', async () => {
    const calls = serve(() => ({
      body: [{ id: 'c1', full_name: 'Amy Example', phone_e164: '447700900111', marketing_ok_at: '2026-11-02T10:00:00+00:00',
        marketing_ok_note: 'Ticked on the booking page' }],
    }));
    const list = await live.listShortNoticeClients();
    const q = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe('/rest/v1/clients');
    expect(q.get('select')).toBe('id,full_name,phone_e164,marketing_ok_at,marketing_ok_note');
    expect(q.get('marketing_ok_at')).toBe('not.is.null');
    expect(q.get('phone_e164')).toBe('not.is.null');
    expect(q.get('order')).toBe('full_name.asc,id.asc');
    expect(list).toEqual([{ id: 'c1', full_name: 'Amy Example', phone_e164: '447700900111', marketing_ok_at: '2026-11-02T10:00:00.000Z',
      marketing_ok_note: 'Ticked on the booking page' }]);
  });
});

describe('before the database update has been run', () => {
  const missingColumn = (message: string): Answer => ({ status: 400, body: { code: '42703', details: null, hint: null, message } });
  const notInCache = (column: string, table: string): Answer => ({
    status: 400, body: { code: 'PGRST204', details: null, hint: null, message: `Could not find the '${column}' column of '${table}' in the schema cache` },
  });
  const needsUpdate = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NeedsUpdateError);
    expect(friendlyError(e)).toMatch(/hasn’t been run yet/);
  };

  it('the new lists say the update is needed', async () => {
    serve(() => missingColumn('column appointments.link_source does not exist'));
    await needsUpdate(live.listNewClientBookings('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'));
    serve(() => missingColumn('column clients.marketing_ok_at does not exist'));
    await needsUpdate(live.listShortNoticeClients());
  });

  it('so does saving one of the new fields', async () => {
    serve(() => notInCache('review_link', 'settings'));
    await needsUpdate(live.updateSettings({ review_link: 'https://g.page/r/demo-studio/review' }));
    serve(() => notInCache('wa_template_review', 'settings'));
    await needsUpdate(live.updateSettings({ wa_template_review: 'Thank you!' }));
    serve(() => notInCache('marketing_ok_at', 'clients'));
    await needsUpdate(live.updateClient('c1', { marketing_ok_at: '2026-11-02T10:00:00.000Z', marketing_ok_note: 'Said yes in the studio' }));
    serve(() => notInCache('review_asked_at', 'clients'));
    await needsUpdate(live.updateClient('c1', { review_asked_at: '2026-11-02T10:00:00.000Z' }));
    serve(() => notInCache('heard_from', 'appointments'));
    await needsUpdate(live.updateAppointment('a1', { heard_from: 'card' }));
  });

  it('other errors aren’t taken for it', async () => {
    serve(() => notInCache('tagline', 'settings'));
    const e = await live.updateSettings({ tagline: 'Hello' }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(NeedsUpdateError);
    expect((e as Error).message).toMatch(/Could not find the 'tagline' column/);
    serve(() => ({ status: 401, body: { code: 'PGRST301', details: null, hint: null, message: 'JWT expired' } }));
    await expect(live.listShortNoticeClients()).rejects.toThrow('JWT expired');
    serve(() => ({ status: 400, body: { code: '23514', details: null, hint: null,
      message: 'new row for relation "settings" violates check constraint "settings_review_link_check"' } }));
    const e2 = await live.updateSettings({ review_link: 'https://x' }).catch((x: unknown) => x);
    expect(e2).not.toBeInstanceOf(NeedsUpdateError);
    expect(friendlyError(e2)).toBe('That value is out of range — please check it.');
  });

  it('everything that was there works as before, with the new fields empty', async () => {
    serve((c) => {
      if (c.url.pathname === '/rest/v1/settings') return { body: { business_name: 'Demo Nail Studio', timezone: 'Europe/London' } };
      if (c.url.pathname === '/rest/v1/clients') return { body: { id: 'c1', full_name: 'Amy Example' } };
      return { body: [{ id: 'a1', client_id: 'c1', starts_at: '2026-11-02T14:00:00+00:00', ends_at: '2026-11-02T15:00:00+00:00',
        created_at: '2026-10-20T09:00:00+00:00', status: 'confirmed', client: null }] };
    });
    expect(await live.getSettings()).toMatchObject({ business_name: 'Demo Nail Studio', review_link: null, wa_template_review: null });
    expect(await live.getClient('c1')).toMatchObject({ full_name: 'Amy Example', marketing_ok_at: null, marketing_ok_note: null, review_asked_at: null });
    const [a] = await live.listAppointments('2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    expect(a).toMatchObject({ link_source: null, heard_from: null, heard_from_detail: null, first_visit_said: null });
  });

  it('once it has been run, what’s saved comes through', async () => {
    serve(() => ({ body: { id: 'c1', full_name: 'Amy Example', marketing_ok_at: '2026-11-02T10:00:00+00:00', marketing_ok_note: 'Ticked on the booking page',
      review_asked_at: null } }));
    expect(await live.getClient('c1')).toMatchObject({ marketing_ok_at: '2026-11-02T10:00:00.000Z', marketing_ok_note: 'Ticked on the booking page' });
  });
});

describe('the demo, the same way', () => {
  let demo: Api;
  beforeAll(async () => {
    demo = demoApi();
    await demo.signIn('owner@example.com', '');
  });
  const wide = () => [new Date(Date.now() - 60 * 86400e3).toISOString(), new Date(Date.now() + 60 * 86400e3).toISOString()] as const;

  it('has no social handles (any that looked real could be a stranger’s, who’d get its Message me taps), and no review link yet', async () => {
    const s = await demo.getSettings();
    expect([s.instagram_handle, s.facebook_handle, s.review_link, s.wa_template_review]).toEqual([null, null, null, null]);
    const info = await demo.getBookingInfo();
    expect([info.instagram_handle, info.facebook_handle, info.contact_email]).toEqual([null, null, 'owner@example.com']);
  });

  it('knows where a few clients came from, and who’s on the short-notice list', async () => {
    const all = await demo.listAppointments(...wide());
    const by = (name: string) => all.filter((a) => a.client?.full_name === name && (a.link_source || a.heard_from));
    expect(by('Sophie Turner').map((a) => [a.link_source, a.first_visit_said, a.source])).toEqual([['instagram', true, 'online']]);
    expect(by('Jess Collins').map((a) => [a.heard_from, a.heard_from_detail, a.first_visit_said])).toEqual([['friend', 'Sam', true]]);
    expect(by('Amelia Hart').map((a) => [a.link_source, a.first_visit_said])).toEqual([['google', false]]);
    expect(await demo.listShortNoticeClients()).toEqual([{ id: expect.any(String), full_name: 'Sophie Turner', phone_e164: '447700900103',
      marketing_ok_at: expect.any(String), marketing_ok_note: 'Ticked on the booking page' }]);
    // Money → New clients: Sophie (her Instagram link, and a visit she booked by phone), and Jess (a friend, Sam).
    const s = summariseNewClients(await demo.listNewClientBookings(...wide()));
    expect(s).toEqual({ booked: 2, came: 0, byAnswer: [{ label: 'A friend', count: 1, names: ['Sam'] }],
      byLink: [{ label: 'your Instagram link', count: 1 }], didntSay: 1 });
  });

  it('keeps a booking’s answers, tidied, and the short-notice box on the client; the owner can change them', async () => {
    const info = await demo.getBookingInfo();
    const service = info.services[0];
    const busy = await demo.getBusyTimes(new Date(), new Date(Date.now() + 50 * 86400e3));
    let slot: Date | undefined;
    for (let d = 20; !slot && d < 40; d++) slot = availableSlots(addDays(todayInZone(info.timezone), d), service.duration_min, info, busy)[0];
    const before = Date.now();
    const r = await demo.createBooking({ ...REQUEST, service_id: service.id, starts_at: slot!.toISOString(), full_name: 'Kim Example',
      email: 'kim@example.com', phone: '07700 900555', extras: { link_source: 'Free Times', heard_from: 'other', heard_from_detail: 'www.example.com',
        first_visit: true, marketing_ok: true } });
    const a = (await demo.listAppointments(...wide())).find((x) => x.reference === r.reference)!;
    expect([a.link_source, a.heard_from, a.heard_from_detail, a.first_visit_said]).toEqual(['freetimes', 'other', null, true]);
    expect((await demo.listShortNoticeClients()).map((c) => c.full_name)).toEqual(['Kim Example', 'Sophie Turner']);
    const mine = await demo.listNewClientBookings(new Date(before - 1000).toISOString(), new Date(Date.now() + 1000).toISOString());
    expect(mine.map((x) => [x.id, x.full_name])).toEqual([[a.id, 'Kim Example']]);

    const changed = await demo.updateAppointment(a.id, { heard_from: 'friend', heard_from_detail: 'Amy' });
    expect([changed.heard_from, changed.heard_from_detail]).toEqual(['friend', 'Amy']);
    const c = await demo.updateClient(a.client_id, { marketing_ok_at: null, marketing_ok_note: null, review_asked_at: '2026-11-09T10:00:00.000Z' });
    expect([c.marketing_ok_at, c.review_asked_at]).toEqual([null, '2026-11-09T10:00:00.000Z']);
    expect((await demo.listShortNoticeClients()).map((x) => x.full_name)).toEqual(['Sophie Turner']);
    const s = await demo.updateSettings({ review_link: 'https://g.page/r/demo-studio/review' });
    expect(s.review_link).toBe('https://g.page/r/demo-studio/review');
  });

  it('New clients counts an online booking with no answer by the database’s rule, as made before this version', async () => {
    const info = await demo.getBookingInfo();
    const service = info.services[0];
    const busy = await demo.getBusyTimes(new Date(), new Date(Date.now() + 60 * 86400e3));
    const slots: Date[] = [];
    for (let d = 30; slots.length < 3 && d < 41; d++) {
      const first = availableSlots(addDays(todayInZone(info.timezone), d), service.duration_min, info, busy)[0];
      if (first) slots.push(first);
    }
    const before = Date.now();
    const book = (full_name: string, email: string, phone: string, at: Date, extras?: BookingRequest['extras']) =>
      demo.createBooking({ ...REQUEST, service_id: service.id, starts_at: at.toISOString(), full_name, email, phone, extras });
    // Someone new with no answer (the app before this version sent none), someone new who said they'd
    // been before, and Ruby, who has, with no answer.
    await book('Lou Example', 'lou@example.com', '07700 900661', slots[0]);
    await book('Mia Example', 'mia@example.com', '07700 900662', slots[1], { first_visit: false });
    await book('Ruby Clarke', 'ruby@example.com', '07700 900106', slots[2]);
    const rows = await demo.listNewClientBookings(new Date(before).toISOString(), new Date(Date.now() + 1000).toISOString());
    expect(rows.map((r) => r.full_name)).toEqual(['Lou Example']);
  });

  it('an existing client’s tick counts only with the mobile on their record, as in the database', async () => {
    const info = await demo.getBookingInfo();
    const service = info.services[0];
    const busy = await demo.getBusyTimes(new Date(), new Date(Date.now() + 50 * 86400e3));
    // The first free time on each of two days, so the second booking can't clash with the first.
    const slots: Date[] = [];
    for (let d = 41; slots.length < 2 && d < 55; d++) {
      const first = availableSlots(addDays(todayInZone(info.timezone), d), service.duration_min, info, busy)[0];
      if (first) slots.push(first);
    }
    const book = (phone: string, at: Date) => demo.createBooking({ ...REQUEST, service_id: service.id, starts_at: at.toISOString(),
      full_name: 'Someone Else', email: 'Ruby@Example.com', phone, extras: { marketing_ok: true } });
    const ruby = async () => (await demo.listClients()).find((c) => c.full_name === 'Ruby Clarke')!;
    // Someone else's mobile: not recorded, so she isn't on the list.
    await book('07700 900999', slots[0]);
    expect((await ruby()).marketing_ok_at).toBeNull();
    // Her own, typed another way: recorded.
    await book('+44 7700 900106', slots[1]);
    expect(await ruby()).toMatchObject({ marketing_ok_note: 'Ticked on the booking page' });
    expect((await demo.listShortNoticeClients()).map((c) => c.full_name)).toContain('Ruby Clarke');
  });

  it('a demo saved before this version gets the new fields, and keeps the handles saved in it', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); }, removeItem: (k: string) => saved.delete(k),
    });
    demoApi();
    const [key] = [...saved.keys()];
    const old = JSON.parse(saved.get(key)!);
    delete old.settings.review_link; delete old.settings.wa_template_review;
    old.settings.instagram_handle = 'sam.example.studio'; old.settings.facebook_handle = null;
    for (const c of old.clients) { delete c.marketing_ok_at; delete c.marketing_ok_note; delete c.review_asked_at; }
    for (const a of old.appointments) { delete a.link_source; delete a.heard_from; delete a.heard_from_detail; delete a.first_visit_said; }
    saved.set(key, JSON.stringify(old));

    const upgraded = demoApi();
    await upgraded.signIn('owner@example.com', '');
    const s = await upgraded.getSettings();
    expect([s.instagram_handle, s.facebook_handle, s.review_link, s.wa_template_review]).toEqual(['sam.example.studio', null, null, null]);
    for (const c of await upgraded.listClients()) expect([c.marketing_ok_at, c.marketing_ok_note, c.review_asked_at]).toEqual([null, null, null]);
    for (const a of await upgraded.listAppointments(...wide())) {
      expect([a.link_source, a.heard_from, a.heard_from_detail, a.first_visit_said]).toEqual([null, null, null, null]);
    }
  });
});
