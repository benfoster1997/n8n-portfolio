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
             public.client_changes, public.appointments, public.patch_tests, public.clients, public.services,
             public.time_off, public.owner restart identity cascade;
    update public.settings set
      business_name = 'Test Studio', timezone = 'Europe/London', slot_interval_min = 15, buffer_min = 10,
      min_notice_hours = 12, max_days_ahead = 60, deposit_amount_pence = 1000, deposit_deadline_hours = 24,
      bank_account_name = 'T Studio', bank_sort_code = '00-00-00', bank_account_number = '12345678',
      owner_email = 'owner@example.com', public_site_url = 'https://book.example.com',
      reminder_hours_before = 24, booking_enabled = true, auto_cancel_unpaid = false,
      cancel_notice_hours = 48, client_self_service = true,
      cancellation_policy = '48 hours notice or the full price is payable',
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
    p_policy_accepted: true,
    ...overrides,
  };
  return asAnon(
    `select public.public_create_booking($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as r`,
    [p.p_service_id, p.p_starts_at, p.p_full_name, p.p_email, p.p_phone, p.p_notes,
     p.p_consultation === null ? null : JSON.stringify(p.p_consultation), p.p_health_consent, p.p_signed_name,
     p.p_policy_accepted],
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
  await rejects(asAnon(`select public.owner_reset_link($1)`, [randomUUID()]), 'permission denied');
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
    `select public.public_create_booking($1, $2, $3, $4, $5, p_policy_accepted => true) as r`,
    [svc, null, who(i).p_full_name, who(i).p_email, who(i).p_phone], {}, { 'x-forwarded-for': `${ip}, 10.0.0.1` });
  for (let i = 0; i < 3; i++) {
    const at = await londonAt(3, `${10 + i}:00`);
    await as('anon', null, `select public.public_create_booking($1, $2, $3, $4, $5, p_policy_accepted => true) as r`,
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

  const row = async () => (await db.query(`select status, attempts, resend from public.email_outbox where kind = 'booking_received'`)).rows[0];
  const { id } = (await db.query(`update public.email_outbox set status = 'sending', attempts = 1, claimed_at = now()
                                   where kind = 'booking_received' returning id`)).rows[0];
  await asOwner(`select public.owner_queue_email($1, 'booking_received')`, [a.id]);
  // Left going out, but marked to go once more (it has the details from before the re-send).
  assert.deepEqual(await row(), { status: 'sending', attempts: 1, resend: true });
  // A failed send is simply retried, and the retry carries the latest details anyway.
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify([{ id, ok: false, error: 'quota' }])]);
  assert.deepEqual(await row(), { status: 'pending', attempts: 1, resend: false });
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

