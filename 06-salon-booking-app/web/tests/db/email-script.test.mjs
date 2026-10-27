// Runs the real Google Apps Script (apps-script/Code.gs) in Node against the
// real database schema, with Google's services (UrlFetchApp, MailApp, …)
// replaced by stand-ins. Proves the script and the database agree on the
// shape of the email jobs, and checks what clients would actually receive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import vm from 'node:vm';
import pg from 'pg';
import { formatInTimeZone } from 'date-fns-tz';
import { enGB } from 'date-fns/locale';

const here = new URL('.', import.meta.url);
const SHIM = await readFile(new URL('../../../supabase/test/supabase-shim.sql', here), 'utf8');
const SCHEMA = await readFile(new URL('../../../supabase/schema.sql', here), 'utf8');
const SCRIPT = await readFile(new URL('../../../apps-script/Code.gs', here), 'utf8');
const DB = `booking_email_test_${process.pid}`;
const conn = { host: process.env.PGHOST || '/var/run/postgresql', user: process.env.PGUSER || userInfo().username };
const SECRET = 'script-secret-123';

let admin, db;
before(async () => {
  admin = new pg.Client({ ...conn, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  db = new pg.Client({ ...conn, database: DB });
  await db.connect();
  await db.query(SHIM);
  await db.query(SCHEMA);
  await db.query(`
    update public.settings set business_name = 'Test <Studio>', owner_email = 'owner@example.com',
      owner_phone = '07700 900000', address = '1 Example Road', public_site_url = 'https://book.example.com',
      bank_account_name = 'T Studio', bank_sort_code = '00-00-00', bank_account_number = '12345678',
      cancellation_policy = '24 hours notice please', min_notice_hours = 12,
      email_secret_hash = '${createHash('sha256').update(SECRET).digest('hex')}' where id = 1;
    update public.opening_hours set is_open = true, open_time = '09:00', close_time = '18:00';
    insert into public.services (name, duration_min, price_pence) values ('BIAB new set', 75, 3500);
  `);
});
after(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${DB}`);
  await admin?.end();
});

async function asAnon(sql, params) {
  await db.query('begin');
  try {
    await db.query('set local role anon');
    const r = await db.query(sql, params);
    await db.query('commit');
    return r;
  } catch (e) { await db.query('rollback'); throw e; }
}

/** Load Code.gs with stand-ins for Google's services. fetchQueue answers each UrlFetchApp call in order. */
function loadScript({ fetchQueue, props, quota = 100 }) {
  const sent = [];
  const calls = [];
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null,
      setProperty: (k, v) => { props[k] = v; },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.payload), headers: opts.headers });
        const next = fetchQueue.shift();
        return { getResponseCode: () => next.code ?? 200, getContentText: () => JSON.stringify(next.body) };
      },
    },
    MailApp: {
      sendEmail: (to, subject, text, options) => sent.push({ to, subject, text, html: options.htmlBody, ...options }),
      getRemainingDailyQuota: () => quota,
    },
    Utilities: { formatDate: (d, tz, pattern) => formatInTimeZone(d, tz, pattern, { locale: enGB }), sleep: () => {} },
    Session: {
      getActiveUser: () => ({ getEmail: () => 'owner@example.com' }),
      getEffectiveUser: () => ({ getEmail: () => 'studio@gmail.example' }),
    },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
    Logger: { log: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  return { sandbox, sent, calls };
}

const PROPS = { SUPABASE_URL: 'https://abcdefghijkl.supabase.co', SUPABASE_ANON_KEY: 'anon-key', EMAIL_SECRET: SECRET };

test('the script sends exactly what the database hands over, and reports back', async () => {
  const start = (await db.query(
    `select ((((now() at time zone 'Europe/London')::date + 3) + time '10:00') at time zone 'Europe/London') as t`)).rows[0].t;
  const svc = (await db.query(`select id from public.services`)).rows[0].id;
  await asAnon(`select public.public_create_booking($1, $2, 'Jess & Co Example', 'jess@example.com', '07700900123', '<script>alert(1)</script>', p_policy_accepted => true)`,
    [svc, start]);

  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  assert.equal(claim.jobs.length, 2);

  const { sandbox, sent, calls } = loadScript({ fetchQueue: [{ body: claim }, { body: 2 }], props: PROPS });
  const n = sandbox.processEmails();
  assert.equal(n, 2);

  // It called the right endpoints with the key and the secret.
  assert.equal(calls[0].url, 'https://abcdefghijkl.supabase.co/rest/v1/rpc/email_jobs_claim');
  assert.equal(calls[0].headers.apikey, 'anon-key');
  assert.deepEqual(calls[0].body, { p_secret: SECRET, p_limit: 50 });
  assert.equal(calls[1].url, 'https://abcdefghijkl.supabase.co/rest/v1/rpc/email_jobs_report');

  const client = sent.find((m) => m.to === 'jess@example.com');
  assert.match(client.subject, /Please pay your deposit/);
  assert.equal(client.replyTo, 'owner@example.com');
  assert.match(client.html, /£10 deposit/);
  for (const bit of ['12345678', '00-00-00', 'T Studio', claim.jobs[0].reference, 'https://book.example.com/form/']) {
    assert.ok(client.html.includes(bit), `email is missing ${bit}`);
    assert.ok(client.text.includes(bit), `plain-text email is missing ${bit}`);
  }
  assert.ok(!client.html.includes('Jess & Co'), 'client-typed text must be HTML-escaped');
  assert.ok(client.html.includes('Test &lt;Studio&gt;'));
  assert.ok(!/<(p|table|tr|td|div|a|br)[\s>/]/i.test(client.text), 'plain text has no markup');
  assert.ok(client.text.includes('Sort code: 00-00-00'), 'plain text keeps label: value rows');

  const owner = sent.find((m) => m.to === 'owner@example.com');
  assert.match(owner.subject, /^New booking: Jess & Co Example — BIAB new set/);
  assert.ok(owner.html.includes('Jess &amp; Co Example'));
  assert.ok(!owner.html.includes('<script>'), 'the client note is escaped in the owner alert');
  assert.ok(owner.html.includes('&lt;script&gt;'));
  assert.equal(owner.replyTo, 'jess@example.com', 'the owner can reply straight to the client');

  // Feed the script's report back to the real database.
  const report = calls[1].body;
  assert.equal(report.p_secret, SECRET);
  assert.equal(report.p_results.length, 2);
  assert.ok(report.p_results.every((r) => r.ok === true));
  await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(report.p_results)]);
  const statuses = (await db.query(`select status from public.email_outbox`)).rows.map((r) => r.status);
  assert.deepEqual(statuses, ['sent', 'sent']);
});

test('a failed send is reported as failed, not lost', async () => {
  const claim = { settings: { business_name: 'X', timezone: 'Europe/London' }, jobs: [{
    id: 99, kind: 'reminder', to: 'x@example.com', first_name: 'X', service_name: 'Gel', price_pence: 2500,
    starts_at: new Date().toISOString(), reference: 'ABCDEF', status: 'confirmed', form_needed: false,
  }] };
  const { sandbox, calls } = loadScript({ fetchQueue: [{ body: claim }, { body: 1 }], props: PROPS });
  sandbox.MailApp.sendEmail = () => { throw new Error('Service invoked too many times for one day: email.'); };
  assert.equal(sandbox.processEmails(), 0);
  assert.deepEqual(calls[1].body.p_results, [{ id: 99, ok: false, error: 'Service invoked too many times for one day: email.' }]);
});

test('every kind of email renders, with a subject and both versions', async () => {
  const base = {
    id: 1, to: 'a@example.com', first_name: 'Amy', client_name: 'Amy Example', service_name: 'Gel', price_pence: 2500,
    starts_at: '2026-06-10T09:30:00Z', reference: 'ABCDEF', deposit_required_pence: 1000, form_needed: false,
  };
  const s = { business_name: 'Studio', timezone: 'Europe/London', address: '1 Road', public_site_url: 'https://x.example' };
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const cases = [
    [{ kind: 'booking_received', status: 'confirmed' }, /You’re booked in: Gel, Wed 10 Jun/],
    [{ kind: 'booking_received', status: 'pending_deposit' }, /deposit/],
    [{ kind: 'deposit_received', status: 'confirmed' }, /Deposit received/],
    [{ kind: 'reminder', status: 'confirmed' }, /Reminder: Gel on Wednesday at 10:30/],
    [{ kind: 'cancelled', status: 'cancelled', cancel_reason: 'Unwell' }, /cancelled/],
    [{ kind: 'changed', status: 'confirmed' }, /^Your booking has changed: Gel, Wed 10 Jun$/],
    [{ kind: 'owner_new_booking', status: 'confirmed' }, /New booking: Amy Example/],
    [{ kind: 'owner_changed', status: 'confirmed', changes: [] }, /^Booking changed: Amy Example — Gel, Wed 10 Jun 10:30$/],
    [{ kind: 'owner_cancelled', status: 'cancelled' }, /^Cancelled: Amy Example — Gel, Wed 10 Jun 10:30$/],
  ];
  for (const [extra, subject] of cases) {
    const m = sandbox.render_({ ...base, ...extra }, s);
    assert.match(m.subject, subject);
    assert.ok(m.html.length > 100 && m.text.length > 20);
  }
  assert.throws(() => sandbox.render_({ ...base, kind: 'nope' }, s), /Unknown email kind/);
});

test('the script refuses to run with missing or wrong settings', async () => {
  const bad = loadScript({ fetchQueue: [], props: { ...PROPS, SUPABASE_URL: 'http://evil.example.com' } });
  assert.throws(() => bad.sandbox.processEmails(), /SUPABASE_URL/);
  const noSecret = loadScript({ fetchQueue: [], props: { ...PROPS, EMAIL_SECRET: '' } });
  assert.throws(() => noSecret.sandbox.processEmails(), /EMAIL_SECRET/);
  const refused = loadScript({ fetchQueue: [{ code: 400, body: { message: 'unauthorized' } }], props: PROPS });
  assert.throws(() => refused.sandbox.processEmails(), /refused the EMAIL_SECRET/);
});

test('if the "sent" report is lost, the next run reports instead of sending twice', async () => {
  const job = { id: 7, kind: 'reminder', to: 'x@example.com', first_name: 'X', service_name: 'Gel', price_pence: 2500,
    starts_at: new Date().toISOString(), reference: 'ABCDEF', status: 'confirmed', form_needed: false };
  const claim = { settings: { business_name: 'X', timezone: 'Europe/London' }, jobs: [job] };
  const props = { ...PROPS };
  // Run 1: sends, then every report attempt fails.
  const run1 = loadScript({ fetchQueue: [{ body: claim }, { code: 503, body: 'down' }, { code: 503, body: 'down' }, { code: 503, body: 'down' }], props });
  assert.throws(() => run1.sandbox.processEmails(), /email_jobs_report failed/);
  assert.equal(run1.sent.length, 1);
  // Run 2: the database hands the same job out again (still "sending").
  const run2 = loadScript({ fetchQueue: [{ body: claim }, { body: 1 }], props });
  assert.equal(run2.sandbox.processEmails(), 0);
  assert.equal(run2.sent.length, 0, 'not sent a second time');
  assert.deepEqual(run2.calls[1].body.p_results, [{ id: 7, ok: true }]);
  assert.equal(props.SENT_UNREPORTED, '{}');
});

test('asks only for as many emails as Gmail will still send today, and uses the right key header', async () => {
  const { sandbox, calls } = loadScript({ fetchQueue: [{ body: { settings: {}, jobs: [] } }], props: { ...PROPS, SUPABASE_ANON_KEY: 'sb_publishable_abc' }, quota: 3 });
  sandbox.processEmails();
  assert.equal(calls[0].body.p_limit, 3);
  assert.deepEqual({ ...calls[0].headers }, { apikey: 'sb_publishable_abc' });
  const legacy = loadScript({ fetchQueue: [{ body: { settings: {}, jobs: [] } }], props: { ...PROPS, SUPABASE_ANON_KEY: 'eyJhbGciOi.x.y' } });
  legacy.sandbox.processEmails();
  assert.equal(legacy.calls[0].headers.Authorization, 'Bearer eyJhbGciOi.x.y');
});

// ---------------------------------------------------------------------------
// Changes and cancellations made by the client online
// ---------------------------------------------------------------------------

/** A London wall-clock time N days from today, as an ISO instant. */
async function londonAt(daysAhead, hhmm) {
  const r = await db.query(
    `select (((now() at time zone 'Europe/London')::date + $1::int) + $2::time) at time zone 'Europe/London' as t`,
    [daysAhead, hhmm]);
  return r.rows[0].t.toISOString();
}

/** Claim from the real database, let the script send everything, and feed its report back. */
async function sendViaScript() {
  const claim = (await asAnon(`select public.email_jobs_claim($1) as j`, [SECRET])).rows[0].j;
  const { sandbox, sent, calls } = loadScript({ fetchQueue: [{ body: claim }, { body: claim.jobs.length }], props: { ...PROPS } });
  sandbox.processEmails();
  if (calls[1]) await asAnon(`select public.email_jobs_report($1, $2)`, [SECRET, JSON.stringify(calls[1].body.p_results)]);
  return { claim, sent };
}

const london = (iso, pattern) => formatInTimeZone(new Date(iso), 'Europe/London', pattern, { locale: enGB });

test('a client’s online change: their new details to them, an alert to the owner', async () => {
  const set = (await db.query(`select id from public.services where name = 'BIAB new set'`)).rows[0].id;
  const infill = (await db.query(
    `insert into public.services (name, duration_min, price_pence) values ('BIAB infill', 60, 3000) returning id`)).rows[0].id;
  await asAnon(`select public.public_create_booking($1, $2, 'Kim & Co Example', 'kim@example.com', '07700900124', null, p_policy_accepted => true)`,
    [set, await londonAt(5, '10:00')]);
  const token = (await db.query(`select a.public_token from public.appointments a join public.clients c on c.id = a.client_id
                                  where c.email = 'kim@example.com'`)).rows[0].public_token;
  const link = `https://book.example.com/manage/${token}`;

  // The confirmation carries her own link; the owner's new-booking alert never does.
  const first = await sendViaScript();
  const confirmation = first.sent.find((m) => m.to === 'kim@example.com');
  assert.ok(confirmation.html.includes(`href="${link}"`) && confirmation.text.includes(link));
  const alert = first.sent.find((m) => m.to === 'owner@example.com');
  assert.ok(!alert.html.includes('/manage/') && !alert.text.includes('/manage/'));

  const newTime = await londonAt(6, '14:00');
  await asAnon(`select public.public_change_booking($1, $2, $3)`, [token, infill, newTime]);
  const { sent } = await sendViaScript();
  assert.equal(sent.length, 2);

  const client = sent.find((m) => m.to === 'kim@example.com');
  assert.equal(client.subject, `Your booking has changed: BIAB infill, ${london(newTime, 'EEE d MMM')}`);
  assert.equal(client.replyTo, 'owner@example.com');
  for (const bit of ['BIAB infill', london(newTime, "EEEE d MMMM 'at' HH:mm"), '£30', link, 'Change or cancel your booking',
                     '£10 deposit', 'T Studio', '00-00-00', '12345678', 'Please let us know by', '24 hours notice please']) {
    assert.ok(client.html.includes(bit) && client.text.includes(bit), `change email is missing ${bit}`);
  }
  assert.ok(!client.html.includes('1 Example Road'), 'the address waits until the deposit is in');

  const owner = sent.find((m) => m.to === 'owner@example.com');
  assert.equal(owner.subject, `Booking changed: Kim & Co Example — BIAB infill, ${london(newTime, 'EEE d MMM HH:mm')}`);
  assert.equal(owner.replyTo, 'kim@example.com', 'she can reply straight to the client');
  assert.ok(owner.html.includes('Kim &amp; Co Example') && !owner.html.includes('Kim & Co'));
  assert.ok(owner.text.includes(`- Moved from ${london(await londonAt(5, '10:00'), 'EEE d MMM HH:mm')} to ${london(newTime, 'EEE d MMM HH:mm')}, and switched from BIAB new set to BIAB infill`));
  assert.ok(!owner.html.includes('/manage/') && !owner.text.includes('/manage/'), 'the client’s link never goes to the owner');
  assert.ok(!owner.text.includes('less than'), 'plenty of notice: nothing flagged');

  const statuses = (await db.query(`select distinct o.status from public.email_outbox o join public.appointments a on a.id = o.appointment_id
                                     where a.public_token = $1`, [token])).rows.map((r) => r.status);
  assert.deepEqual(statuses, ['sent']);
});

test('a late cancellation online: a gentle note to the client, the facts to the owner', async () => {
  const c = (await db.query(`insert into public.clients (full_name, email, phone)
                             values ('Lou <i>Example</i>', 'lou@example.com', '07700 900125') returning id`)).rows[0];
  const a = (await db.query(
    `insert into public.appointments (client_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until, reference,
                                      status, deposit_required_pence, deposit_paid_at)
     values ($1, 'BIAB new set', 3500, 75, $2, $2, $2, '', 'confirmed', 1000, now()) returning *`,
    [c.id, await londonAt(1, '14:00')])).rows[0];   // tomorrow afternoon: inside the 48 hours
  const r = (await asAnon(`select public.public_cancel_booking($1, $2) as r`, [a.public_token, '<script>alert(1)</script> Sorry!'])).rows[0].r;
  assert.equal(r.late, true);
  const { sent } = await sendViaScript();
  assert.equal(sent.length, 2);

  const client = sent.find((m) => m.to === 'lou@example.com');
  assert.match(client.subject, /^Your appointment has been cancelled/);
  assert.ok(client.text.includes('as you asked, your appointment below has been cancelled.'));
  assert.ok(client.text.includes('As this was less than 48 hours before your appointment, our cancellation policy applies: 24 hours notice please'));
  assert.ok(!client.text.includes('Sorry') && !client.text.includes('Reason'), 'her own reason isn’t repeated back to her');
  assert.ok(client.text.includes('To book a new time: https://book.example.com/book'));
  assert.ok(!client.html.includes('/manage/'));
  assert.equal(client.replyTo, 'owner@example.com');

  const owner = sent.find((m) => m.to === 'owner@example.com');
  assert.match(owner.subject, /^Late cancellation: Lou <i>Example<\/i> — BIAB new set, /);
  assert.equal(owner.replyTo, 'lou@example.com');
  assert.ok(owner.html.includes('Lou &lt;i&gt;Example&lt;/i&gt;') && !owner.html.includes('<i>Example'));
  assert.ok(owner.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Sorry!') && !owner.html.includes('<script>'));
  assert.ok(owner.text.includes('Cancelled with less than 48 hours’ notice. Under your cancellation policy the full £35 is payable — ' +
    'this is for you to arrange with the client; the app doesn’t take payments.'));
  assert.ok(owner.text.includes('Deposit: £10 — paid'));
  assert.ok(owner.text.includes('They paid a £10 deposit. Whether you keep it or refund it is your call.'));
  assert.ok(!owner.html.includes('/manage/') && !owner.text.includes('/manage/'));
});

test('every client email has the change/cancel link and the cut-off; the owner’s never do', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const start = new Date(Date.now() + 5 * 86400e3);
  const freeUntil = new Date(start.getTime() - 48 * 3600e3);
  const job = {
    id: 1, to: 'a@example.com', first_name: 'Amy', client_name: 'Amy Example', client_email: 'amy@example.com',
    service_name: 'Gel', price_pence: 2500, starts_at: start.toISOString(), reference: 'ABCDEF', deposit_required_pence: 1000,
    form_needed: false, manage_url: 'https://x.example/manage/tok-123', free_until: freeUntil.toISOString(), changes: [],
  };
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example', cancel_notice_hours: 48, client_self_service: true };
  const by = `Please let us know by ${london(freeUntil, "EEEE d MMMM 'at' HH:mm")} — after that, the cancellation policy applies.`;

  for (const [kind, status] of [['booking_received', 'confirmed'], ['booking_received', 'pending_deposit'], ['deposit_received', 'confirmed'],
                                ['reminder', 'confirmed'], ['changed', 'confirmed'], ['changed', 'pending_deposit']]) {
    const m = sandbox.render_({ ...job, kind, status }, s);
    assert.ok(m.html.includes('Need to change or cancel? You can do it online: <a href="https://x.example/manage/tok-123"'), `${kind}/${status}`);
    assert.ok(m.text.includes('Change or cancel your booking (https://x.example/manage/tok-123)'), `${kind}/${status} plain text`);
    assert.ok(m.text.includes(by), `${kind}/${status} has the cut-off`);
  }
  for (const kind of ['owner_new_booking', 'owner_changed', 'owner_cancelled', 'cancelled']) {
    const m = sandbox.render_({ ...job, kind, status: kind.endsWith('cancelled') ? 'cancelled' : 'confirmed' }, s);
    assert.ok(!m.html.includes('tok-123') && !m.text.includes('tok-123'), `${kind} must not carry the client’s link`);
    assert.ok(!m.text.includes('Need to change or cancel'), kind);
  }

  // Past the cut-off, it isn't offered as a deadline any more.
  const past = sandbox.render_({ ...job, kind: 'reminder', status: 'confirmed', free_until: new Date(Date.now() - 3600e3).toISOString() }, s);
  assert.ok(past.text.includes('You can do it online') && !past.text.includes('Please let us know by'));
  // Online changes switched off: no link, but still the time to get in touch by.
  const off = sandbox.render_({ ...job, kind: 'reminder', status: 'confirmed' }, { ...s, client_self_service: false });
  assert.ok(!off.html.includes('tok-123'));
  assert.ok(off.text.includes('Need to change or cancel? Just get in touch.') && off.text.includes(by));
  // Only ever an https link.
  for (const bad of ['http://x.example/manage/tok-123', 'javascript:alert(1)']) {
    const m = sandbox.render_({ ...job, kind: 'reminder', status: 'confirmed', manage_url: bad }, s);
    assert.ok(!m.html.includes('tok-123') && !m.html.includes('javascript:') && !m.text.includes('You can do it online'), bad);
  }
  // Neither a link nor a cut-off: nothing at all.
  const none = sandbox.render_({ ...job, kind: 'reminder', status: 'confirmed', manage_url: null, free_until: null }, s);
  assert.ok(!none.text.includes('Need to change or cancel'));
});

test('the change email repeats the bank details only while a deposit is owed', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const start = new Date(Date.now() + 5 * 86400e3);
  const due = new Date(Date.now() + 86400e3);
  const job = {
    id: 1, kind: 'changed', to: 'a@example.com', first_name: '<b>Amy</b>', service_name: 'Gel', price_pence: 2500,
    starts_at: start.toISOString(), reference: 'ABCDEF', deposit_required_pence: 1000, deposit_due_at: due.toISOString(),
    form_needed: true, form_url: 'https://x.example/form/tok-123', manage_url: 'https://x.example/manage/tok-123',
    free_until: new Date(start.getTime() - 48 * 3600e3).toISOString(),
  };
  const s = {
    business_name: 'Studio', timezone: 'Europe/London', address: '1 Example Road', public_site_url: 'https://x.example',
    bank_account_name: 'T Studio', bank_sort_code: '00-00-00', bank_account_number: '12345678', owner_phone: '07700 900000',
    cancellation_policy: '48 hours’ notice please', cancel_notice_hours: 48, client_self_service: true,
  };

  const owing = sandbox.render_({ ...job, status: 'pending_deposit', deposit_paid: false }, s);
  assert.equal(owing.subject, `Your booking has changed: Gel, ${london(start, 'EEE d MMM')}`);
  for (const bit of ['Your appointment is still reserved', '£10 deposit', `by ${london(due, "HH:mm 'on' EEEE d MMMM")}`,
                     'Account name: T Studio', 'Sort code: 00-00-00', 'Account number: 12345678', 'Please use the reference ABCDEF']) {
    assert.ok(owing.text.includes(bit), `missing ${bit}`);
  }
  assert.ok(!owing.text.includes('1 Example Road'), 'no address until it’s confirmed');
  // In order: the new details, the deposit, the form, the link, the policy, then how to get in touch.
  const at = (t) => owing.text.indexOf(t);
  const order = ['Treatment: Gel', 'Account number', 'consultation form', 'Need to change or cancel', 'Cancellations:', 'Questions?'];
  order.forEach((t) => assert.ok(at(t) >= 0, `missing ${t}`));
  assert.deepEqual([...order].sort((x, y) => at(x) - at(y)), order);
  assert.ok(owing.html.includes('Hi &lt;b&gt;Amy&lt;/b&gt;') && !owing.html.includes('<b>Amy'));

  const confirmed = sandbox.render_({ ...job, status: 'confirmed', deposit_paid: true }, s);
  assert.ok(!confirmed.text.includes('12345678') && !confirmed.text.includes('deposit'));
  assert.ok(confirmed.text.includes('Where: 1 Example Road'));

  // A deadline already gone by isn't repeated back.
  const overdue = sandbox.render_({ ...job, status: 'pending_deposit', deposit_due_at: new Date(Date.now() - 3600e3).toISOString() }, s);
  assert.ok(overdue.text.includes('by bank transfer as soon as you can'));
});

