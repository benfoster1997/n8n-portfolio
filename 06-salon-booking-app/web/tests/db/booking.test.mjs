// Database tests: run the real schema against a local PostgreSQL and act as the
// three kinds of caller Supabase has — the public booking page (anon), the
// signed-in owner (authenticated) and the email sender (anon + secret).
//
//   npm run test:db        (needs a local PostgreSQL reachable as the current OS user)
//
// Each run creates a throwaway database and drops it afterwards.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import pg from 'pg';

const here = new URL('.', import.meta.url);
const SHIM = await readFile(new URL('../../../supabase/test/supabase-shim.sql', here), 'utf8');
const SCHEMA = await readFile(new URL('../../../supabase/schema.sql', here), 'utf8');
const DB = `booking_test_${process.pid}`;
const PGHOST = process.env.PGHOST || '/var/run/postgresql';
const PGUSER = process.env.PGUSER || userInfo().username;

let admin; // connection to the maintenance db, to create/drop the test db
let db;    // superuser connection to the test db (setup + inspection)

const OWNER = randomUUID();
const STRANGER = randomUUID();
const SECRET = 'test-secret-' + randomUUID();

before(async () => {
  admin = new pg.Client({ host: PGHOST, user: PGUSER, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  db = new pg.Client({ host: PGHOST, user: PGUSER, database: DB });
  await db.connect();
  await db.query(SHIM);
  await db.query(SCHEMA);
});

after(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${DB}`);
  await admin?.end();
});

// Every test starts from the same known state.
beforeEach(async () => {
  await db.query(`
    truncate public.email_outbox, public.payments, public.client_photos, public.consultation_forms,
             public.appointments, public.patch_tests, public.clients, public.services, public.time_off,
             public.owner restart identity cascade;
    update public.settings set
      business_name = 'Test Studio', timezone = 'Europe/London', slot_interval_min = 15, buffer_min = 10,
      min_notice_hours = 12, max_days_ahead = 60, deposit_amount_pence = 1000, deposit_deadline_hours = 24,
      bank_account_name = 'T Studio', bank_sort_code = '00-00-00', bank_account_number = '12345678',
      owner_email = 'owner@example.com', public_site_url = 'https://book.example.com',
      reminder_hours_before = 24, booking_enabled = true,
      email_secret_hash = '${createHash('sha256').update(SECRET).digest('hex')}'
     where id = 1;
    update public.opening_hours set is_open = true, open_time = '09:00', close_time = '18:00',
                                    break_start = null, break_end = null;
    insert into public.owner (id, user_id) values (1, '${OWNER}');
  `);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function as(role, uid, sql, params = [], extraClaims = {}, headers = null) {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    const claims = JSON.stringify(uid ? { sub: uid, role, ...extraClaims } : { role });
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    if (headers) await db.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)]);
    const r = await db.query(sql, params);
    await db.query('commit');
    return r;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const asAnon = (sql, params) => as('anon', null, sql, params);
const asOwner = (sql, params) => as('authenticated', OWNER, sql, params, { email: 'owner@example.com' });
const asStranger = (sql, params) => as('authenticated', STRANGER, sql, params, { email: 'stranger@example.com' });

/** A London wall-clock time N days from today, as an ISO instant. */
async function londonAt(daysAhead, hhmm) {
  const r = await db.query(
    `select (((now() at time zone 'Europe/London')::date + $1::int) + $2::time) at time zone 'Europe/London' as t`,
    [daysAhead, hhmm]);
  return r.rows[0].t.toISOString();
}

async function addService(name = 'Gel polish', duration = 45, price = 2500) {
  const r = await db.query(
    `insert into public.services (name, duration_min, price_pence) values ($1, $2, $3) returning id`,
    [name, duration, price]);
  return r.rows[0].id;
}

function book(serviceId, startsAt, overrides = {}) {
  const p = {
    p_service_id: serviceId,
    p_starts_at: startsAt,
    p_full_name: 'Jess Example',
    p_email: 'jess@example.com',
    p_phone: '07700 900123',
    p_notes: null,
    p_consultation: null,
    p_health_consent: false,
    p_signed_name: null,
    ...overrides,
  };
  return asAnon(
    `select public.public_create_booking($1, $2, $3, $4, $5, $6, $7, $8, $9) as r`,
    [p.p_service_id, p.p_starts_at, p.p_full_name, p.p_email, p.p_phone, p.p_notes,
     p.p_consultation === null ? null : JSON.stringify(p.p_consultation), p.p_health_consent, p.p_signed_name],
  ).then((r) => r.rows[0].r);
}

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, new RegExp(code));
    return true;
  });
}

const appt = async (reference) =>
  (await db.query(`select * from public.appointments where reference = $1`, [reference])).rows[0];

// ---------------------------------------------------------------------------
// The public key can see nothing directly
// ---------------------------------------------------------------------------

test('the public key cannot read or write any table', async () => {
  for (const t of ['clients', 'appointments', 'settings', 'payments', 'consultation_forms',
                   'patch_tests', 'email_outbox', 'client_photos', 'services', 'owner']) {
    await rejects(asAnon(`select * from public.${t}`), 'permission denied');
  }
  await rejects(asAnon(`insert into public.clients (full_name) values ('x')`), 'permission denied');
});

test('the public key cannot call owner functions', async () => {
  await rejects(asAnon(`select public.owner_cancel_appointment($1)`, [randomUUID()]), 'permission denied');
  await rejects(asAnon(`select public.owner_mark_deposit_paid($1, 'cash')`, [randomUUID()]), 'permission denied');
  await rejects(asAnon(`select public.claim_owner()`), 'permission denied');
});

test('booking info shows services, rules and a contact email, but never bank details or the address', async () => {
  await addService();
  await db.query(`update public.settings set address = '1 Secret Street' where id = 1`);
  const info = (await asAnon(`select public.public_booking_info() as i`)).rows[0].i;
  assert.equal(info.business_name, 'Test Studio');
  assert.equal(info.services.length, 1);
  assert.equal(info.hours.length, 7);
  const text = JSON.stringify(info);
  for (const secret of ['12345678', '00-00-00', 'Secret Street', 'email_secret']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  // The privacy notice must say who to contact, so the business email is public on purpose.
  assert.equal(info.contact_email, 'owner@example.com');
});

test('inactive and owner-only services are not offered online', async () => {
  await addService('Shown');
  await db.query(`insert into public.services (name, duration_min, price_pence, is_active) values ('Old', 30, 100, false)`);
  await db.query(`insert into public.services (name, duration_min, price_pence, online_bookable) values ('Phone only', 30, 100, false)`);
  const info = (await asAnon(`select public.public_booking_info() as i`)).rows[0].i;
  assert.deepEqual(info.services.map((s) => s.name), ['Shown']);
});

// ---------------------------------------------------------------------------
// Booking and deposits
// ---------------------------------------------------------------------------

test('a new client books online: deposit due, two emails queued, nothing revealed', async () => {
  const svc = await addService();
  const at = await londonAt(3, '10:00');
  const r = await book(svc, at);
  assert.deepEqual(Object.keys(r).sort(), ['reference', 'starts_at']);
  assert.match(r.reference, /^[A-HJ-NP-Z2-9]{6}$/);

  const a = await appt(r.reference);
  assert.equal(a.status, 'pending_deposit');
  assert.equal(a.deposit_required_pence, 1000);
  assert.equal(a.is_new_client, true);
  assert.ok(a.deposit_due_at <= new Date(at));
  assert.equal(a.ends_at.toISOString(), new Date(new Date(at).getTime() + 45 * 60e3).toISOString());
  assert.equal(a.busy_until.toISOString(), new Date(new Date(at).getTime() + 55 * 60e3).toISOString());

  const c = (await db.query(`select * from public.clients`)).rows;
  assert.equal(c.length, 1);
  assert.equal(c[0].phone_e164, '447700900123');

  const emails = (await db.query(`select kind, to_email from public.email_outbox order by kind`)).rows;
  assert.deepEqual(emails, [
    { kind: 'booking_received', to_email: 'jess@example.com' },
    { kind: 'owner_new_booking', to_email: 'owner@example.com' },
  ]);
});

test('a returning client (has a completed visit) books without a deposit', async () => {
  const svc = await addService();
  const first = await book(svc, await londonAt(3, '10:00'));
  await db.query(`update public.appointments set status = 'completed' where reference = $1`, [first.reference]);
  const second = await book(svc, await londonAt(4, '10:00'), { p_email: 'JESS@example.com ' });
  const a = await appt(second.reference);
  assert.equal(a.status, 'confirmed');
  assert.equal(a.deposit_required_pence, 0);
  assert.equal(a.is_new_client, false);
  assert.equal((await db.query(`select count(*)::int as n from public.clients`)).rows[0].n, 1);
});

test('a phone number alone never links a booking to an existing client', async () => {
  // Otherwise anyone who knew a regular's mobile could book as them: skip the
  // deposit, learn their name, redirect their reminders, file a fake health form.
  const svc = await addService();
  const victim = (await db.query(
    `insert into public.clients (full_name, phone, allergies) values ('Victoria Regular', '07700 900123', 'HEMA') returning *`)).rows[0];
  await db.query(`insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference, status)
                  values ($1, 'Gel', 45, now() - interval '30 days', now(), now(), '', 'completed')`, [victim.id]);
  const r = await book(svc, await londonAt(4, '10:00'), {
    p_full_name: 'Mallory Evil', p_email: 'mallory@evil.test', p_phone: '+44 (0)7700 900123',
    p_consultation: { allergies: 'no' }, p_health_consent: true, p_signed_name: 'Mallory Evil' });
  const a = await appt(r.reference);
  assert.equal(a.status, 'pending_deposit', 'treated as a new client, so a deposit is due');
  assert.notEqual(a.client_id, victim.id);
  const after = (await db.query(`select * from public.clients where id = $1`, [victim.id])).rows[0];
  assert.equal(after.email, null, 'the regular’s record is untouched');
  assert.equal(after.allergies, 'HEMA');
  assert.equal((await db.query(`select count(*)::int n from public.consultation_forms where client_id = $1`, [victim.id])).rows[0].n, 0);
});

test('booking with a known email never changes that client’s record or files a form on it', async () => {
  const svc = await addService();
  const c = (await db.query(
    `insert into public.clients (full_name, email) values ('Rosa Regular', 'rosa@example.com') returning *`)).rows[0];
  await book(svc, await londonAt(4, '10:00'), {
    p_full_name: 'Someone Else', p_email: 'rosa@example.com', p_phone: '07700900999',
    p_consultation: { allergies: 'no' }, p_health_consent: true, p_signed_name: 'Someone Else' });
  const after = (await db.query(`select * from public.clients where id = $1`, [c.id])).rows[0];
  assert.equal(after.full_name, 'Rosa Regular');
  assert.equal(after.phone, null, 'the typed phone is not written onto her record');
  assert.equal((await db.query(`select count(*)::int n from public.consultation_forms`)).rows[0].n, 0);
  // The emails greet whoever booked, never the name on file.
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.ok(claim.jobs.every((j) => j.first_name === 'Someone'));
});

test('database errors never echo a client row back to the public key', async () => {
  const svc = await addService();
  await db.query(`insert into public.clients (full_name, email, notes) values ('Rosa Regular', 'rosa@example.com', 'PRIVATE NOTE')`);
  await assert.rejects(
    book(svc, await londonAt(4, '10:00'), { p_email: 'rosa@example.com', p_phone: '07700900123 ' + '.'.repeat(40) }),
    (e) => { assert.ok(!JSON.stringify({ m: e.message, d: e.detail }).includes('PRIVATE NOTE')); assert.match(e.message, /invalid_phone/); return true; });
});

test('someone who booked before but never came still pays a deposit', async () => {
  const svc = await addService();
  const first = await book(svc, await londonAt(3, '10:00'));
  await db.query(`update public.appointments set status = 'no_show' where reference = $1`, [first.reference]);
  const second = await book(svc, await londonAt(4, '10:00'));
  assert.equal((await appt(second.reference)).status, 'pending_deposit');
});

test('a deposit of £0 in settings means nobody is asked for one', async () => {
  const svc = await addService();
  await db.query(`update public.settings set deposit_amount_pence = 0 where id = 1`);
  const r = await book(svc, await londonAt(3, '10:00'));
  assert.equal((await appt(r.reference)).status, 'confirmed');
});

// ---------------------------------------------------------------------------
// Double booking and time rules
// ---------------------------------------------------------------------------

test('the same slot cannot be booked twice, including the clean-up buffer', async () => {
  const svc = await addService('Gel', 45);
  await book(svc, await londonAt(3, '10:00'));
  await rejects(book(svc, await londonAt(3, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222' }), 'slot_taken');
  // 10:00 + 45 min + 10 min buffer = 10:55, so 10:45 clashes and 11:00 is free.
  await rejects(book(svc, await londonAt(3, '10:45'), { p_email: 'b@example.com', p_phone: '07700900222' }), 'slot_taken');
  await book(svc, await londonAt(3, '11:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
  // Booking that would run into an existing one also clashes: 09:15 + 45 = 10:00 + 10 buffer.
  await rejects(book(svc, await londonAt(3, '09:15'), { p_email: 'c@example.com', p_phone: '07700900333' }), 'slot_taken');
});

test('time rules: notice, horizon, opening hours, breaks, alignment, time off', async () => {
  const svc = await addService('Gel', 45);
  const other = { p_email: 'z@example.com', p_phone: '07700900999' };

  const inOneHour = new Date(Date.now() + 3600e3);
  inOneHour.setUTCSeconds(0, 0);
  await rejects(book(svc, inOneHour.toISOString(), other), 'too_soon');
  await rejects(book(svc, await londonAt(90, '10:00'), other), 'too_far');
  await rejects(book(svc, await londonAt(3, '08:45'), other), 'outside_hours');
  await rejects(book(svc, await londonAt(3, '17:30'), other), 'outside_hours'); // would end 18:15
  await rejects(book(svc, await londonAt(3, '10:07'), other), 'invalid_time');

  await db.query(`update public.opening_hours set break_start = '13:00', break_end = '14:00'`);
  await rejects(book(svc, await londonAt(3, '12:30'), other), 'outside_hours');
  await rejects(book(svc, await londonAt(3, '13:30'), other), 'outside_hours');

  const dow = (await db.query(
    `select extract(isodow from (now() at time zone 'Europe/London')::date + 5)::int as d`)).rows[0].d;
  await db.query(`update public.opening_hours set is_open = false where weekday = $1`, [dow]);
  await rejects(book(svc, await londonAt(5, '10:00'), other), 'closed');

  await db.query(`insert into public.time_off (starts_at, ends_at, note) values ($1, $2, 'Holiday')`,
    [await londonAt(6, '00:00'), await londonAt(7, '00:00')]);
  await rejects(book(svc, await londonAt(6, '10:00'), other), 'slot_taken');

  await db.query(`update public.settings set booking_enabled = false where id = 1`);
  await rejects(book(svc, await londonAt(3, '10:00'), other), 'booking_disabled');
});

test('input checks reject junk', async () => {
  const svc = await addService();
  const at = await londonAt(3, '10:00');
  await rejects(book(svc, at, { p_full_name: ' ' }), 'invalid_name');
  await rejects(book(svc, at, { p_email: 'not-an-email' }), 'invalid_email');
  await rejects(book(svc, at, { p_phone: '123' }), 'invalid_phone');
  await rejects(book(svc, at, { p_notes: 'x'.repeat(1001) }), 'invalid_notes');
  await rejects(book(randomUUID(), at), 'invalid_service');
});

test('at most three upcoming online bookings per client', async () => {
  const svc = await addService();
  for (const d of [3, 4, 5]) await book(svc, await londonAt(d, '10:00'));
  await rejects(book(svc, await londonAt(6, '10:00')), 'too_many_bookings');
});

test('busy times list ranges only — no names, no services', async () => {
  const svc = await addService();
  await book(svc, await londonAt(3, '10:00'));
  const r = await asAnon(`select * from public.public_busy_times($1, $2)`,
    [await londonAt(0, '00:00'), await londonAt(10, '00:00')]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['ends_at', 'starts_at']);
  await rejects(asAnon(`select * from public.public_busy_times(now(), now() + interval '500 days')`), 'invalid_range');
});

// ---------------------------------------------------------------------------
// Consultation forms
// ---------------------------------------------------------------------------

test('a consultation form needs explicit consent and a typed name', async () => {
  const svc = await addService();
  const form = { allergies: 'no', reactions: 'no' };
  await rejects(book(svc, await londonAt(3, '10:00'), { p_consultation: form }), 'consent_required');
  await rejects(book(svc, await londonAt(3, '10:00'), { p_consultation: form, p_health_consent: true }), 'signature_required');
  const r = await book(svc, await londonAt(3, '10:00'),
    { p_consultation: form, p_health_consent: true, p_signed_name: 'Jess Example' });
  const f = (await db.query(`select * from public.consultation_forms`)).rows;
  assert.equal(f.length, 1);
  assert.equal(f[0].appointment_id, (await appt(r.reference)).id);
});

test('the form link works once, and only for a live appointment', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const { public_token: token } = await appt(r.reference);

  const info = (await asAnon(`select public.public_get_form($1) as f`, [token])).rows[0].f;
  assert.equal(info.first_name, 'Jess');
  assert.equal(info.submitted, false);
  assert.equal((await asAnon(`select public.public_get_form($1) as f`, [randomUUID()])).rows[0].f, null);

  await rejects(asAnon(`select public.public_submit_form($1, '{"a":1}', false, 'Jess')`, [token]), 'consent_required');
  await asAnon(`select public.public_submit_form($1, '{"a":1}', true, 'Jess Example')`, [token]);
  await rejects(asAnon(`select public.public_submit_form($1, '{"a":1}', true, 'Jess Example')`, [token]), 'already_submitted');
  assert.equal((await asAnon(`select public.public_get_form($1) as f`, [token])).rows[0].f.submitted, true);
});

// ---------------------------------------------------------------------------
// The owner, and only the owner
// ---------------------------------------------------------------------------

test('only the first account becomes the owner; anyone else sees nothing', async () => {
  await db.query(`truncate public.owner`);
  // settings.owner_email is set, so a stranger can't claim the diary first…
  assert.equal((await asStranger(`select public.claim_owner() as ok`)).rows[0].ok, false);
  // …nor can an anonymous session with the right email.
  assert.equal((await as('authenticated', STRANGER, `select public.claim_owner() as ok`, [],
    { email: 'owner@example.com', is_anonymous: true })).rows[0].ok, false);
  assert.equal((await asOwner(`select public.claim_owner() as ok`)).rows[0].ok, true);
  assert.equal((await asStranger(`select public.claim_owner() as ok`)).rows[0].ok, false);
  assert.equal((await asAnon(`select public.public_owner_exists() as e`)).rows[0].e, true);

  const svc = await addService();
  await book(svc, await londonAt(3, '10:00'));
  assert.equal((await asOwner(`select * from public.clients`)).rows.length, 1);
  assert.equal((await asStranger(`select * from public.clients`)).rows.length, 0);
  await rejects(asStranger(`insert into public.clients (full_name) values ('x')`), 'row-level security');
  const id = (await db.query(`select id from public.appointments`)).rows[0].id;
  await rejects(asStranger(`select public.owner_cancel_appointment($1)`, [id]), 'not_allowed');
  await rejects(asOwner(`update public.owner set user_id = $1`, [STRANGER]), 'permission denied');
});

test('marking a deposit paid confirms the booking, records the money and emails the client', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  const updated = (await asOwner(`select * from public.owner_mark_deposit_paid($1, 'bank_transfer')`, [a.id])).rows[0];
  assert.equal(updated.status, 'confirmed');
  assert.ok(updated.deposit_paid_at);
  const p = (await db.query(`select kind, method, amount_pence, client_name from public.payments`)).rows;
  assert.deepEqual(p, [{ kind: 'deposit', method: 'bank_transfer', amount_pence: 1000, client_name: 'Jess Example' }]);
  const e = (await db.query(`select kind from public.email_outbox where kind = 'deposit_received'`)).rows;
  assert.equal(e.length, 1);
  await rejects(asOwner(`select public.owner_mark_deposit_paid($1, 'bank_transfer')`, [a.id]), 'not_pending_deposit');
  await rejects(asOwner(`select public.owner_mark_deposit_paid($1, 'card')`, [a.id]), 'invalid_method');
});

test('completing an appointment records balance and tip; she is then a returning client', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  await asOwner(`select public.owner_mark_deposit_paid($1, 'bank_transfer')`, [a.id]);
  await asOwner(`select public.owner_complete_appointment($1, 1500, 'cash', 300, null)`, [a.id]);
  const p = (await db.query(`select kind, method, amount_pence from public.payments order by kind`)).rows;
  assert.deepEqual(p, [
    { kind: 'deposit', method: 'bank_transfer', amount_pence: 1000 },
    { kind: 'payment', method: 'cash', amount_pence: 1500 },
    { kind: 'tip', method: 'cash', amount_pence: 300 },
  ]);
  assert.equal((await appt(r.reference)).status, 'completed');
  const next = await book(svc, await londonAt(4, '10:00'));
  assert.equal((await appt(next.reference)).status, 'confirmed');
});

test('cancelling frees the slot, drops pending emails and notifies the client', async () => {
  const svc = await addService();
  const at = await londonAt(3, '10:00');
  const r = await book(svc, at);
  const a = await appt(r.reference);
  await asOwner(`select public.owner_cancel_appointment($1, 'Ill', true)`, [a.id]);
  assert.equal((await appt(r.reference)).status, 'cancelled');
  const e = (await db.query(`select kind, status from public.email_outbox order by kind`)).rows;
  assert.deepEqual(e, [
    { kind: 'booking_received', status: 'skipped' },
    { kind: 'cancelled', status: 'pending' },
    { kind: 'owner_new_booking', status: 'skipped' },
  ]);
  await book(svc, at, { p_email: 'b@example.com', p_phone: '07700900222' });
});

test('the owner can add appointments directly; the database still blocks overlaps', async () => {
  const at = await londonAt(3, '10:00');
  const c = (await asOwner(`insert into public.clients (full_name, phone) values ('Walk In', '07700 900555') returning *`)).rows[0];
  assert.equal(c.phone_e164, '447700900555');
  const a = (await asOwner(
    `insert into public.appointments (client_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until, reference)
     values ($1, 'Removal', 1000, 30, $2, $2, $2, '') returning *`, [c.id, at])).rows[0];
  assert.match(a.reference, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(a.ends_at.getTime() - a.starts_at.getTime(), 30 * 60e3);
  await rejects(asOwner(
    `insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference)
     values ($1, 'Clash', 30, $2, $2, $2, '')`, [c.id, at]), 'appointments_no_overlap');
});

// ---------------------------------------------------------------------------
// Email sender
// ---------------------------------------------------------------------------

test('the email sender needs the secret', async () => {
  await rejects(asAnon(`select public.email_jobs_claim('wrong')`), 'unauthorized');
  await rejects(asAnon(`select public.email_jobs_claim('')`), 'unauthorized');
  await rejects(asAnon(`select public.email_jobs_report('wrong', '[]')`), 'unauthorized');
  await db.query(`update public.settings set email_secret_hash = null where id = 1`);
  await rejects(asAnon(`select public.email_jobs_claim($1)`, [SECRET]), 'unauthorized');
});

test('claim hands over each email once; report marks sent or retries', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(claim.jobs.length, 2);
  assert.equal(claim.settings.bank_account_number, '12345678');
  const job = claim.jobs.find((j) => j.kind === 'booking_received');
  assert.equal(job.reference, r.reference);
  assert.equal(job.status, 'pending_deposit');
  assert.equal(job.form_needed, true);
  assert.match(job.form_url, /^https:\/\/book\.example\.com\/form\/[0-9a-f-]{36}$/);

  const again = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(again.jobs.length, 0, 'claimed emails are not handed out twice');

  const owner = claim.jobs.find((j) => j.kind === 'owner_new_booking');
  const n = (await asAnon(`select public.email_jobs_report($1, $2) as n`,
    [SECRET, JSON.stringify([{ id: job.id, ok: true }, { id: owner.id, ok: false, error: 'quota' }])])).rows[0].n;
  assert.equal(n, 2);
  const rows = (await db.query(`select kind, status, last_error from public.email_outbox order by kind`)).rows;
  assert.deepEqual(rows, [
    { kind: 'booking_received', status: 'sent', last_error: null },
    { kind: 'owner_new_booking', status: 'pending', last_error: 'quota' },
  ]);
  const retry = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.deepEqual(retry.jobs.map((j) => j.kind), ['owner_new_booking']);
  assert.ok((await db.query(`select email_last_poll_at from public.settings`)).rows[0].email_last_poll_at);
});

test('reminders are queued once, inside the window, for confirmed bookings made in advance', async () => {
  const svc = await addService();
  // Tomorrow-ish: 20 hours from now, rounded to a slot, booked "a week ago".
  const t = new Date(Date.now() + 20 * 3600e3);
  t.setUTCMinutes(0, 0, 0);
  const c = (await db.query(`insert into public.clients (full_name, email) values ('Rem', 'rem@example.com') returning id`)).rows[0];
  const a = (await db.query(
    `insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference, status, created_at)
     values ($1, 'Gel', 45, $2, $2, $2, '', 'confirmed', now() - interval '7 days') returning *`, [c.id, t])).rows[0];
  // A pending-deposit booking in the same window gets no reminder.
  await db.query(
    `insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference, status, created_at)
     values ($1, 'Gel', 45, $2, $2, $2, '', 'pending_deposit', now() - interval '7 days')`,
    [c.id, new Date(t.getTime() + 2 * 3600e3)]);

  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  const reminders = claim.jobs.filter((j) => j.kind === 'reminder');
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].to, 'rem@example.com');
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify([{ id: reminders[0].id, ok: true }])]);
  assert.ok((await db.query(`select reminder_email_sent_at from public.appointments where id = $1`, [a.id])).rows[0].reminder_email_sent_at);

  const again = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(again.jobs.filter((j) => j.kind === 'reminder').length, 0);
});

test('a booking made inside the reminder window gets no separate reminder', async () => {
  const svc = await addService();
  await db.query(`update public.settings set min_notice_hours = 0 where id = 1`);
  const t = new Date(Date.now() + 20 * 3600e3);
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(t));
  if (londonHour < 9 || londonHour > 16) return; // outside test opening hours today; covered by the test above
  t.setUTCMinutes(0, 0, 0);
  const r = await book(svc, t.toISOString());
  await db.query(`update public.appointments set status = 'confirmed' where reference = $1`, [r.reference]);
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(claim.jobs.filter((j) => j.kind === 'reminder').length, 0);
});

test('the owner can re-send a confirmation', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(claim.jobs.map((j) => ({ id: j.id, ok: true })))]);
  await asOwner(`select public.owner_queue_email($1, 'booking_received')`, [a.id]);
  const row = (await db.query(`select status, attempts from public.email_outbox where kind = 'booking_received'`)).rows[0];
  assert.deepEqual(row, { status: 'pending', attempts: 0 });
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

test('UK phone numbers normalise to one format', async () => {
  const cases = {
    '07700 900123': '447700900123',
    '+44 7700 900123': '447700900123',
    '+44 (0)7700 900123': '447700900123',
    '0044 7700 900123': '447700900123',
    '7700900123': '447700900123',
    '+353 85 123 4567': '353851234567',
  };
  for (const [input, want] of Object.entries(cases)) {
    const r = await db.query(`select public.normalize_uk_phone($1) as p`, [input]);
    assert.equal(r.rows[0].p, want, input);
  }
});

test('booking references are short, unambiguous and unique', async () => {
  const r = await db.query(`select public.gen_reference() as r from generate_series(1, 2000)`);
  const refs = r.rows.map((x) => x.r);
  for (const ref of refs) assert.match(ref, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(new Set(refs).size > 1990);
});

// ---------------------------------------------------------------------------
// Hardening found in review
// ---------------------------------------------------------------------------

test('flood brake: a handful of online bookings an hour, three per connection', async () => {
  const svc = await addService('Gel', 30);
  const who = (i) => ({ p_full_name: `Client ${'abcdefg'[i]}`, p_email: `c${i}@example.com`, p_phone: `0770090010${i}` });
  // Per connection (the API gateway passes the caller's address in x-forwarded-for).
  const fromIp = (i, ip) => as('anon', null,
    `select public.public_create_booking($1, $2, $3, $4, $5) as r`,
    [svc, null, who(i).p_full_name, who(i).p_email, who(i).p_phone], {}, { 'x-forwarded-for': `${ip}, 10.0.0.1` });
  for (let i = 0; i < 3; i++) {
    const at = await londonAt(3, `${10 + i}:00`);
    await as('anon', null, `select public.public_create_booking($1, $2, $3, $4, $5) as r`,
      [svc, at, who(i).p_full_name, who(i).p_email, who(i).p_phone], {}, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
  }
  await rejects(fromIp(3, '203.0.113.9'), 'busy_try_later');
  void fromIp;
  // Overall: six in an hour from anywhere.
  for (let i = 3; i < 6; i++) await book(svc, await londonAt(3, `${10 + i}:00`), who(i));
  await rejects(book(svc, await londonAt(4, '10:00'), { p_full_name: 'Late Comer', p_email: 'late@example.com', p_phone: '07700900200' }), 'busy_try_later');
});

test('names must look like names: no links, emails or markup', async () => {
  const svc = await addService();
  const at = await londonAt(3, '10:00');
  for (const bad of ['Win £££ at spam.com', 'Visit www.evil.test', 'https://x.test', 'Jess <b>Bold</b>', 'Agent 47', 'a@b.c']) {
    await rejects(book(svc, at, { p_full_name: bad }), 'invalid_name');
  }
  let n = 0;
  for (const good of ["Siobhán O'Brien", 'Anne-Marie Smith-Jones', 'J. Smith']) {
    await book(svc, await londonAt(3 + n, '14:00'), { p_full_name: good, p_email: `ok${n}@example.com`, p_phone: `0770090030${n}` });
    n++;
  }
});

test('raising the clean-up gap later does not break updates to existing appointments', async () => {
  const svc = await addService('Gel', 45);
  await db.query(`update public.settings set slot_interval_min = 5 where id = 1`);
  const a1 = await book(svc, await londonAt(3, '10:00'));
  const a2 = await book(svc, await londonAt(3, '10:55'), { p_email: 'b@example.com', p_phone: '07700900222' });
  await db.query(`update public.settings set buffer_min = 30 where id = 1`);
  const second = await appt(a2.reference);
  await asOwner(`update public.appointments set whatsapp_reminder_sent_at = now(), owner_notes = 'x' where id = $1`, [second.id]);
  await asOwner(`select public.owner_mark_deposit_paid($1, 'cash')`, [(await appt(a1.reference)).id]);
  assert.equal((await appt(a1.reference)).status, 'confirmed');
});

test('moving an appointment resets its reminders so the new time gets one', async () => {
  const c = (await db.query(`insert into public.clients (full_name, email) values ('Rem Ind', 'rem@example.com') returning id`)).rows[0];
  const soon = new Date(Date.now() + 20 * 3600e3); soon.setUTCMinutes(0, 0, 0);
  const a = (await db.query(
    `insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference, status, created_at)
     values ($1, 'Gel', 45, $2, $2, $2, '', 'confirmed', now() - interval '7 days') returning *`, [c.id, soon])).rows[0];
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(claim.jobs.map((j) => ({ id: j.id, ok: true })))]);
  await db.query(`update public.appointments set whatsapp_reminder_sent_at = now() where id = $1`, [a.id]);

  const later = new Date(soon.getTime() + 2 * 3600e3);
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, later]);
  const moved = (await db.query(`select * from public.appointments where id = $1`, [a.id])).rows[0];
  assert.equal(moved.reminder_email_sent_at, null);
  assert.equal(moved.whatsapp_reminder_sent_at, null);
  const again = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(again.jobs.filter((j) => j.kind === 'reminder').length, 1);
});

test('a regular moved over from another system is never asked for a deposit', async () => {
  const svc = await addService();
  await db.query(`insert into public.clients (full_name, email, is_regular) values ('Old Regular', 'jess@example.com', true)`);
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  assert.equal(a.status, 'confirmed');
  assert.equal(a.is_new_client, false);
});

test('health consent is recorded with the form, and can be withdrawn on its own', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  await asAnon(`select public.public_submit_form($1, '{"allergies":"no"}', true, 'Jess Example')`, [a.public_token]);
  const form = (await db.query(`select consent_version from public.consultation_forms`)).rows[0];
  assert.equal(form.consent_version, 'v2-2026-10', 'the database stamps the consent wording, not the browser');
  let c = (await db.query(`select * from public.clients where id = $1`, [a.client_id])).rows[0];
  assert.ok(c.health_consent_at);
  await db.query(`update public.clients set allergies = 'HEMA' where id = $1`, [c.id]);
  await db.query(`insert into public.patch_tests (client_id, tested_on) values ($1, current_date)`, [c.id]);

  await rejects(asStranger(`select public.owner_delete_health_data($1)`, [c.id]), 'not_allowed');
  await asOwner(`select public.owner_delete_health_data($1)`, [c.id]);
  c = (await db.query(`select * from public.clients where id = $1`, [c.id])).rows[0];
  assert.equal(c.allergies, null);
  assert.equal(c.health_consent_at, null);
  assert.equal(c.full_name, 'Jess Example', 'still a client');
  for (const t of ['consultation_forms', 'patch_tests']) {
    assert.equal((await db.query(`select count(*)::int n from public.${t}`)).rows[0].n, 0, t);
  }
  assert.equal((await appt(r.reference)).status, 'pending_deposit', 'the booking is untouched');
});

test('one consultation form per appointment, even if two arrive at once', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  await db.query(`insert into public.consultation_forms (client_id, appointment_id, answers, health_consent, signed_name)
                  values ($1, $2, '{}', true, 'Jess')`, [a.client_id, a.id]);
  await assert.rejects(db.query(`insert into public.consultation_forms (client_id, appointment_id, answers, health_consent, signed_name)
                  values ($1, $2, '{}', true, 'Jess')`, [a.client_id, a.id]), /consultation_forms_one_per_appt/);
});

test('optional: unpaid online bookings are released after the deadline', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  await db.query(`update public.appointments set deposit_due_at = now() - interval '1 minute' where reference = $1`, [r.reference]);
  await asAnon(`select public.email_jobs_claim($1)`, [SECRET]);
  assert.equal((await appt(r.reference)).status, 'pending_deposit', 'off by default: the owner decides');
  await db.query(`update public.settings set auto_cancel_unpaid = true where id = 1`);
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal((await appt(r.reference)).status, 'cancelled');
  assert.deepEqual(claim.jobs.map((j) => j.kind), ['cancelled']);
  assert.match(claim.jobs[0].cancel_reason, /deposit didn't arrive/);
});

test('the sender takes no more than it can send today', async () => {
  const svc = await addService();
  await book(svc, await londonAt(3, '10:00'));
  const one = (await asAnon(`select public.email_jobs_claim($1, 1) as j`, [SECRET])).rows[0].j;
  assert.equal(one.jobs.length, 1);
  const none = (await asAnon(`select public.email_jobs_claim($1, 0) as j`, [SECRET])).rows[0].j;
  assert.equal(none.jobs.length, 0);
});

test('stuck emails are marked failed, and a re-send never resets one going out', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  await db.query(`update public.email_outbox set status = 'sending', attempts = 5, claimed_at = now() - interval '1 hour'`);
  await asAnon(`select public.email_jobs_claim($1)`, [SECRET]);
  assert.deepEqual((await db.query(`select distinct status from public.email_outbox`)).rows, [{ status: 'failed' }]);

  await db.query(`update public.email_outbox set status = 'sending', attempts = 1, claimed_at = now() where kind = 'booking_received'`);
  await asOwner(`select public.owner_queue_email($1, 'booking_received')`, [a.id]);
  assert.equal((await db.query(`select status from public.email_outbox where kind = 'booking_received'`)).rows[0].status, 'sending');
});

test('the public can only see busy times from now on; the owner can look back', async () => {
  await rejects(asAnon(`select * from public.public_busy_times(now() - interval '30 days', now())`), 'invalid_range');
  const r = await asOwner(`select * from public.public_busy_times(now() - interval '30 days', now())`);
  assert.equal(r.rows.length, 0);
});

test('signed-in strangers cannot call the email sender functions either', async () => {
  await rejects(asStranger(`select public.email_jobs_claim($1)`, [SECRET]), 'permission denied');
  await rejects(asStranger(`select public.email_secret_ok($1)`, [SECRET]), 'permission denied');
});

test('the booking page can ask for busy times across a long booking horizon, even over a clock change', async () => {
  const r = await asAnon(`select * from public.public_busy_times(now(), now() + interval '366 days 1 hour')`);
  assert.equal(r.rows.length, 0);
  await rejects(asAnon(`select * from public.public_busy_times(now(), now() + interval '500 days')`), 'invalid_range');
});

test('time off keeps the clean-up gap in front of it, matching the booking page', async () => {
  const svc = await addService('Gel', 60);
  await db.query(`insert into public.time_off (starts_at, ends_at) values ($1, $2)`, [await londonAt(3, '14:00'), await londonAt(3, '18:00')]);
  await rejects(book(svc, await londonAt(3, '13:00')), 'slot_taken');           // 13:00–14:00 + 10 min gap
  await book(svc, await londonAt(3, '12:45'), { p_email: 'b@example.com', p_phone: '07700900222' }); // ends 13:45 + 10 = 13:55
});

test('moving an appointment earlier brings the deposit deadline with it', async () => {
  const svc = await addService();
  await db.query(`update public.settings set deposit_deadline_hours = 200 where id = 1`);
  const r = await book(svc, await londonAt(10, '10:00'));
  const a = await appt(r.reference);
  const earlier = await londonAt(2, '10:00');
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, earlier]);
  const moved = await appt(r.reference);
  assert.ok(moved.deposit_due_at <= moved.starts_at);
});

test('email addresses that could smuggle extra fields into a mail link are refused', async () => {
  const svc = await addService();
  await rejects(book(svc, await londonAt(3, '10:00'), { p_email: 'a@b.com?cc=x%40evil.com' }), 'invalid_email');
});