test('clients must agree to the cancellation policy, and the wording they agreed to is kept', async () => {
  const svc = await addService();
  await rejects(book(svc, await londonAt(3, '10:00'), { p_policy_accepted: false }), 'policy_required');
  const r = await book(svc, await londonAt(3, '10:00'));
  assert.equal((await appt(r.reference)).cancellation_policy_agreed, '48 hours notice or the full price is payable');
  // Changing the policy later doesn't rewrite what earlier clients agreed to.
  await db.query(`update public.settings set cancellation_policy = 'New policy' where id = 1`);
  assert.equal((await appt(r.reference)).cancellation_policy_agreed, '48 hours notice or the full price is payable');
  // With no policy set, there's nothing to agree to.
  await db.query(`update public.settings set cancellation_policy = null where id = 1`);
  const r2 = await book(svc, await londonAt(4, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222', p_policy_accepted: false });
  assert.equal((await appt(r2.reference)).cancellation_policy_agreed, null);
});

test('the booking page shows the cancellation policy to everyone', async () => {
  const info = (await asAnon(`select public.public_booking_info() as i`)).rows[0].i;
  assert.equal(info.cancellation_policy, '48 hours notice or the full price is payable');
});

test('a fresh install starts with the 48-hour, full-price cancellation policy', async () => {
  const fresh = `booking_fresh_${process.pid}`;
  await admin.query(`drop database if exists ${fresh}`);
  await admin.query(`create database ${fresh}`);
  const c = new pg.Client({ host: PGHOST, user: PGUSER, database: fresh });
  await c.connect();
  try {
    await c.query(SHIM);
    await c.query(SCHEMA);
    const p = (await c.query(`select cancellation_policy from public.settings`)).rows[0].cancellation_policy;
    assert.match(p, /at least 48 hours’ notice/);
    assert.match(p, /full price of your treatment is payable/);
  } finally {
    await c.end();
    await admin.query(`drop database if exists ${fresh}`);
  }
});

test('a fresh install reminds 72 hours ahead, and the schema can be run again over it', async () => {
  // The column default itself (beforeEach sets 24 on the shared row).
  const d = (await db.query(`select column_default from information_schema.columns
                              where table_schema = 'public' and table_name = 'settings' and column_name = 'reminder_hours_before'`)).rows[0];
  assert.equal(d.column_default, '72');

  const fresh = `booking_rerun_${process.pid}`;
  await admin.query(`drop database if exists ${fresh}`);
  await admin.query(`create database ${fresh}`);
  const c = new pg.Client({ host: PGHOST, user: PGUSER, database: fresh });
  await c.connect();
  try {
    await c.query(SHIM);
    await c.query(SCHEMA);
    const s = (await c.query(`select reminder_hours_before, cancel_notice_hours, client_self_service from public.settings`)).rows[0];
    assert.deepEqual(s, { reminder_hours_before: 72, cancel_notice_hours: 48, client_self_service: true });
    await c.query(`update public.settings set reminder_hours_before = 48 where id = 1`);
    // Running it a second time is clean, keeps her settings and keeps the locks on.
    await c.query(SCHEMA);
    assert.equal((await c.query(`select reminder_hours_before from public.settings`)).rows[0].reminder_hours_before, 48);
    const p = (await c.query(`select
        has_function_privilege('anon', 'public.public_change_booking(uuid, uuid, timestamptz)', 'execute') as change,
        has_function_privilege('anon', 'public.public_get_booking(uuid)', 'execute') as get,
        has_function_privilege('anon', 'public.queue_email(uuid, text, text, boolean)', 'execute') as queue,
        has_function_privilege('authenticated', 'public.queue_email(uuid, text, text, boolean)', 'execute') as queue_auth,
        has_function_privilege('anon', 'public.owner_reset_link(uuid)', 'execute') as reset_anon,
        has_function_privilege('authenticated', 'public.owner_reset_link(uuid)', 'execute') as reset_auth,
        has_table_privilege('anon', 'public.client_changes', 'select') as changes_anon,
        (select relrowsecurity from pg_class where oid = 'public.client_changes'::regclass) as rls`)).rows[0];
    assert.deepEqual(p, { change: true, get: true, queue: false, queue_auth: false, reset_anon: false, reset_auth: true,
                          changes_anon: false, rls: true });
  } finally {
    await c.end();
    await admin.query(`drop database if exists ${fresh}`);
  }
});

// ---------------------------------------------------------------------------
// A client managing their own booking (/manage/<token>)
// ---------------------------------------------------------------------------

const getBooking = async (token) => (await asAnon(`select public.public_get_booking($1) as m`, [token])).rows[0].m;
const changeBooking = async (token, serviceId, startsAt) =>
  (await asAnon(`select public.public_change_booking($1, $2, $3) as r`, [token, serviceId, startsAt])).rows[0].r;
const cancelBooking = async (token, reason = null) =>
  (await asAnon(`select public.public_cancel_booking($1, $2) as r`, [token, reason])).rows[0].r;
const claimJobs = async () => (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
const reportSent = (jobs) =>
  asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(jobs.map((j) => ({ id: j.id, ok: true })))]);
/** Claim everything waiting and report it sent, as the email script would. */
async function sendAll() { const c = await claimJobs(); await reportSent(c.jobs); return c; }
const outbox = async () => (await db.query(`select kind, status, to_email from public.email_outbox order by kind`)).rows;
const changesOf = async (apptId) =>
  (await db.query(`select * from public.client_changes where appointment_id = $1 order by id`, [apptId])).rows;
const iso = (t) => new Date(t).toISOString();

/** An appointment put straight into the diary, as the owner's app can: any time, any status. */
async function diaryAppt(startsAt, { email = 'dana@example.com', status = 'confirmed', createdAt = null, serviceId = null,
                                     serviceName = 'Gel polish', duration = 45, price = 2500 } = {}) {
  let c = email && (await db.query(`select id from public.clients where email = $1`, [email])).rows[0];
  if (!c) {
    c = (await db.query(`insert into public.clients (full_name, email, phone) values ('Dana Example', $1, '07700 900456') returning id`,
      [email])).rows[0];
  }
  return (await db.query(
    `insert into public.appointments (client_id, service_id, service_name, price_pence, duration_min, starts_at, ends_at,
                                      busy_until, reference, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $6, $6, '', $7, coalesce($8::timestamptz, now())) returning *`,
    [c.id, serviceId, serviceName, price, duration, startsAt, status, createdAt])).rows[0];
}
const weekAgo = () => new Date(Date.now() - 7 * 86400e3);

// Tomorrow at 14:00 is always 14–38 hours away: inside the 48-hour notice
// period, but past the 12-hour minimum notice for a new time.
const insideNotice = () => londonAt(1, '14:00');

test('the manage link shows that one booking, and only what the page needs', async () => {
  const svc = await addService('Gel polish', 45, 2500);
  await db.query(`update public.settings set owner_phone = '07700 900000', address = '1 Secret Street' where id = 1`);
  const r = await book(svc, await londonAt(4, '10:00'), { p_notes: 'PRIVATE NOTE' });
  const other = await book(svc, await londonAt(5, '10:00'),
    { p_full_name: 'Olive Other', p_email: 'olive@example.com', p_phone: '07700900777' });
  const a = await appt(r.reference);

  const m = await getBooking(a.public_token);
  assert.deepEqual(Object.keys(m).sort(), ['bank', 'booking', 'cancel_notice_hours', 'client_self_service', 'contact_phone', 'info']);
  assert.deepEqual(Object.keys(m.booking).sort(), [
    'cancelled_at', 'cancelled_by', 'cancelled_late', 'changes_left', 'deposit_due_at', 'deposit_paid',
    'deposit_required_pence', 'duration_min', 'ends_at', 'first_name', 'form_needed', 'free_until', 'has_email',
    'late_fee_pence', 'price_pence',
    'reference', 'service_id', 'service_name', 'starts_at', 'status']);
  assert.equal(m.booking.reference, r.reference);
  assert.equal(m.booking.first_name, 'Jess');
  assert.equal(m.booking.service_id, svc);
  assert.equal(m.booking.status, 'pending_deposit');
  assert.equal(m.booking.deposit_paid, false);
  assert.equal(m.booking.form_needed, true);
  assert.equal(m.booking.changes_left, 6);
  assert.equal(new Date(m.booking.free_until).getTime(), a.starts_at.getTime() - 48 * 3600e3);
  assert.deepEqual([m.contact_phone, m.cancel_notice_hours, m.client_self_service], ['07700 900000', 48, true]);
  assert.equal(m.info.business_name, 'Test Studio');
  // The bank details, because a deposit is owed.
  assert.deepEqual(m.bank, { account_name: 'T Studio', sort_code: '00-00-00', account_number: '12345678' });

  // Nobody else's booking, and nothing private: not even her own contact details or the link itself.
  const text = JSON.stringify(m);
  for (const secret of ['Olive', 'olive@example.com', other.reference, 'jess@example.com', '900123', 'PRIVATE NOTE',
                        'Secret Street', a.public_token, 'email_secret']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }

  // Once the deposit is in, the bank details go.
  await asOwner(`select public.owner_mark_deposit_paid($1, 'bank_transfer')`, [a.id]);
  const paid = await getBooking(a.public_token);
  assert.equal(paid.bank, null);
  assert.deepEqual([paid.booking.status, paid.booking.deposit_paid], ['confirmed', true]);
});

test('the manage link: unknown, more than a day old, and no notice period', async () => {
  assert.equal(await getBooking(randomUUID()), null);
  const old = await diaryAppt(new Date(Date.now() - 25 * 3600e3), { status: 'completed' });
  assert.equal(await getBooking(old.public_token), null, 'more than a day old');
  const recent = await diaryAppt(new Date(Date.now() - 22 * 3600e3), { status: 'completed' });
  assert.equal((await getBooking(recent.public_token)).booking.status, 'completed');
  await db.query(`update public.settings set cancel_notice_hours = 0 where id = 1`);
  const m = await getBooking(recent.public_token);
  assert.equal(m.booking.free_until, null);
  assert.equal(m.cancel_notice_hours, 0);
});

test('busy times for picking a new time leave out only the client’s own booking', async () => {
  const svc = await addService();
  const mine = await book(svc, await londonAt(3, '10:00'));
  const theirs = await book(svc, await londonAt(3, '14:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
  await db.query(`insert into public.time_off (starts_at, ends_at) values ($1, $2)`, [await londonAt(3, '16:00'), await londonAt(3, '17:00')]);
  const range = [await londonAt(0, '00:00'), await londonAt(10, '00:00')];
  const token = (await appt(mine.reference)).public_token;

  const all = (await asAnon(`select * from public.public_busy_times($1, $2)`, range)).rows;
  const except = (await asAnon(`select * from public.public_busy_times_except($1, $2, $3)`, [token, ...range])).rows;
  assert.equal(all.length, 3);
  assert.deepEqual(except.map((b) => b.starts_at.toISOString()), [iso((await appt(theirs.reference)).starts_at), iso(await londonAt(3, '16:00'))]);
  assert.deepEqual(Object.keys(except[0]).sort(), ['ends_at', 'starts_at']);

  await rejects(asAnon(`select * from public.public_busy_times_except($1, $2, $3)`, [randomUUID(), ...range]), 'not_found');
  await rejects(asAnon(`select * from public.public_busy_times_except($1, now(), now() - interval '1 hour')`, [token]), 'invalid_range');
  await rejects(asAnon(`select * from public.public_busy_times_except($1, now(), now() + interval '500 days')`, [token]), 'invalid_range');
  await rejects(asAnon(`select * from public.public_busy_times_except($1, now() - interval '30 days', now())`, [token]), 'invalid_range');
});

test('a client can move their booking, switch treatment, or both', async () => {
  const gel = await addService('Gel polish', 45, 2500);
  const biab = await addService('BIAB infill', 75, 3500);
  const r = await book(gel, await londonAt(4, '10:00'));
  const { public_token: token, id } = await appt(r.reference);
  await db.query(`update public.services set price_pence = 2800 where id = $1`, [gel]); // a price rise since she booked

  // Move only: keeping the treatment keeps the price she booked at.
  const res = await changeBooking(token, null, await londonAt(5, '11:00'));
  assert.deepEqual(Object.keys(res).sort(), ['late', 'price_pence', 'reference', 'service_name', 'starts_at']);
  assert.deepEqual([res.reference, res.service_name, res.price_pence, res.late], [r.reference, 'Gel polish', 2500, false]);
  let a = await appt(r.reference);
  assert.equal(iso(a.starts_at), iso(await londonAt(5, '11:00')));
  assert.equal(a.price_pence, 2500);
  assert.equal(a.ends_at - a.starts_at, 45 * 60e3);
  assert.equal(a.busy_until - a.ends_at, 10 * 60e3);
  // Picking the same treatment again still counts as keeping it.
  await changeBooking(token, gel, await londonAt(5, '12:00'));
  assert.equal((await appt(r.reference)).price_pence, 2500);

  // Switch only: the new treatment's name, price and length, same time.
  assert.equal((await changeBooking(token, biab, null)).service_name, 'BIAB infill');
  a = await appt(r.reference);
  assert.deepEqual([a.service_id, a.service_name, a.price_pence, a.duration_min], [biab, 'BIAB infill', 3500, 75]);
  assert.equal(iso(a.starts_at), iso(await londonAt(5, '12:00')));
  assert.equal(a.ends_at - a.starts_at, 75 * 60e3);

  // Both at once. Switching back takes today's price.
  await changeBooking(token, gel, await londonAt(6, '09:30'));
  a = await appt(r.reference);
  assert.deepEqual([a.service_name, a.price_pence, a.duration_min, iso(a.starts_at)], ['Gel polish', 2800, 45, iso(await londonAt(6, '09:30'))]);
  assert.equal(a.client_change_count, 4);
  assert.ok(a.client_changed_at);
  assert.equal(a.status, 'pending_deposit', 'the deposit is still owed');

  const log = await changesOf(id);
  assert.deepEqual(log.map((c) => c.action), ['moved', 'moved', 'treatment', 'moved_treatment']);
  assert.deepEqual(
    [log[2].old_service_name, log[2].new_service_name, log[2].old_price_pence, log[2].new_price_pence, log[2].late],
    ['Gel polish', 'BIAB infill', 2500, 3500, false]);
  assert.deepEqual([iso(log[0].old_starts_at), iso(log[0].new_starts_at)], [iso(await londonAt(4, '10:00')), iso(await londonAt(5, '11:00'))]);
  assert.equal((await getBooking(token)).booking.changes_left, 2);

  // The old time is free for someone else.
  await book(gel, await londonAt(4, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
});

test('a new time follows the same rules as a new booking', async () => {
  const gel = await addService('Gel polish', 45);
  const longer = await addService('BIAB new set', 75);
  const mine = await book(gel, await londonAt(4, '09:00'));
  await book(gel, await londonAt(4, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
  const { public_token: token, id } = await appt(mine.reference);

  // Another client and her clean-up gap (10:00–10:55), from either side.
  for (const t of ['10:00', '10:45', '09:15']) await rejects(changeBooking(token, null, await londonAt(4, t)), 'slot_taken');
  // A longer treatment at the same time would run into her too.
  await rejects(changeBooking(token, longer, null), 'slot_taken');
  // The error is a short code, with nothing about the other booking in it.
  await assert.rejects(changeBooking(token, null, await londonAt(4, '10:00')),
    (e) => { assert.equal(e.message, 'slot_taken'); assert.equal(e.detail, undefined); return true; });
  // Time off keeps the same clean-up gap in front of it.
  await db.query(`insert into public.time_off (starts_at, ends_at) values ($1, $2)`, [await londonAt(5, '13:00'), await londonAt(5, '15:00')]);
  await rejects(changeBooking(token, null, await londonAt(5, '12:30')), 'slot_taken');

  const inOneHour = new Date(Date.now() + 3600e3);
  inOneHour.setUTCSeconds(0, 0);
  await rejects(changeBooking(token, null, inOneHour.toISOString()), 'too_soon');
  await rejects(changeBooking(token, null, await londonAt(90, '10:00')), 'too_far');
  await rejects(changeBooking(token, null, await londonAt(5, '08:00')), 'outside_hours');
  await rejects(changeBooking(token, null, await londonAt(5, '17:30')), 'outside_hours'); // would end 18:15
  await rejects(changeBooking(token, null, await londonAt(5, '10:07')), 'invalid_time');
  const dow = (await db.query(`select extract(isodow from (now() at time zone 'Europe/London')::date + 6)::int as d`)).rows[0].d;
  await db.query(`update public.opening_hours set is_open = false where weekday = $1`, [dow]);
  await rejects(changeBooking(token, null, await londonAt(6, '10:00')), 'closed');

  await rejects(changeBooking(token, randomUUID(), null), 'invalid_service');
  const old = (await db.query(`insert into public.services (name, duration_min, price_pence, is_active) values ('Old', 30, 100, false) returning id`)).rows[0].id;
  const phoneOnly = (await db.query(`insert into public.services (name, duration_min, price_pence, online_bookable) values ('Phone only', 30, 100, false) returning id`)).rows[0].id;
  await rejects(changeBooking(token, old, null), 'invalid_service');
  await rejects(changeBooking(token, phoneOnly, null), 'invalid_service');

  await rejects(changeBooking(token, null, null), 'no_change');
  await rejects(changeBooking(token, gel, await londonAt(4, '09:00')), 'no_change');
  await rejects(changeBooking(randomUUID(), null, await londonAt(5, '10:00')), 'not_found');

  // None of the refusals changed or counted anything.
  const a = await appt(mine.reference);
  assert.deepEqual([iso(a.starts_at), a.client_change_count], [iso(await londonAt(4, '09:00')), 0]);
  assert.equal((await changesOf(id)).length, 0);
});

test('a booking can be changed online six times at most; cancelling is still allowed', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const { public_token: token } = await appt(r.reference);
  for (let i = 0; i < 6; i++) await changeBooking(token, null, await londonAt(4, i % 2 ? '10:00' : '11:00'));
  assert.equal((await getBooking(token)).booking.changes_left, 0);
  await rejects(changeBooking(token, null, await londonAt(4, '12:00')), 'too_many_changes');
  assert.equal((await appt(r.reference)).client_change_count, 6);
  assert.equal((await cancelBooking(token)).cancelled, true);
});

test('the owner can switch online changes off, or pause booking', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const { public_token: token } = await appt(r.reference);
  await db.query(`update public.settings set client_self_service = false where id = 1`);
  await rejects(changeBooking(token, null, await londonAt(5, '10:00')), 'changes_disabled');
  await rejects(cancelBooking(token), 'changes_disabled');
  assert.equal((await getBooking(token)).client_self_service, false, 'the booking can still be looked at');

  await db.query(`update public.settings set client_self_service = true, booking_enabled = false where id = 1`);
  await rejects(changeBooking(token, null, await londonAt(5, '10:00')), 'booking_disabled');
  assert.equal((await cancelBooking(token)).cancelled, true, 'but she can always cancel');
});

test('nothing can be changed once the appointment has started, or once it is cancelled', async () => {
  const started = await diaryAppt(new Date(Date.now() - 10 * 60e3));
  await rejects(changeBooking(started.public_token, null, await londonAt(4, '10:00')), 'too_late');
  await rejects(cancelBooking(started.public_token), 'too_late');

  const byOwner = await diaryAppt(await londonAt(4, '10:00'));
  await asOwner(`select public.owner_cancel_appointment($1, 'Ill', true)`, [byOwner.id]);
  await rejects(changeBooking(byOwner.public_token, null, await londonAt(5, '10:00')), 'not_changeable');
  await rejects(cancelBooking(byOwner.public_token), 'not_changeable');
  await db.query(`update public.appointments set status = 'completed' where id = $1`, [started.id]);
  await rejects(cancelBooking(started.public_token), 'not_changeable');
});

test('any change inside the notice period is late, and fixes the fee at the price before it', async () => {
  const gel = await addService('Gel polish', 45, 2500);
  const biab = await addService('BIAB infill', 75, 3500);
  const soon = await diaryAppt(await insideNotice(), { serviceId: gel });

  // Switching treatment inside the notice period counts too (so a cheaper one can't shrink the fee).
  assert.equal((await changeBooking(soon.public_token, biab, null)).late, true, 'same time, different treatment');
  assert.equal((await changeBooking(soon.public_token, null, await londonAt(4, '10:00'))).late, true);
  // Moved again, now with plenty of notice for the time she had: this change itself isn't late.
  assert.equal((await changeBooking(soon.public_token, null, await londonAt(5, '10:00'))).late, false);
  const log = await changesOf(soon.id);
  assert.deepEqual(log.map((c) => [c.action, c.late]), [['treatment', true], ['moved', true], ['moved', false]]);
  assert.equal(iso(log[1].old_starts_at), iso(await insideNotice()));
  // The fee is the dearest price the booking had when it was changed late.
  const row = (await db.query(`select late_fee_pence from public.appointments where id = $1`, [soon.id])).rows[0];
  assert.equal(row.late_fee_pence, 3500);

  // With no notice period, nothing is ever late.
  await db.query(`update public.settings set cancel_notice_hours = 0 where id = 1`);
  const soon2 = await diaryAppt(await insideNotice(), { email: 'b@example.com', serviceId: gel });
  assert.equal((await changeBooking(soon2.public_token, null, await londonAt(4, '14:00'))).late, false);
});

test('changes email the client and the owner, without doubling up', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const { public_token: token } = await appt(r.reference);

  // The confirmation and the new-booking alert haven't gone yet: they'll carry the new time anyway.
  await changeBooking(token, null, await londonAt(4, '11:00'));
  assert.deepEqual((await outbox()).map((e) => e.kind), ['booking_received', 'owner_new_booking']);

  // Each side on its own: the client's confirmation went, the owner's alert is still waiting (a failed try).
  const c = await claimJobs();
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(c.jobs.map((j) =>
    ({ id: j.id, ok: j.kind === 'booking_received', error: 'quota' })))]);
  await changeBooking(token, null, await londonAt(4, '12:00'));
  assert.deepEqual((await outbox()).filter((e) => e.status === 'pending').map((e) => e.kind), ['changed', 'owner_new_booking']);

  // Once both have gone, a change is its own email to each.
  await sendAll();
  await changeBooking(token, null, await londonAt(4, '13:00'));
  assert.deepEqual((await outbox()).filter((e) => e.status === 'pending'), [
    { kind: 'changed', status: 'pending', to_email: 'jess@example.com' },
    { kind: 'owner_changed', status: 'pending', to_email: 'owner@example.com' },
  ]);

  // Changed again after those went: both go again, as fresh emails with the latest time.
  const first = await sendAll();
  assert.deepEqual(first.jobs.map((j) => j.kind).sort(), ['changed', 'owner_changed']);
  await changeBooking(token, null, await londonAt(4, '14:00'));
  assert.deepEqual((await db.query(`select kind, status, attempts, claimed_at from public.email_outbox
                                     where kind in ('changed', 'owner_changed') order by kind`)).rows, [
    { kind: 'changed', status: 'pending', attempts: 0, claimed_at: null },
    { kind: 'owner_changed', status: 'pending', attempts: 0, claimed_at: null },
  ]);
  const second = await claimJobs();
  assert.deepEqual(second.jobs.map((j) => iso(j.starts_at)), [iso(await londonAt(4, '14:00')), iso(await londonAt(4, '14:00'))]);
});

test('a change made while its email is going out is sent again with the latest details', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const { public_token: token } = await appt(r.reference);
  await sendAll();
  await changeBooking(token, null, await londonAt(4, '11:00'));
  const going = await claimJobs();
  assert.deepEqual(going.jobs.map((j) => j.kind).sort(), ['changed', 'owner_changed']);

  const notices = async () => (await db.query(`select status, resend from public.email_outbox
                                                where kind in ('changed', 'owner_changed') order by kind`)).rows
    .map((e) => `${e.status}${e.resend ? ' +resend' : ''}`);
  // Changed again while the script is still sending: the rows are left going out, marked to go once more…
  await changeBooking(token, null, await londonAt(4, '12:00'));
  assert.deepEqual(await notices(), ['sending +resend', 'sending +resend']);
  // …so when the script reports them sent, they're queued again.
  await reportSent(going.jobs);
  assert.deepEqual(await notices(), ['pending', 'pending']);
  const again = await claimJobs();
  assert.deepEqual(again.jobs.map((j) => iso(j.starts_at)), [iso(await londonAt(4, '12:00')), iso(await londonAt(4, '12:00'))]);
  // Nothing changed since that claim: sent means sent.
  await reportSent(again.jobs);
  assert.deepEqual(await notices(), ['sent', 'sent']);
});

test('a client move resets both reminders for the new time', async () => {
  await db.query(`update public.settings set reminder_hours_before = 48 where id = 1`);
  const a = await diaryAppt(await insideNotice(), { createdAt: weekAgo() });
  assert.deepEqual((await sendAll()).jobs.map((j) => j.kind), ['reminder']);
  await db.query(`update public.appointments set whatsapp_reminder_sent_at = now() where id = $1`, [a.id]);
  const before = await appt(a.reference);
  assert.ok(before.reminder_email_sent_at && before.whatsapp_reminder_sent_at);

  await changeBooking(a.public_token, null, await londonAt(5, '10:00'));
  const after = await appt(a.reference);
  assert.equal(after.reminder_email_sent_at, null);
  assert.equal(after.whatsapp_reminder_sent_at, null);
  assert.ok(!(await outbox()).some((e) => e.kind === 'reminder'), 'the old reminder is cleared, so the new time gets its own');
});

test('no reminder straight after a change email that went out inside the reminder window', async () => {
  await db.query(`update public.settings set reminder_hours_before = 48, min_notice_hours = 0 where id = 1`);
  const biab = await addService('BIAB infill', 75, 3500);
  const byClient = await diaryAppt(await londonAt(5, '10:00'), { createdAt: weekAgo() });
  const switcher = await diaryAppt(await londonAt(1, '09:00'), { email: 'b@example.com', createdAt: weekAgo() });
  const byOwner = await diaryAppt(await londonAt(5, '14:00'), { email: 'c@example.com', createdAt: weekAgo() });

  // Into the window: by the client (who is emailed the new details) and by the owner (who sends nothing).
  await changeBooking(byClient.public_token, null, await londonAt(1, '14:00'));
  await changeBooking(switcher.public_token, biab, null);
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [byOwner.id, await londonAt(1, '16:00')]);
  assert.ok((await appt(byClient.reference)).details_sent_at);
  assert.equal((await appt(byOwner.reference)).details_sent_at, null);

  const jobs = (await claimJobs()).jobs.map((j) => `${j.kind} ${j.to}`).sort();
  assert.deepEqual(jobs, [
    'changed b@example.com', 'changed dana@example.com',
    'owner_changed owner@example.com', 'owner_changed owner@example.com',
    'reminder c@example.com',
  ]);
});