test('the cancellation email depends on who cancelled', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example',
    cancellation_policy: 'Full price if under 24 hours’ notice.', cancel_notice_hours: 24 };
  const job = { id: 1, kind: 'cancelled', status: 'cancelled', first_name: 'Amy', service_name: 'Gel', price_pence: 2500,
    starts_at: '2026-11-12T14:00:00Z', reference: 'ABCDEF', cancel_reason: 'Running late <again>' };

  const late = sandbox.render_({ ...job, cancelled_by: 'client', cancelled_late: true }, s);
  assert.ok(late.text.includes('Hi Amy, as you asked, your appointment below has been cancelled.'));
  assert.ok(late.text.includes('As this was less than 24 hours before your appointment, our cancellation policy applies: Full price if under 24 hours’ notice.'));
  assert.ok(!late.text.includes('Reason') && !late.text.includes('Running late'), 'her own reason isn’t repeated back');
  const inTime = sandbox.render_({ ...job, cancelled_by: 'client', cancelled_late: false }, s);
  assert.ok(inTime.text.includes('as you asked') && !inTime.text.includes('policy applies'));
  const noPolicy = sandbox.render_({ ...job, cancelled_by: 'client', cancelled_late: true }, { ...s, cancellation_policy: null });
  assert.ok(noPolicy.text.includes('our cancellation policy applies.'));
  // Late because they changed it inside the notice period earlier, though they cancelled before the cut-off
  // (Thursday 14:00 less 24 hours).
  const free = { free_until: '2026-11-11T14:00:00Z', late_fee_pence: 2500 };
  const earlier = sandbox.render_({ ...job, ...free, cancelled_by: 'client', cancelled_late: true, cancelled_at: '2026-11-09T10:00:00Z' }, s);
  assert.ok(earlier.text.includes('As you changed this booking with less than 24 hours’ notice, our cancellation policy applies: ' +
    'Full price if under 24 hours’ notice.'));
  assert.ok(!earlier.text.includes('As this was less than'));
  // Cancelled after the cut-off: the usual wording.
  const after = sandbox.render_({ ...job, ...free, cancelled_by: 'client', cancelled_late: true, cancelled_at: '2026-11-12T10:00:00Z' }, s);
  assert.ok(after.text.includes('As this was less than 24 hours before your appointment') && !after.text.includes('As you changed'));

  for (const by of ['owner', 'system', null]) {
    const m = sandbox.render_({ ...job, cancelled_by: by }, s);
    assert.ok(m.text.includes('Hi Amy, your appointment below has been cancelled.'), String(by));
    assert.ok(m.text.includes('Reason: Running late <again>') && m.html.includes('Running late &lt;again&gt;'), String(by));
    assert.ok(!m.text.includes('as you asked') && !m.text.includes('policy applies'), String(by));
  }
  for (const m of [late, inTime]) assert.ok(m.text.includes('To book a new time: https://x.example/book'));
  // She cancelled it for them (they told her late, by phone or WhatsApp) and ticked "late".
  const ownerLate = sandbox.render_({ ...job, cancelled_by: 'owner', cancelled_late: true }, s);
  assert.ok(ownerLate.text.includes('Reason: Running late <again>'));
  assert.ok(ownerLate.text.includes('As this was less than 24 hours before your appointment, our cancellation policy applies'));
});

