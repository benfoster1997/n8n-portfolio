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
  await asAnon(`select public.public_create_booking($1, $2, 'Jess & Co Example', 'jess@example.com', '07700900123', '<script>alert(1)</script>')`,
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
    [{ kind: 'owner_new_booking', status: 'confirmed' }, /New booking: Amy Example/],
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