test('a client with no email can still use the link, and still gets their reminder', async () => {
  await db.query(`update public.settings set reminder_hours_before = 48 where id = 1`);
  const a = await diaryAppt(await londonAt(5, '10:00'), { email: null, createdAt: weekAgo() });
  await changeBooking(a.public_token, null, await insideNotice());
  const moved = await appt(a.reference);
  assert.equal(moved.client_change_count, 1);
  assert.equal(moved.details_sent_at, null, 'no email went out, so nothing was sent to her');
  assert.deepEqual((await outbox()).map((e) => e.kind), ['owner_changed']);
});

test('a "deposit received" email inside the reminder window is not followed by a reminder', async () => {
  await db.query(`update public.settings set reminder_hours_before = 48 where id = 1`);
  const svc = await addService();
  const r = await book(svc, await insideNotice());
  await db.query(`update public.appointments set created_at = now() - interval '7 days' where reference = $1`, [r.reference]);
  await sendAll();
  await asOwner(`select public.owner_mark_deposit_paid($1, 'bank_transfer')`, [(await appt(r.reference)).id]);
  assert.ok((await appt(r.reference)).details_sent_at);
  assert.deepEqual((await claimJobs()).jobs.map((j) => j.kind), ['deposit_received']);
  // That is what holds the reminder back: without it, one would go now.
  await db.query(`update public.appointments set details_sent_at = null where reference = $1`, [r.reference]);
  assert.deepEqual((await claimJobs()).jobs.map((j) => j.kind), ['reminder']);
});