test('the owner’s change alert lists what changed, and flags a late change', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example', cancel_notice_hours: 48 };
  const job = {
    id: 1, kind: 'owner_changed', status: 'confirmed', to: 'owner@example.com', client_name: 'Amy <Example>', booking_name: 'Amy <Example>',
    client_phone: '07700 900123', client_email: 'amy@example.com', service_name: 'BIAB infill', price_pence: 3500,
    starts_at: '2026-11-12T14:00:00Z', reference: 'ABCDEF', deposit_required_pence: 0, manage_url: 'https://x.example/manage/tok-123',
    changes: [
      { at: '2026-11-09T18:05:00Z', action: 'moved', old_starts_at: '2026-11-10T10:00:00Z', new_starts_at: '2026-11-12T14:00:00Z',
        old_service_name: 'Gel <polish>', new_service_name: 'Gel <polish>', late: true },
      { at: '2026-11-09T18:07:00Z', action: 'treatment', old_starts_at: '2026-11-12T14:00:00Z', new_starts_at: '2026-11-12T14:00:00Z',
        old_service_name: 'Gel <polish>', new_service_name: 'BIAB infill', late: false },
    ],
  };
  const m = sandbox.render_(job, s);
  assert.equal(m.subject, 'Booking changed: Amy <Example> — BIAB infill, Thu 12 Nov 14:00');
  for (const line of ['Client: Amy <Example>', 'Mobile: 07700 900123', 'Email: amy@example.com', 'Treatment: BIAB infill',
                      'When: Thursday 12 November at 14:00', 'Price: £35', 'Reference: ABCDEF', 'Status: Confirmed',
                      'Changed with less than 48 hours’ notice.',
                      '- Moved from Tue 10 Nov 10:00 to Thu 12 Nov 14:00 (less than 48 hours’ notice) · changed Mon 9 Nov at 18:05',
                      '- Switched from Gel <polish> to BIAB infill · changed Mon 9 Nov at 18:07',
                      'Open your diary (https://x.example/)']) {
    assert.ok(m.text.includes(line), `missing: ${line}`);
  }
  assert.ok(m.html.includes('Gel &lt;polish&gt;') && !m.html.includes('<polish>') && !m.html.includes('<Example>'));
  assert.ok(!m.text.includes('Booked as'), 'the same name isn’t repeated');
  assert.ok(!m.text.includes('tok-123'));

  const inTime = sandbox.render_({ ...job, changes: [{ ...job.changes[0], late: false }, job.changes[1]] }, s);
  assert.ok(!inTime.text.includes('less than'));
  // Switching treatment inside the notice period counts too, and isn't called a move.
  const switchedLate = sandbox.render_({ ...job, changes: [{ ...job.changes[1], late: true }] }, s);
  assert.ok(switchedLate.text.includes('Changed with less than 48 hours’ notice.') && !switchedLate.text.includes('Moved'));
  assert.ok(switchedLate.text.includes('- Switched from Gel <polish> to BIAB infill (less than 48 hours’ notice)'));
  const both = sandbox.render_({ ...job, status: 'pending_deposit', deposit_required_pence: 1000,
    changes: [{ ...job.changes[0], action: 'moved_treatment', new_service_name: 'BIAB infill', late: false }] }, s);
  assert.ok(both.text.includes('Status: Waiting for £10 deposit'));
  assert.ok(both.text.includes('- Moved from Tue 10 Nov 10:00 to Thu 12 Nov 14:00, and switched from Gel <polish> to BIAB infill'));
  // London time on both sides of a clock change (the clocks go forward on Sunday 28 March 2027).
  const dst = sandbox.render_({ ...job, starts_at: '2027-03-29T09:00:00Z', changes: [{ ...job.changes[0],
    at: '2027-03-25T12:00:00Z', old_starts_at: '2027-03-26T10:00:00Z', new_starts_at: '2027-03-29T09:00:00Z' }] }, s);
  assert.ok(dst.text.includes('When: Monday 29 March at 10:00'));
  assert.ok(dst.text.includes('- Moved from Fri 26 Mar 10:00 to Mon 29 Mar 10:00'));
});