test('a client move earlier brings the deposit deadline with it', async () => {
  const svc = await addService();
  await db.query(`update public.settings set deposit_deadline_hours = 200 where id = 1`);
  const r = await book(svc, await londonAt(10, '10:00'));
  const before = await appt(r.reference);
  assert.ok(before.deposit_due_at < before.starts_at);
  await changeBooking(before.public_token, null, await londonAt(2, '10:00'));
  const after = await appt(r.reference);
  assert.equal(iso(after.deposit_due_at), iso(after.starts_at));
  // Moving later again doesn't stretch it.
  await changeBooking(before.public_token, null, await londonAt(9, '10:00'));
  assert.equal(iso((await appt(r.reference)).deposit_due_at), iso(await londonAt(2, '10:00')));
});

test('times are London wall-clock time, and notice is counted in real hours across a clock change', async () => {
  const svc = await addService();
  await db.query(`update public.settings set max_days_ahead = 365 where id = 1`);
  // Days from today to the next Sunday the clocks change (noon to noon isn't 24 hours).
  const { days } = (await db.query(`
    select (d::date - (now() at time zone 'Europe/London')::date) as days
      from generate_series((now() at time zone 'Europe/London')::date + 2,
                           (now() at time zone 'Europe/London')::date + 300, interval '1 day') d
     where ((d::date + time '12:00') at time zone 'Europe/London')
         - ((d::date - 1 + time '12:00') at time zone 'Europe/London') <> interval '24 hours'
     order by d limit 1`)).rows[0];
  const r = await book(svc, await londonAt(days + 1, '10:00'));
  const { public_token: token } = await appt(r.reference);
  // 09:00 on the Monday after is opening time in London, whatever the hour is in UTC.
  await changeBooking(token, null, await londonAt(days + 1, '09:00'));
  const a = await appt(r.reference);
  const local = (await db.query(`select to_char($1::timestamptz at time zone 'Europe/London', 'HH24:MI') as t`, [a.starts_at])).rows[0].t;
  assert.equal(local, '09:00');
  // 48 hours' notice means 48 real hours, here and in the emails.
  const m = await getBooking(token);
  assert.equal(new Date(m.booking.free_until).getTime(), a.starts_at.getTime() - 48 * 3600e3);
  const job = (await claimJobs()).jobs.find((j) => j.kind === 'booking_received');
  assert.equal(new Date(job.free_until).getTime(), a.starts_at.getTime() - 48 * 3600e3);
});