test('the owner’s cancellation alert: in time, late, and what happened to the deposit', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example', cancel_notice_hours: 48 };
  const job = {
    id: 1, kind: 'owner_cancelled', status: 'cancelled', to: 'owner@example.com', client_name: 'Amy Example', client_phone: '07700 900123',
    client_email: 'amy@example.com', service_name: 'Gel', price_pence: 2500, starts_at: '2026-11-12T14:00:00Z', reference: 'ABCDEF',
    deposit_required_pence: 0, deposit_paid: false, cancelled_by: 'client', cancelled_late: false, cancel_reason: null,
    manage_url: 'https://x.example/manage/tok-123', changes: [],
  };

  const inTime = sandbox.render_(job, s);
  assert.equal(inTime.subject, 'Cancelled: Amy Example — Gel, Thu 12 Nov 14:00');
  for (const line of ['Client: Amy Example', 'Mobile: 07700 900123', 'Email: amy@example.com', 'Treatment: Gel',
                      'Was: Thursday 12 November at 14:00', 'Price: £25', 'Reference: ABCDEF', 'Deposit: None']) {
    assert.ok(inTime.text.includes(line), `missing: ${line}`);
  }
  for (const not of ['payable', 'Their reason', 'refund', 'tok-123', 'Earlier']) assert.ok(!inTime.text.includes(not), not);
  const unpaid = sandbox.render_({ ...job, deposit_required_pence: 1000 }, s);
  assert.ok(unpaid.text.includes('Deposit: £10 — not paid') && !unpaid.text.includes('refund'));

  const late = sandbox.render_({ ...job, cancelled_late: true, deposit_required_pence: 1000, deposit_paid: true, cancel_reason: 'Flu' }, s);
  assert.equal(late.subject, 'Late cancellation: Amy Example — Gel, Thu 12 Nov 14:00');
  for (const line of ['Cancelled with less than 48 hours’ notice. Under your cancellation policy the full £25 is payable — ' +
                        'this is for you to arrange with the client; the app doesn’t take payments.',
                      'Deposit: £10 — paid', 'Their reason: Flu', 'They paid a £10 deposit. Whether you keep it or refund it is your call.']) {
    assert.ok(late.text.includes(line), `missing: ${line}`);
  }
  // Changed late earlier, but the cancellation wasn't counted as late (a booking from
  // before that rule): still worth knowing about.
  const changes = [
    { at: '2026-11-09T18:05:00Z', action: 'moved', old_starts_at: '2026-11-10T10:00:00Z', new_starts_at: '2026-11-12T14:00:00Z', late: true },
    { at: '2026-11-09T18:09:00Z', action: 'cancelled', old_starts_at: '2026-11-12T14:00:00Z', late: false }];
  const movedLate = sandbox.render_({ ...job, changes }, s);
  assert.ok(movedLate.text.includes('Earlier, they changed this booking with less than 48 hours’ notice.'));
  assert.ok(!movedLate.text.includes('payable'));
});