test('a client can cancel; inside the notice period it is flagged as late', async () => {
  const svc = await addService('Gel polish', 45, 2500);
  const soon = await diaryAppt(await insideNotice(), { serviceId: svc });
  const later = await diaryAppt(await londonAt(4, '10:00'), { email: 'b@example.com', serviceId: svc });

  assert.deepEqual(await cancelBooking(soon.public_token, '  Car broke\n\tdown  '), { cancelled: true, late: true });
  const a = await appt(soon.reference);
  assert.deepEqual([a.status, a.cancelled_by, a.cancelled_late, a.cancel_reason, a.client_change_count, a.late_fee_pence],
    ['cancelled', 'client', true, 'Car broke down', 0, 2500]);
  assert.ok(a.cancelled_at && a.client_changed_at);
  assert.deepEqual((await changesOf(soon.id)).map((c) =>
    [c.action, c.late, c.note, iso(c.old_starts_at), c.new_starts_at, c.old_service_name, c.old_price_pence]),
  [['cancelled', true, 'Car broke down', iso(soon.starts_at), null, 'Gel polish', 2500]]);

  assert.deepEqual(await cancelBooking(later.public_token), { cancelled: true, late: false });
  const b = await appt(later.reference);
  assert.deepEqual([b.cancelled_by, b.cancelled_late, b.cancel_reason, b.late_fee_pence], ['client', false, null, null]);

  // Once is enough, and the manage page shows what happened.
  await rejects(cancelBooking(soon.public_token), 'not_changeable');
  await rejects(changeBooking(soon.public_token, null, await londonAt(5, '10:00')), 'not_changeable');
  const m = await getBooking(soon.public_token);
  assert.deepEqual([m.booking.status, m.booking.cancelled_by, m.booking.cancelled_late, m.booking.late_fee_pence],
    ['cancelled', 'client', true, 2500]);
  await rejects(cancelBooking(randomUUID()), 'not_found');
  // The time is free again.
  await book(svc, await insideNotice(), { p_email: 'e@example.com', p_phone: '07700900555' });
});

test('a cancellation reason is tidied to one line and kept short', async () => {
  const cases = [
    ['x'.repeat(299) + ' ' + 'y'.repeat(100), 'x'.repeat(299)],
    ['z'.repeat(400), 'z'.repeat(300)],
    ['Sorry,\r\n\r\nsomething   came up', 'Sorry, something came up'],
    [' \n\t ', null],
    [null, null],
  ];
  let n = 0;
  for (const [reason, want] of cases) {
    const a = await diaryAppt(await londonAt(4 + n, '10:00'), { email: `r${n++}@example.com` });
    await cancelBooking(a.public_token, reason);
    assert.equal((await appt(a.reference)).cancel_reason, want);
    assert.equal((await changesOf(a.id))[0].note, want);
  }
});

test('cancelling drops waiting emails, and both cancellation notices go out', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const { public_token: token } = await appt(r.reference);
  // Fresh booking: nothing has gone yet.
  await cancelBooking(token, 'Sorry');
  assert.deepEqual((await outbox()).map(({ kind, status }) => ({ kind, status })), [
    { kind: 'booking_received', status: 'skipped' },
    { kind: 'cancelled', status: 'pending' },
    { kind: 'owner_cancelled', status: 'pending' },
    { kind: 'owner_new_booking', status: 'skipped' },
  ]);
  const c = await claimJobs();
  assert.deepEqual(c.jobs.map((j) => `${j.kind} ${j.to}`).sort(), ['cancelled jess@example.com', 'owner_cancelled owner@example.com']);
  const owner = c.jobs.find((j) => j.kind === 'owner_cancelled');
  assert.deepEqual([owner.cancelled_by, owner.cancelled_late, owner.cancel_reason, owner.status], ['client', false, 'Sorry', 'cancelled']);
  assert.equal(owner.changes.at(-1).action, 'cancelled');

  // Change notices still waiting are dropped too.
  const r2 = await book(svc, await londonAt(5, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
  const t2 = (await appt(r2.reference)).public_token;
  await sendAll();
  await changeBooking(t2, null, await londonAt(5, '11:00'));
  await cancelBooking(t2);
  const rows = (await db.query(`select o.kind, o.status from public.email_outbox o join public.appointments a on a.id = o.appointment_id
                                 where a.reference = $1 order by o.kind`, [r2.reference])).rows;
  assert.deepEqual(rows.filter((x) => x.kind.endsWith('changed')).map((x) => x.status), ['skipped', 'skipped']);
  assert.deepEqual((await claimJobs()).jobs.map((j) => j.kind).sort(), ['cancelled', 'owner_cancelled']);
});

test('the email script is handed the manage link, the cut-off and the latest changes', async () => {
  const gel = await addService('Gel polish', 45, 2500);
  const biab = await addService('BIAB infill', 75, 3500);
  const r = await book(gel, await londonAt(4, '10:00'));
  const a = await appt(r.reference);

  let c = await sendAll();
  const job = c.jobs.find((j) => j.kind === 'booking_received');
  assert.equal(job.manage_url, `https://book.example.com/manage/${a.public_token}`);
  assert.equal(new Date(job.free_until).getTime(), a.starts_at.getTime() - 48 * 3600e3);
  assert.deepEqual([job.deposit_paid, job.cancelled_by, job.cancelled_late, job.changes], [false, null, false, []]);
  assert.deepEqual([job.cancelled_at, job.late_fee_pence, job.booking_phone], [null, null, null]);
  assert.deepEqual([c.settings.cancel_notice_hours, c.settings.client_self_service], [48, true]);

  // Four changes: the owner's alert gets the last three, oldest first.
  await changeBooking(a.public_token, null, await londonAt(4, '11:00'));
  await changeBooking(a.public_token, biab, null);
  await changeBooking(a.public_token, null, await londonAt(5, '10:00'));
  await changeBooking(a.public_token, gel, await londonAt(5, '14:00'));
  c = await sendAll();
  const owner = c.jobs.find((j) => j.kind === 'owner_changed');
  assert.deepEqual(owner.changes.map((x) => x.action), ['treatment', 'moved', 'moved_treatment']);
  assert.deepEqual(Object.keys(owner.changes[0]).sort(),
    ['action', 'at', 'late', 'new_service_name', 'new_starts_at', 'old_service_name', 'old_starts_at']);
  assert.deepEqual([owner.changes[0].old_service_name, owner.changes[0].new_service_name, owner.changes[0].late],
    ['Gel polish', 'BIAB infill', false]);
  assert.deepEqual([iso(owner.changes[2].old_starts_at), iso(owner.changes[2].new_starts_at)],
    [iso(await londonAt(5, '10:00')), iso(await londonAt(5, '14:00'))]);

  await asOwner(`select public.owner_mark_deposit_paid($1, 'cash')`, [a.id]);
  assert.equal((await sendAll()).jobs.find((j) => j.kind === 'deposit_received').deposit_paid, true);

  // No web address set: no link. No notice period: no cut-off.
  await db.query(`update public.settings set public_site_url = null, cancel_notice_hours = 0 where id = 1`);
  await asOwner(`select public.owner_queue_email($1, 'booking_received')`, [a.id]);
  c = await claimJobs();
  assert.deepEqual([c.jobs[0].manage_url, c.jobs[0].free_until, c.settings.cancel_notice_hours], [null, null, 0]);
});

test('who cancelled is recorded: the owner, or the system when a deposit never came', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  await asOwner(`select public.owner_cancel_appointment($1, 'Ill', true)`, [(await appt(r.reference)).id]);
  const a = await appt(r.reference);
  assert.deepEqual([a.cancelled_by, a.cancelled_late], ['owner', false]);
  assert.ok(!(await outbox()).some((e) => e.kind === 'owner_cancelled'), 'no alert to herself about her own cancellation');

  const r2 = await book(svc, await londonAt(5, '10:00'), { p_email: 'b@example.com', p_phone: '07700900222' });
  await db.query(`update public.appointments set deposit_due_at = now() - interval '1 minute' where reference = $1`, [r2.reference]);
  await db.query(`update public.settings set auto_cancel_unpaid = true where id = 1`);
  const c = await claimJobs();
  const b = await appt(r2.reference);
  assert.deepEqual([b.status, b.cancelled_by, b.cancelled_late], ['cancelled', 'system', false]);
  const jobs = c.jobs.filter((j) => j.kind === 'cancelled').map((j) => [j.reference, j.cancelled_by]).sort();
  assert.deepEqual(jobs, [[r.reference, 'owner'], [r2.reference, 'system']].sort());
});

test('the owner can email a client their new time after moving it herself', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const a = await appt(r.reference);
  await sendAll();
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, await londonAt(4, '15:00')]);
  assert.equal((await appt(r.reference)).details_sent_at, null);

  await asOwner(`select public.owner_queue_email($1, 'changed')`, [a.id]);
  const stamped = (await appt(r.reference)).details_sent_at;
  assert.ok(stamped);
  assert.deepEqual((await outbox()).find((e) => e.kind === 'changed'), { kind: 'changed', status: 'pending', to_email: 'jess@example.com' });
  // A re-sent reminder isn't the full details, so it doesn't count.
  await asOwner(`select public.owner_queue_email($1, 'reminder')`, [a.id]);
  assert.equal((await appt(r.reference)).details_sent_at.getTime(), stamped.getTime());

  await rejects(asOwner(`select public.owner_queue_email($1, 'owner_changed')`, [a.id]), 'invalid_kind');
  await rejects(asStranger(`select public.owner_queue_email($1, 'changed')`, [a.id]), 'not_allowed');
  await rejects(asAnon(`select public.owner_queue_email($1, 'changed')`, [a.id]), 'permission denied');
});

test('the log of client changes is for the owner’s eyes only', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const a = await appt(r.reference);
  await changeBooking(a.public_token, null, await londonAt(4, '11:00'));

  await rejects(asAnon(`select * from public.client_changes`), 'permission denied');
  await rejects(asAnon(`insert into public.client_changes (appointment_id, action) values ($1, 'moved')`, [a.id]), 'permission denied');
  assert.equal((await asStranger(`select * from public.client_changes`)).rows.length, 0);
  await rejects(asStranger(`insert into public.client_changes (appointment_id, action) values ($1, 'moved')`, [a.id]), 'row-level security');
  assert.equal((await asOwner(`select * from public.client_changes`)).rows.length, 1);
  // Nor can anyone reach the helper that puts emails in the queue.
  await rejects(asAnon(`select public.queue_email($1, 'changed', 'someone@example.com', true)`, [a.id]), 'permission denied');
  await rejects(asStranger(`select public.queue_email($1, 'changed', 'someone@example.com', true)`, [a.id]), 'permission denied');
});

test('the owner can mark a cancellation as late when the client told her by phone or WhatsApp', async () => {
  const a = await diaryAppt(new Date(Date.now() + 20 * 3600e3));
  await asOwner(`select public.owner_cancel_appointment($1, 'Told me on WhatsApp', true, true)`, [a.id]);
  const late = (await db.query(`select * from public.appointments where id = $1`, [a.id])).rows[0];
  assert.equal(late.status, 'cancelled');
  assert.equal(late.cancelled_by, 'owner');
  assert.equal(late.cancelled_late, true);
  assert.equal(late.late_fee_pence, 2500, 'the full price is what’s payable');
  const jobs = await claimJobs();
  const job = jobs.jobs.find((j) => j.kind === 'cancelled');
  assert.equal(job.cancelled_by, 'owner');
  assert.equal(job.cancelled_late, true);
  assert.equal(job.late_fee_pence, 2500);

  // Without the flag (the old three-argument call) it isn't late.
  const b = await diaryAppt(new Date(Date.now() + 30 * 3600e3), { email: 'erin@example.com' });
  await asOwner(`select public.owner_cancel_appointment($1, 'Ill', true)`, [b.id]);
  assert.deepEqual((await db.query(`select cancelled_late, late_fee_pence from public.appointments where id = $1`, [b.id])).rows[0],
    { cancelled_late: false, late_fee_pence: null });

  // A client who switched to something cheaper late, then phoned to cancel: the dearer price stands.
  const set = await addService('BIAB new set', 75, 4500);
  const polish = await addService('File and polish', 30, 800);
  const c = await diaryAppt(await londonAt(1, '16:00'), { email: 'fay@example.com', serviceId: set, serviceName: 'BIAB new set', duration: 75, price: 4500 });
  await changeBooking(c.public_token, polish, null);
  await asOwner(`select public.owner_cancel_appointment($1, 'Phoned', true, true)`, [c.id]);
  assert.deepEqual((await db.query(`select price_pence, late_fee_pence from public.appointments where id = $1`, [c.id])).rows[0],
    { price_pence: 800, late_fee_pence: 4500 });
});

test('the manage page knows whether changes will be confirmed by email, without seeing the address', async () => {
  const withEmail = await diaryAppt(await londonAt(4, '10:00'));
  const m = await getBooking(withEmail.public_token);
  assert.equal(m.booking.has_email, true);
  assert.ok(!JSON.stringify(m).includes('dana@example.com'));
  const c = (await db.query(`insert into public.clients (full_name, phone) values ('No Email', '07700 900999') returning id`)).rows[0];
  const noEmail = (await db.query(
    `insert into public.appointments (client_id, service_name, duration_min, starts_at, ends_at, busy_until, reference, status)
     values ($1, 'Gel', 45, $2, $2, $2, '', 'confirmed') returning *`, [c.id, await londonAt(5, '10:00')])).rows[0];
  assert.equal((await getBooking(noEmail.public_token)).booking.has_email, false);
});

// ---------------------------------------------------------------------------
// Second review: the change/cancel link (C0–C8, C20)
// ---------------------------------------------------------------------------

test('a returning client who types a different mobile: kept on the booking for the owner to check, never on her record', async () => {
  const svc = await addService();
  const vicky = { p_full_name: 'Vicky Example', p_email: 'vicky@example.com' };
  // Someone books first with her email and their own number, and the owner cancels it…
  const first = await book(svc, await londonAt(3, '10:00'), { ...vicky, p_phone: '07700 900666' });
  assert.equal((await appt(first.reference)).booking_phone, null, 'a new client’s number goes on her record');
  await asOwner(`select public.owner_cancel_appointment($1, null, false)`, [(await appt(first.reference)).id]);

  // …then she books with her real number.
  const second = await book(svc, await londonAt(4, '10:00'), { ...vicky, p_phone: '07700 900111' });
  assert.equal((await appt(second.reference)).booking_phone, '07700 900111');
  assert.deepEqual((await db.query(`select full_name, phone, phone_e164 from public.clients`)).rows,
    [{ full_name: 'Vicky Example', phone: '07700 900666', phone_e164: '447700900666' }], 'the record is never changed from the booking page');
  // The owner's alert has both, so she can check before she WhatsApps.
  const job = (await claimJobs()).jobs.find((j) => j.kind === 'owner_new_booking');
  assert.deepEqual([job.reference, job.client_phone, job.booking_phone], [second.reference, '07700 900666', '07700 900111']);
  // The manage page never shows it.
  assert.ok(!JSON.stringify(await getBooking((await appt(second.reference)).public_token)).includes('900111'));

  // The same number, however it's typed: nothing to check.
  const third = await book(svc, await londonAt(5, '10:00'), { ...vicky, p_phone: '+44 (0)7700 900666' });
  assert.equal((await appt(third.reference)).booking_phone, null);
});

test('a late move, then two moves in good time, then a cancellation: still late, at the original price', async () => {
  const gel = await addService('Gel polish', 45, 2500);
  const a = await diaryAppt(await insideNotice(), { serviceId: gel });
  assert.equal((await getBooking(a.public_token)).booking.late_fee_pence, null);

  assert.equal((await changeBooking(a.public_token, null, await londonAt(4, '10:00'))).late, true);
  assert.equal((await changeBooking(a.public_token, null, await londonAt(5, '10:00'))).late, false);
  assert.equal((await changeBooking(a.public_token, null, await londonAt(6, '10:00'))).late, false);
  // The manage page knows a cancellation is now late whenever it comes, and what's payable.
  assert.equal((await getBooking(a.public_token)).booking.late_fee_pence, 2500);

  // Days ahead of its new time, but late all the same.
  assert.deepEqual(await cancelBooking(a.public_token), { cancelled: true, late: true });
  const row = await appt(a.reference);
  assert.deepEqual([row.cancelled_late, row.late_fee_pence], [true, 2500]);
  assert.deepEqual((await changesOf(a.id)).map((c) => [c.action, c.late]),
    [['moved', true], ['moved', false], ['moved', false], ['cancelled', true]]);
  const m = await getBooking(a.public_token);
  assert.deepEqual([m.booking.cancelled_late, m.booking.late_fee_pence], [true, 2500]);

  // The email script can tell it was late because of the earlier change, not the cancellation itself.
  const owner = (await claimJobs()).jobs.find((j) => j.kind === 'owner_cancelled');
  assert.deepEqual([owner.cancelled_late, owner.late_fee_pence, owner.price_pence], [true, 2500, 2500]);
  assert.ok(new Date(owner.cancelled_at) < new Date(owner.free_until));
});