test('the owner’s cancellation alert charges the late fee, and says when it’s late because of an earlier change', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example', cancel_notice_hours: 48 };
  // Thursday 14:00, so free of charge until Tuesday 14:00.
  const job = {
    id: 1, kind: 'owner_cancelled', status: 'cancelled', to: 'owner@example.com', client_name: 'Amy Example', client_phone: '07700 900123',
    client_email: 'amy@example.com', service_name: 'File and polish', price_pence: 800, starts_at: '2026-11-12T14:00:00Z', reference: 'ABCDEF',
    free_until: '2026-11-10T14:00:00Z', deposit_required_pence: 0, deposit_paid: false, cancelled_by: 'client', cancel_reason: null,
  };
  const tail = ' is payable — this is for you to arrange with the client; the app doesn’t take payments.';

  // Switched to something cheaper inside the notice period, then cancelled: the price before the switch.
  const down = sandbox.render_({ ...job, cancelled_late: true, cancelled_at: '2026-11-11T09:00:00Z', late_fee_pence: 4500, changes: [
    { at: '2026-11-11T08:00:00Z', action: 'treatment', old_service_name: 'BIAB new set', new_service_name: 'File and polish', late: true },
    { at: '2026-11-11T09:00:00Z', action: 'cancelled', late: true }] }, s);
  assert.equal(down.subject, 'Late cancellation: Amy Example — File and polish, Thu 12 Nov 14:00');
  assert.ok(down.text.includes('Price: £8'));
  assert.ok(down.text.includes('Cancelled with less than 48 hours’ notice. Under your cancellation policy the full £45 (the price before they changed it)' + tail));
  assert.ok(!down.text.includes('the full £8') && !down.text.includes('Earlier'));

  // Changed late days ago, moved in good time since, then cancelled before the new time's cut-off.
  const earlier = { ...job, service_name: 'Gel', price_pence: 2500, cancelled_late: true, cancelled_at: '2026-11-08T09:00:00Z', late_fee_pence: 2500,
    changes: [
      { at: '2026-11-07T18:05:00Z', action: 'moved', old_starts_at: '2026-11-08T10:00:00Z', new_starts_at: '2026-11-10T10:00:00Z', late: true },
      { at: '2026-11-07T18:07:00Z', action: 'moved', old_starts_at: '2026-11-10T10:00:00Z', new_starts_at: '2026-11-12T14:00:00Z', late: false },
      { at: '2026-11-08T09:00:00Z', action: 'cancelled', old_starts_at: '2026-11-12T14:00:00Z', late: true }] };
  const m = sandbox.render_(earlier, s);
  assert.equal(m.subject, 'Late cancellation: Amy Example — Gel, Thu 12 Nov 14:00');
  assert.ok(m.text.includes('They changed this booking with less than 48 hours’ notice earlier, so this cancellation counts as late under your policy. ' +
    'The full £25' + tail));
  // One note, not two.
  for (const not of ['Cancelled with less than', 'Earlier, they', 'Under your cancellation policy']) assert.ok(!m.text.includes(not), not);
  assert.equal(m.text.split('less than 48 hours’ notice earlier').length, 2);
  // …and the price before a cheaper switch made after it.
  const cheaper = sandbox.render_({ ...earlier, service_name: 'File and polish', price_pence: 800 }, s);
  assert.ok(cheaper.text.includes('The full £25 (the price before they changed it)' + tail));

  // Cancelled inside the notice period: the usual wording, whatever happened before.
  const inside = sandbox.render_({ ...earlier, cancelled_at: '2026-11-11T09:00:00Z' }, s);
  assert.ok(inside.text.includes('Cancelled with less than 48 hours’ notice. Under your cancellation policy the full £25' + tail));
  assert.ok(!inside.text.includes('earlier, so'));
  // No fee recorded (an older booking): the price.
  const old = sandbox.render_({ ...job, cancelled_late: true, cancelled_at: '2026-11-11T09:00:00Z', late_fee_pence: null, changes: [] }, s);
  assert.ok(old.text.includes('the full £8' + tail));
});