test('switching to something cheaper inside the notice period can’t shrink the fee; a dearer one raises it', async () => {
  const set = await addService('BIAB new set', 75, 4500);
  const polish = await addService('File and polish', 30, 800);

  // Downgraded late, then cancelled: the price before the switch.
  const down = await diaryAppt(await insideNotice(), { serviceId: set, serviceName: 'BIAB new set', duration: 75, price: 4500 });
  const r = await changeBooking(down.public_token, polish, null);
  assert.deepEqual([r.late, r.price_pence], [true, 800]);
  assert.deepEqual((await changesOf(down.id)).map((c) => [c.action, c.late, c.old_price_pence, c.new_price_pence]),
    [['treatment', true, 4500, 800]]);
  const before = (await getBooking(down.public_token)).booking;
  assert.deepEqual([before.price_pence, before.late_fee_pence], [800, 4500]);
  assert.deepEqual(await cancelBooking(down.public_token), { cancelled: true, late: true });
  const d = await appt(down.reference);
  assert.deepEqual([d.price_pence, d.cancelled_late, d.late_fee_pence], [800, true, 4500]);
  const owner = (await claimJobs()).jobs.find((j) => j.kind === 'owner_cancelled');
  assert.deepEqual([owner.price_pence, owner.late_fee_pence], [800, 4500]);

  // Upgraded late, then cancelled: the dearer one, the price it had when cancelled.
  const up = await diaryAppt(await londonAt(1, '16:00'),
    { email: 'b@example.com', serviceId: polish, serviceName: 'File and polish', duration: 30, price: 800 });
  assert.equal((await changeBooking(up.public_token, set, null)).late, true);
  assert.equal((await appt(up.reference)).late_fee_pence, 800);
  await cancelBooking(up.public_token);
  const u = await appt(up.reference);
  assert.deepEqual([u.price_pence, u.cancelled_late, u.late_fee_pence], [4500, true, 4500]);
});

test('a cancellation in good time, with no late change before it, isn’t late and has no fee', async () => {
  const gel = await addService('Gel polish', 45, 2500);
  const biab = await addService('BIAB infill', 75, 3500);
  const a = await diaryAppt(await londonAt(4, '10:00'), { serviceId: gel });
  // Changed in good time first: that's not late either.
  assert.equal((await changeBooking(a.public_token, biab, await londonAt(5, '10:00'))).late, false);
  assert.equal((await getBooking(a.public_token)).booking.late_fee_pence, null);
  assert.deepEqual(await cancelBooking(a.public_token), { cancelled: true, late: false });
  const row = await appt(a.reference);
  assert.deepEqual([row.cancelled_late, row.late_fee_pence], [false, null]);
  assert.equal((await claimJobs()).jobs.find((j) => j.kind === 'owner_cancelled').late_fee_pence, null);
});

test('no notice period means the policy is off: a cancellation after an earlier late change isn’t late', async () => {
  const set = await addService('BIAB new set', 75, 4500);
  const polish = await addService('File and polish', 30, 800);
  // Switched to something cheaper and moved a week ahead inside the 48 hours…
  const a = await diaryAppt(await insideNotice(), { serviceId: set, serviceName: 'BIAB new set', duration: 75, price: 4500 });
  assert.equal((await changeBooking(a.public_token, polish, await londonAt(8, '10:00'))).late, true);
  assert.equal((await getBooking(a.public_token)).booking.late_fee_pence, 4500);
  const other = await diaryAppt(await londonAt(1, '16:00'), { email: 'b@example.com', serviceId: set, serviceName: 'BIAB new set', duration: 75, price: 4500 });
  assert.equal((await changeBooking(other.public_token, null, await londonAt(9, '10:00'))).late, true);

  // …then she sets no notice period. The manage page shows no fee and no cut-off, and a change isn't late.
  await db.query(`update public.settings set cancel_notice_hours = 0 where id = 1`);
  const m = await getBooking(a.public_token);
  assert.deepEqual([m.cancel_notice_hours, m.booking.free_until, m.booking.late_fee_pence], [0, null, null]);
  assert.equal((await changeBooking(a.public_token, null, await londonAt(10, '10:00'))).late, false);

  // Cancelling isn't late either, and there's no fee.
  assert.deepEqual(await cancelBooking(a.public_token), { cancelled: true, late: false });
  const row = await appt(a.reference);
  assert.deepEqual([row.cancelled_late, row.late_fee_pence], [false, null]);
  assert.deepEqual((await changesOf(a.id)).map((c) => [c.action, c.late]),
    [['moved_treatment', true], ['moved', false], ['cancelled', false]]);
  const job = (await claimJobs()).jobs.find((j) => j.kind === 'owner_cancelled');
  assert.deepEqual([job.cancelled_late, job.late_fee_pence, job.free_until], [false, null, null]);
  const after = await getBooking(a.public_token);
  assert.deepEqual([after.booking.cancelled_late, after.booking.late_fee_pence], [false, null]);

  // The owner marking a cancellation late is her own call, so it stands, and the
  // manage page shows the fee fixed then.
  const told = await diaryAppt(await londonAt(4, '10:00'), { email: 'c@example.com' });
  await asOwner(`select public.owner_cancel_appointment($1, 'Phoned', true, true)`, [told.id]);
  assert.deepEqual((await db.query(`select cancelled_late, late_fee_pence from public.appointments where id = $1`, [told.id])).rows[0],
    { cancelled_late: true, late_fee_pence: 2500 });
  const t = (await getBooking(told.public_token)).booking;
  assert.deepEqual([t.cancelled_late, t.late_fee_pence], [true, 2500]);

  // The late change is kept on the booking, and counts again once she sets a notice period again.
  assert.equal((await getBooking(other.public_token)).booking.late_fee_pence, null);
  await db.query(`update public.settings set cancel_notice_hours = 48 where id = 1`);
  assert.equal((await getBooking(other.public_token)).booking.late_fee_pence, 4500);
});

test('changes across all bookings are braked, so the links can’t be used to use up the day’s emails', async () => {
  const a = await diaryAppt(await londonAt(4, '10:00'));
  const other = await diaryAppt(await londonAt(5, '10:00'), { email: 'b@example.com' });
  const seed = (n, ago) => db.query(`insert into public.client_changes (appointment_id, action, changed_at)
                                     select $1, 'moved', now() - $2::interval from generate_series(1, $3::int)`, [other.id, ago, n]);

  // Nine in the last hour, on other bookings: the tenth still goes through…
  await seed(9, '50 minutes');
  await changeBooking(a.public_token, null, await londonAt(4, '11:00'));
  // …and then the next one waits, without changing or counting anything.
  await rejects(changeBooking(a.public_token, null, await londonAt(4, '12:00')), 'busy_try_later');
  const held = await appt(a.reference);
  assert.deepEqual([iso(held.starts_at), held.client_change_count], [iso(await londonAt(4, '11:00')), 1]);
  assert.equal((await changesOf(a.id)).length, 1);

  // An hour later that's passed, but forty in a day still stops it.
  await db.query(`update public.client_changes set changed_at = now() - interval '2 hours'`);
  await changeBooking(a.public_token, null, await londonAt(4, '12:00'));   // 11 today
  await seed(29, '20 hours');                                               // 40 today
  await rejects(changeBooking(a.public_token, null, await londonAt(4, '13:00')), 'busy_try_later');
  // Cancelling is never held back.
  assert.equal((await cancelBooking(other.public_token)).cancelled, true);
  // A day later, changes go through again.
  await db.query(`update public.client_changes set changed_at = now() - interval '25 hours'`);
  await changeBooking(a.public_token, null, await londonAt(4, '13:00'));
});

test('when the day’s quota is short, a new client’s confirmation goes before older change notices', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const token = (await appt(r.reference)).public_token;
  await sendAll();
  await changeBooking(token, null, await londonAt(4, '11:00'));
  await sendAll();
  // A real client books, then the first booking changes again: its notices are re-queued under their older ids.
  await book(svc, await londonAt(5, '10:00'), { p_full_name: 'Real Client', p_email: 'real@example.com', p_phone: '07700900222' });
  await changeBooking(token, null, await londonAt(4, '12:00'));
  assert.deepEqual((await db.query(`select kind from public.email_outbox where status = 'pending' order by id`)).rows.map((e) => e.kind),
    ['changed', 'owner_changed', 'booking_received', 'owner_new_booking']);

  const order = [];
  for (let one; (one = (await asAnon(`select public.email_jobs_claim($1, 1) as j`, [SECRET])).rows[0].j.jobs).length;) {
    order.push(`${one[0].kind} ${one[0].to}`);
  }
  assert.deepEqual(order, ['booking_received real@example.com', 'changed jess@example.com',
                           'owner_new_booking owner@example.com', 'owner_changed owner@example.com']);
});

test('the sender takes clients’ confirmations first, then reminders and changes, and the owner’s alerts last', async () => {
  const a = await diaryAppt(await londonAt(4, '10:00'));
  // Queued in the opposite order to the one they should go in.
  for (const kind of ['owner_changed', 'owner_cancelled', 'owner_new_booking', 'changed', 'reminder', 'cancelled',
                      'deposit_received', 'booking_received']) {
    await db.query(`insert into public.email_outbox (kind, appointment_id, to_email) values ($1, $2, 'x@example.com')`, [kind, a.id]);
  }
  const order = [];
  for (let one; (one = (await asAnon(`select public.email_jobs_claim($1, 1) as j`, [SECRET])).rows[0].j.jobs).length;) {
    order.push(one[0].kind);
  }
  assert.deepEqual(order, ['cancelled', 'deposit_received', 'booking_received', 'changed', 'reminder',
                           'owner_cancelled', 'owner_new_booking', 'owner_changed']);
});

test('the owner can give a booking a new link; the old one stops working at once', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const a = await appt(r.reference);
  const old = a.public_token;

  const fresh = (await asOwner(`select public.owner_reset_link($1) as t`, [a.id])).rows[0].t;
  assert.match(fresh, /^[0-9a-f-]{36}$/);
  assert.notEqual(fresh, old);
  assert.equal((await appt(r.reference)).public_token, fresh);

  // The old link: nothing to see, change or cancel.
  assert.equal(await getBooking(old), null);
  assert.equal((await asAnon(`select public.public_get_form($1) as f`, [old])).rows[0].f, null);
  await rejects(changeBooking(old, null, await londonAt(5, '10:00')), 'not_found');
  await rejects(cancelBooking(old), 'not_found');
  await rejects(asAnon(`select * from public.public_busy_times_except($1, now(), now() + interval '7 days')`, [old]), 'not_found');
  // The new one works, and emails still to go carry it.
  assert.equal((await getBooking(fresh)).booking.reference, r.reference);
  const job = (await claimJobs()).jobs.find((j) => j.kind === 'booking_received');
  assert.equal(job.manage_url, `https://book.example.com/manage/${fresh}`);
  assert.equal(job.form_url, `https://book.example.com/form/${fresh}`);

  // Only the owner.
  await rejects(asStranger(`select public.owner_reset_link($1)`, [a.id]), 'not_allowed');
  await rejects(asAnon(`select public.owner_reset_link($1)`, [a.id]), 'permission denied');
  assert.equal((await appt(r.reference)).public_token, fresh, 'the refused calls changed nothing');
  await rejects(asOwner(`select public.owner_reset_link($1)`, [randomUUID()]), 'not_found');
});

test('a move nobody was emailed about gets a reminder for the new time', async () => {
  await db.query(`update public.settings set reminder_hours_before = 72 where id = 1`);
  // Booked a week ago for later in the week. Both clients move into the reminder
  // window online and are emailed their new times: no reminder on top of that.
  const a = await diaryAppt(await londonAt(5, '10:00'), { createdAt: weekAgo() });
  const b = await diaryAppt(await londonAt(5, '14:00'), { email: 'b@example.com', createdAt: weekAgo() });
  // And one the owner put in the diary inside the window: no reminder for that either.
  const c = await diaryAppt(await londonAt(2, '09:00'), { email: 'c@example.com' });
  await changeBooking(a.public_token, null, await londonAt(2, '10:00'));
  await changeBooking(b.public_token, null, await londonAt(2, '14:00'));
  assert.deepEqual((await sendAll()).jobs.map((j) => j.kind).sort(), ['changed', 'changed', 'owner_changed', 'owner_changed']);

  // The owner then moves all three herself, and emails only one of them about it.
  const move = (x, t) => asOwner(`update public.appointments set starts_at = $2 where id = $1`, [x.id, t]);
  await move(a, await londonAt(2, '15:00'));
  await move(b, await londonAt(2, '16:30'));
  await move(c, await londonAt(2, '11:00'));
  await asOwner(`select public.owner_queue_email($1, 'changed')`, [b.id]);
  const jobs = (await claimJobs()).jobs.map((j) => `${j.kind} ${j.to} ${iso(j.starts_at)}`).sort();
  assert.deepEqual(jobs, [
    `changed b@example.com ${iso(await londonAt(2, '16:30'))}`,
    `reminder c@example.com ${iso(await londonAt(2, '11:00'))}`,
    `reminder dana@example.com ${iso(await londonAt(2, '15:00'))}`,
  ]);
});

test('a reminder going out as the booking moves doesn’t stop one for the new time', async () => {
  await db.query(`update public.settings set reminder_hours_before = 72 where id = 1`);
  const a = await diaryAppt(await londonAt(2, '10:00'), { createdAt: weekAgo() });
  const going = await claimJobs();
  assert.deepEqual(going.jobs.map((j) => [j.kind, iso(j.starts_at)]), [['reminder', iso(await londonAt(2, '10:00'))]]);

  // Moved while the script is still sending it: that one has the old time.
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, await londonAt(2, '16:00')]);
  assert.deepEqual(await outbox(), []);
  assert.equal((await asAnon(`select public.email_jobs_report($1, $2) as n`,
    [SECRET, JSON.stringify(going.jobs.map((j) => ({ id: j.id, ok: true })))])).rows[0].n, 0);
  assert.equal((await appt(a.reference)).reminder_email_sent_at, null);
  const next = await claimJobs();
  assert.deepEqual(next.jobs.map((j) => [j.kind, iso(j.starts_at)]), [['reminder', iso(await londonAt(2, '16:00'))]]);
  await reportSent(next.jobs);
  assert.ok((await appt(a.reference)).reminder_email_sent_at);

  // Moved out of the window mid-send, and the window later widened to cover it: it still gets one.
  const going2 = await claimJobs();
  assert.equal(going2.jobs.length, 0, 'sent means sent');
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, await londonAt(5, '10:00')]);
  await db.query(`update public.settings set reminder_hours_before = 168 where id = 1`);
  assert.deepEqual((await claimJobs()).jobs.map((j) => [j.kind, iso(j.starts_at)]), [['reminder', iso(await londonAt(5, '10:00'))]]);
});

test('the owner’s “email the new time” while a change notice is going out is sent once that one reports back', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(4, '10:00'));
  const a = await appt(r.reference);
  await sendAll();
  await changeBooking(a.public_token, null, await londonAt(6, '10:00'));
  const going = await claimJobs();
  assert.deepEqual(going.jobs.map((j) => j.kind).sort(), ['changed', 'owner_changed']);

  // She moves it again while those are going out, and ticks "email them the new time".
  await asOwner(`update public.appointments set starts_at = $2 where id = $1`, [a.id, await londonAt(7, '11:00')]);
  assert.equal((await asOwner(`select public.owner_queue_email($1, 'changed') as ok`, [a.id])).rows[0].ok, true);
  const notices = async () => (await db.query(`select kind, status, resend from public.email_outbox
                                                where kind in ('changed', 'owner_changed') order by kind`)).rows;
  assert.deepEqual(await notices(), [
    { kind: 'changed', status: 'sending', resend: true },
    { kind: 'owner_changed', status: 'sending', resend: false },
  ]);

  await reportSent(going.jobs);
  assert.deepEqual(await notices(), [
    { kind: 'changed', status: 'pending', resend: false },
    { kind: 'owner_changed', status: 'sent', resend: false },
  ]);
  const again = await claimJobs();
  assert.deepEqual(again.jobs.map((j) => [j.kind, iso(j.starts_at)]), [['changed', iso(await londonAt(7, '11:00'))]]);
});

test('an unpaid online booking that has already started is left for the owner, not released', async () => {
  await db.query(`update public.settings set auto_cancel_unpaid = true where id = 1`);
  const started = await diaryAppt(new Date(Date.now() - 5 * 60e3), { status: 'pending_deposit' });
  const upcoming = await diaryAppt(await londonAt(3, '10:00'), { email: 'b@example.com', status: 'pending_deposit' });
  await db.query(`update public.appointments set source = 'online', deposit_required_pence = 1000,
                         deposit_due_at = now() - interval '10 minutes' where id in ($1, $2)`, [started.id, upcoming.id]);

  const claim = await claimJobs();
  assert.equal((await appt(started.reference)).status, 'pending_deposit', 'she settles that one in person');
  assert.equal((await appt(upcoming.reference)).status, 'cancelled');
  assert.deepEqual(claim.jobs.map((j) => `${j.kind} ${j.to}`), ['cancelled b@example.com']);
  // She can still complete it.
  await asOwner(`select public.owner_complete_appointment($1, 1500, 'cash', 0, null)`, [started.id]);
  assert.equal((await appt(started.reference)).status, 'completed');
});

test('a deposit chase ticked off on the reminders list doesn’t count as the reminder once the deposit is in', async () => {
  const svc = await addService();
  const r = await book(svc, await londonAt(3, '10:00'));
  const a = await appt(r.reference);
  await asOwner(`update public.appointments set whatsapp_reminder_sent_at = now() where id = $1`, [a.id]);
  await asOwner(`select public.owner_mark_deposit_paid($1, 'bank_transfer')`, [a.id]);
  const paid = await appt(r.reference);
  assert.deepEqual([paid.status, paid.whatsapp_reminder_sent_at], ['confirmed', null]);
});