test('a different mobile given with a booking is shown to the owner next to the one on record', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const s = { business_name: 'Studio', timezone: 'Europe/London', public_site_url: 'https://x.example', cancel_notice_hours: 48 };
  const job = {
    id: 1, kind: 'owner_new_booking', status: 'pending_deposit', to: 'owner@example.com', client_name: 'Vicky Example',
    client_phone: '07700 900666', client_email: 'vicky@example.com', booking_phone: '07700 900111', service_name: 'Gel', price_pence: 2500,
    starts_at: '2026-11-12T14:00:00Z', reference: 'ABCDEF', deposit_required_pence: 1000, changes: [],
  };
  const m = sandbox.render_(job, s);
  assert.ok(m.text.includes('Mobile: 07700 900666\nMobile given: 07700 900111 (different from their record — check before you WhatsApp)\nEmail: vicky@example.com'));
  // In her other alerts about the booking too.
  for (const kind of ['owner_changed', 'owner_cancelled']) {
    assert.ok(sandbox.render_({ ...job, kind }, s).text.includes('Mobile given: 07700 900111 (different'), kind);
  }
  assert.ok(!sandbox.render_({ ...job, booking_phone: null }, s).text.includes('Mobile given'));
  // No mobile on the record at all.
  const none = sandbox.render_({ ...job, client_phone: null }, s);
  assert.ok(none.text.includes('Mobile: —\nMobile given: 07700 900111 (not on their record — check it before you add it)'));
  // Escaped like everything else that came from the booking page.
  const odd = sandbox.render_({ ...job, booking_phone: '<b>07700</b> 900111' }, s);
  assert.ok(odd.html.includes('&lt;b&gt;07700&lt;/b&gt; 900111') && !odd.html.includes('<b>07700'));
  // Never in an email to the client.
  for (const kind of ['booking_received', 'reminder', 'changed']) {
    assert.ok(!sandbox.render_({ ...job, kind, to: 'vicky@example.com' }, s).text.includes('900111'), kind);
  }
});

test('after a late change, client emails stop offering a time to cancel free of charge', async () => {
  const { sandbox } = loadScript({ fetchQueue: [], props: PROPS });
  const start = new Date(Date.now() + 5 * 86400e3);
  const job = {
    id: 1, to: 'a@example.com', first_name: 'Amy', service_name: 'Gel', price_pence: 2500, starts_at: start.toISOString(),
    reference: 'ABCDEF', status: 'confirmed', form_needed: false, manage_url: 'https://x.example/manage/tok-123',
    free_until: new Date(start.getTime() - 48 * 3600e3).toISOString(), late_fee_pence: 2500,
  };
  const s = { business_name: 'Studio', timezone: 'Europe/London', cancel_notice_hours: 48, client_self_service: true };
  const sentence = 'As you changed this booking with less than 48 hours’ notice, the cancellation policy applies if you cancel.';
  for (const kind of ['changed', 'reminder', 'booking_received', 'deposit_received']) {
    const m = sandbox.render_({ ...job, kind }, s);
    assert.ok(m.text.includes('Change or cancel your booking (https://x.example/manage/tok-123)\n' + sentence), kind);
    assert.ok(!m.text.includes('Please let us know by'), kind);
  }
  const off = sandbox.render_({ ...job, kind: 'reminder' }, { ...s, client_self_service: false });
  assert.ok(off.text.includes('Need to change or cancel? Just get in touch.\n' + sentence));
  // No late change: the cut-off as before.
  assert.ok(sandbox.render_({ ...job, kind: 'reminder', late_fee_pence: null }, s).text.includes('Please let us know by'));
});

test('the owner’s alerts reply to the client; client emails reply to the owner', async () => {
  const base = { first_name: 'Amy', client_name: 'Amy Example', client_email: 'amy@example.com', service_name: 'Gel', price_pence: 2500,
    starts_at: new Date(Date.now() + 5 * 86400e3).toISOString(), reference: 'ABCDEF', status: 'confirmed', form_needed: false, changes: [] };
  const kinds = ['booking_received', 'deposit_received', 'reminder', 'changed', 'cancelled', 'owner_new_booking', 'owner_changed', 'owner_cancelled'];
  const jobs = kinds.map((kind, i) => ({ ...base, id: 100 + i, kind, to: kind.startsWith('owner_') ? 'owner@example.com' : 'amy@example.com' }));
  jobs.push({ ...base, id: 200, kind: 'owner_cancelled', to: 'owner@example.com', client_email: null });
  const claim = { settings: { business_name: 'Studio', timezone: 'Europe/London', owner_email: 'owner@example.com' }, jobs };
  const { sandbox, sent } = loadScript({ fetchQueue: [{ body: claim }, { body: jobs.length }], props: { ...PROPS } });
  assert.equal(sandbox.processEmails(), jobs.length);
  sent.forEach((m, i) => {
    const want = jobs[i].kind.startsWith('owner_') ? (jobs[i].client_email ?? undefined) : 'owner@example.com';
    assert.equal(m.replyTo, want, jobs[i].kind);
  });
});

test('the test email shows the 48-hour policy and the change/cancel link', () => {
  const { sandbox, sent } = loadScript({ fetchQueue: [], props: { ...PROPS } });
  sandbox.sendTestEmail();
  assert.match(sent[0].subject, /^\[TEST\] Please pay your deposit/);
  assert.ok(sent[0].text.includes('Please give at least 48 hours’ notice if you need to cancel or move your appointment.'));
  assert.ok(sent[0].text.includes('Change or cancel your booking (https://example.com/manage/test)'));
  assert.ok(sent[0].text.includes('Please let us know by'));
});

test('a returning client books with a different mobile: the owner’s alert shows both', async () => {
  const set = (await db.query(`select id from public.services where name = 'BIAB new set'`)).rows[0].id;
  await db.query(`insert into public.clients (full_name, email, phone) values ('Vicky Example', 'vicky@example.com', '07700 900666')`);
  await asAnon(`select public.public_create_booking($1, $2, 'Vicky Example', 'vicky@example.com', '07700 900111', null, p_policy_accepted => true)`,
    [set, await londonAt(7, '10:00')]);
  const { sent } = await sendViaScript();
  const owner = sent.find((m) => m.to === 'owner@example.com');
  assert.ok(owner.text.includes('Mobile: 07700 900666\nMobile given: 07700 900111 (different from their record — check before you WhatsApp)'));
  const client = sent.find((m) => m.to === 'vicky@example.com');
  assert.ok(!client.text.includes('900111') && !client.text.includes('900666'));
});

test('moved late, switched to something cheaper in good time, then cancelled days ahead: late, at the price before', async () => {
  const set = (await db.query(`select id from public.services where name = 'BIAB new set'`)).rows[0].id;
  const gel = (await db.query(`insert into public.services (name, duration_min, price_pence) values ('Gel polish', 45, 2500) returning id`)).rows[0].id;
  const c = (await db.query(`insert into public.clients (full_name, email, phone) values ('Mia Example', 'mia@example.com', '07700 900126') returning id`)).rows[0];
  const a = (await db.query(
    `insert into public.appointments (client_id, service_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until,
                                      reference, status)
     values ($1, $2, 'BIAB new set', 3500, 75, $3, $3, $3, '', 'confirmed') returning *`,
    [c.id, set, await londonAt(1, '16:00')])).rows[0];   // tomorrow afternoon: inside the 48 hours
  const later = await londonAt(9, '10:00');

  // The late move: both sides are told the cancellation policy now applies whenever she cancels.
  assert.equal((await asAnon(`select public.public_change_booking($1, null, $2) as r`, [a.public_token, later])).rows[0].r.late, true);
  let { sent } = await sendViaScript();
  const changed = sent.find((m) => m.to === 'mia@example.com');
  assert.ok(changed.text.includes('As you changed this booking with less than 48 hours’ notice, the cancellation policy applies if you cancel.'));
  assert.ok(!changed.text.includes('Please let us know by'), 'no free-cancellation time is offered any more');
  const alert = sent.find((m) => m.to === 'owner@example.com');
  assert.ok(alert.text.includes('Changed with less than 48 hours’ notice.'));

  // Switched to something cheaper in good time, then cancelled a week ahead.
  assert.equal((await asAnon(`select public.public_change_booking($1, $2, null) as r`, [a.public_token, gel])).rows[0].r.late, false);
  assert.deepEqual((await asAnon(`select public.public_cancel_booking($1, 'Sorry') as r`, [a.public_token])).rows[0].r, { cancelled: true, late: true });
  ({ sent } = await sendViaScript());
  assert.deepEqual(sent.map((m) => m.to).sort(), ['mia@example.com', 'owner@example.com'], 'the waiting change notices were dropped');

  const owner = sent.find((m) => m.to === 'owner@example.com');
  assert.equal(owner.subject, `Late cancellation: Mia Example — Gel polish, ${london(later, 'EEE d MMM HH:mm')}`);
  assert.ok(owner.text.includes('Price: £25'));
  assert.ok(owner.text.includes('They changed this booking with less than 48 hours’ notice earlier, so this cancellation counts as late under your policy. ' +
    'The full £35 (the price before they changed it) is payable — this is for you to arrange with the client; the app doesn’t take payments.'));
  assert.ok(!owner.text.includes('Cancelled with less than') && !owner.text.includes('Earlier, they'));

  const client = sent.find((m) => m.to === 'mia@example.com');
  assert.ok(client.text.includes('As you changed this booking with less than 48 hours’ notice, our cancellation policy applies: 24 hours notice please'));
  assert.ok(!client.text.includes('As this was less than'));
});
