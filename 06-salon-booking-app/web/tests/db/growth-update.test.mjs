// Database tests for the update an existing install runs once
// (supabase/updates/2026-11-growth.sql): where clients come from, Google reviews
// and short-notice spaces. It adds columns and gives the booking function one more,
// optional input (p_extras), whose rules are tested in booking.test.mjs.
//
//   npm run test:db        (needs a local PostgreSQL reachable as the current OS user,
//                           and the git history, for schema.sql as it was before)
//
// Each run creates throwaway databases and drops them afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import pg from 'pg';

const here = new URL('.', import.meta.url);
const APP = fileURLToPath(new URL('../../../', here));
const SHIM = await readFile(new URL('../../../supabase/test/supabase-shim.sql', here), 'utf8');
const SCHEMA = await readFile(new URL('../../../supabase/schema.sql', here), 'utf8');
const UPDATE = await readFile(new URL('../../../supabase/updates/2026-11-growth.sql', here), 'utf8');
const UNPAID_UPDATE = await readFile(new URL('../../../supabase/updates/2026-11-unpaid-limit.sql', here), 'utf8');
const conn = { host: process.env.PGHOST || '/var/run/postgresql', user: process.env.PGUSER || userInfo().username };

// main just before this update: what an existing install was set up with (with
// 2026-11-unpaid-limit.sql's booking function, the version this update expects).
const BEFORE = 'de67f2e';
// main before 2026-11-unpaid-limit.sql: an install that hasn't had that update yet.
const BEFORE_UNPAID = 'aa6282b';
function schemaAt(rev) {
  try {
    return execFileSync('git', ['show', `${rev}:./supabase/schema.sql`], { cwd: APP, encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch (e) {
    throw new Error(`These tests read schema.sql as it was at ${rev}, so they need the git history `
      + `(in a shallow copy, run git fetch --unshallow first): ${e.message}`);
  }
}
const PREVIOUS = schemaAt(BEFORE);

const OLD_FN = 'public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text, boolean)';
const FN = 'public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text, boolean, jsonb)';
/** The function's own text, as written in a .sql file. */
const fnText = (sql) => sql.match(/^create or replace function public\.public_create_booking\([\s\S]*?^end \$\$;$/m)?.[0];
/** The update's own statements, with its comments left out and spaces as one. */
const statements = (sql) => sql.replace(fnText(sql), '').replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

const NEW_COLUMNS = {
  appointments: ['link_source', 'heard_from', 'heard_from_detail', 'first_visit_said'],
  clients: ['marketing_ok_at', 'marketing_ok_note', 'review_asked_at'],
  settings: ['review_link', 'wa_template_review'],
};
const NOT_EXPECTED = 'Nothing has been changed: your booking function isn\'t the version this update expects. '
  + 'If you haven\'t run 2026-11-unpaid-limit.sql yet, run that first, then this one.';

let admin;
const made = [];
before(async () => {
  admin = new pg.Client({ ...conn, database: 'postgres' });
  await admin.connect();
});
after(async () => {
  for (const name of made) await admin.query(`drop database if exists ${name}`);
  await admin?.end();
});

/** A throwaway database set up with the given schema. */
async function install(label, schema) {
  const name = `booking_growth_${label}_${process.pid}`;
  made.push(name);
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  const c = new pg.Client({ ...conn, database: name });
  await c.connect();
  await c.query(SHIM);
  await c.query(schema);
  c.dbName = name;
  return c;
}

/** Run SQL as one of Supabase's API roles (not signed in). */
async function asAnon(c, sql, params = []) {
  await c.query('begin');
  try {
    await c.query(`set local role anon`);
    await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}

/** The booking functions there are, with their inputs, definition, owner and who can call them. */
const bookingFunctions = async (c) => (await c.query(
  `select oid::regprocedure::text as fn, pg_get_functiondef(oid) as def, proowner::regrole::text as owner, proacl::text as acl
     from pg_proc where proname = 'public_create_booking' order by 1`)).rows;

/**
 * Everything an update could change: every function (its definition, owner and who can
 * call it), the tables with their columns, checks, indexes, triggers, policies and
 * privileges, the default privileges, and every row of data.
 */
async function snapshot(c) {
  const q = async (sql) => (await c.query(sql)).rows;
  const tables = await q(`select relname, relkind, relrowsecurity, relforcerowsecurity, relacl::text as acl
                            from pg_class where relnamespace = 'public'::regnamespace order by relname`);
  const data = {};
  for (const { relname } of tables.filter((t) => t.relkind === 'r')) {
    data[relname] = (await q(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as rows from public.${relname} t`))[0].rows;
  }
  return {
    functions: await q(`select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def,
                               p.proacl::text as acl, p.proowner::regrole::text as owner
                          from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`),
    tables,
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default
                        from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
                            from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`),
    triggers: await q(`select tgrelid::regclass::text as rel, tgname, pg_get_triggerdef(oid) as def from pg_trigger
                        where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
                        order by 1, 2`),
    policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
                        where schemaname = 'public' order by 1, 2`),
    defaults: await q(`select defaclrole::regrole::text as role, defaclobjtype, defaclacl::text as acl from pg_default_acl order by 1, 2`),
    data,
  };
}
/** The install itself, without her data. */
const structure = ({ data: _data, ...rest }) => rest;

/**
 * Her data with the new columns left out, after checking that every one of them is
 * empty: the update adds columns and changes no row.
 */
function dataWithoutNewColumns(data) {
  const out = {};
  for (const [table, rows] of Object.entries(data)) {
    const extra = NEW_COLUMNS[table] ?? [];
    out[table] = rows.map((row) => {
      const kept = { ...row };
      for (const k of extra) {
        if (k in kept) {
          assert.equal(kept[k], null, `${table}.${k} starts empty`);
          delete kept[k];
        }
      }
      return kept;
    });
  }
  return out;
}

/** A diary in use: settings, opening hours, a treatment, two clients and a few bookings, a payment. */
async function seed(c) {
  await c.query(`update public.settings set business_name = 'Demo Nail Studio', owner_email = 'owner@example.com',
                        instagram_handle = 'demo.nails' where id = 1;
                 update public.opening_hours set is_open = true, open_time = '09:00', close_time = '18:00';`);
  const svc = (await c.query(`insert into public.services (name, duration_min, price_pence) values ('Gel', 30, 2500) returning id`)).rows[0].id;
  const amy = (await c.query(`insert into public.clients (full_name, email, phone, notes)
                              values ('Amy Example', 'amy@example.com', '07700 900111', 'Likes almond nails') returning id`)).rows[0].id;
  const sam = (await c.query(`insert into public.clients (full_name, email, phone) values ('Sam Example', 'sam@example.com', '07700 900222')
                              returning id`)).rows[0].id;
  const a = (await c.query(
    `insert into public.appointments (client_id, service_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until,
                                      reference, status, source, is_new_client)
     values ($1, $3, 'Gel', 2500, 30, now() - interval '7 days', now(), now(), '', 'completed', 'online', true),
            ($2, $3, 'Gel', 2500, 30, now() + interval '9 days', now(), now(), '', 'confirmed', 'owner', false)
     returning id`, [amy, sam, svc])).rows;
  await c.query(`insert into public.payments (appointment_id, client_id, client_name, description, amount_pence, method, paid_on)
                 values ($1, $2, 'Amy Example', 'Gel', 2500, 'cash', current_date - 7)`, [a[0].id, amy]);
  return svc;
}

/** A London wall-clock time N days from today. */
const londonAt = async (c, days, hhmm) => (await c.query(
  `select (((now() at time zone 'Europe/London')::date + $1::int) + $2::time) at time zone 'Europe/London' as t`, [days, hhmm])).rows[0].t;

/**
 * A booking as the app that's live now makes it until the new version is published:
 * the ten inputs it knows about, by name (PostgREST calls functions this way).
 */
async function bookAsTheLiveAppDoes(c, serviceId, email = 'jess@example.com') {
  const r = await asAnon(c,
    `select public.public_create_booking(p_service_id => $1, p_starts_at => $2, p_full_name => 'Jess Example',
       p_email => $3, p_phone => '07700 900333', p_notes => null, p_consultation => null, p_health_consent => false,
       p_signed_name => null, p_policy_accepted => true) as r`,
    [serviceId, await londonAt(c, 3, '14:00'), email]);
  return r.rows[0].r;
}

// ---------------------------------------------------------------------------

test('the update’s booking function is schema.sql’s, word for word, and it adds the same columns: nothing else', () => {
  assert.ok(fnText(SCHEMA), 'schema.sql has the function');
  assert.equal(fnText(UPDATE), fnText(SCHEMA));
  // The new input, last and optional, so a call without it still finds the function.
  assert.match(fnText(SCHEMA), /p_policy_accepted boolean default false,\s+p_extras\s+jsonb\s+default null\s+\)/);
  // Every column it adds is added in schema.sql the same way, word for word.
  const adds = statements(UPDATE).match(/alter table [^;]+;/g);
  assert.equal(adds.length, Object.values(NEW_COLUMNS).flat().length);
  const schemaStatements = statements(SCHEMA);
  for (const add of adds) {
    assert.match(add, /^alter table public\.\w+ add column if not exists \w+ /);
    assert.ok(schemaStatements.includes(add), `schema.sql has: ${add}`);
  }
  // Nothing outside the function that deletes or empties anything, and the one thing it drops
  // is the old booking function, which it replaces.
  const own = statements(UPDATE);
  assert.doesNotMatch(own, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column|policy|trigger|index)\b/i);
  assert.deepEqual(own.match(/\bdrop\s+[^;]+;/gi), [`drop function if exists ${OLD_FN};`]);
  // No begin/commit of its own: the SQL Editor runs a pasted script as one transaction,
  // so its guard can stop it before anything has changed.
  assert.doesNotMatch(own, /\b(begin|commit|rollback)\s*;/i);
  assert.match(own, /^set local lock_timeout = '5s'; do \$\$/);
  // And schema.sql drops the old version as well, so running it again leaves just the one.
  assert.ok(schemaStatements.includes(`drop function if exists ${OLD_FN};`));
  assert.ok(schemaStatements.includes(`grant execute on function ${FN} to anon, authenticated;`));
  assert.ok(!schemaStatements.includes(`grant execute on function ${OLD_FN} `));
});

test('on an install from before this version, it gives the same database as a new install, keeps her data, and a second run changes nothing', async () => {
  const fresh = await install('fresh', SCHEMA);
  const old = await install('old', PREVIOUS);
  const listener = new pg.Client({ ...conn, database: old.dbName });
  await listener.connect();
  try {
    await seed(old);
    const before = await snapshot(old);
    assert.equal((await bookingFunctions(old))[0].fn,
      'public_create_booking(uuid,timestamp with time zone,text,text,text,text,jsonb,boolean,text,boolean)');
    const notices = [];
    listener.on('notification', (n) => notices.push([n.channel, n.payload]));
    await listener.query('listen pgrst');

    await old.query(UPDATE);
    const once = await snapshot(old);
    await old.query(UPDATE);
    const twice = await snapshot(old);

    assert.deepEqual(twice, once, 'running it again changes nothing');
    // The same database as a new install, down to the booking function's definition, owner and who can call it…
    assert.deepEqual(structure(once), structure(await snapshot(fresh)));
    const [fn] = await bookingFunctions(old);
    assert.deepEqual(await bookingFunctions(old), await bookingFunctions(fresh));
    assert.equal(fn.fn, 'public_create_booking(uuid,timestamp with time zone,text,text,text,text,jsonb,boolean,text,boolean,jsonb)',
      'exactly one booking function: the new one');
    // …the new columns there with their checks…
    for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
      for (const column of columns) assert.ok(once.columns.some((x) => x.table_name === table && x.column_name === column), `${table}.${column}`);
    }
    const checks = once.constraints.filter((x) => Object.values(NEW_COLUMNS).flat().some((col) => x.conname.endsWith(`_${col}_check`)));
    assert.deepEqual(checks.map((x) => x.conname).sort(), [
      'appointments_heard_from_check', 'appointments_heard_from_detail_check', 'appointments_link_source_check',
      'clients_marketing_ok_note_check', 'settings_review_link_check', 'settings_wa_template_review_check',
    ]);
    // …and her data just as it was, with the new columns empty.
    assert.deepEqual(dataWithoutNewColumns(once.data), before.data);
    // The app's API is told to look again, so it sees the new columns and function straight away.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(notices[0], ['pgrst', 'reload schema']);
  } finally {
    await listener.end();
    await fresh.end();
    await old.end();
  }
});

test('on a new install from today’s schema.sql, it changes nothing at all', async () => {
  const c = await install('again', SCHEMA);
  try {
    await seed(c);
    const before = await snapshot(c);
    await c.query(UPDATE);
    assert.deepEqual(await snapshot(c), before);
    // Running schema.sql again leaves one booking function too.
    await c.query(SCHEMA);
    assert.equal((await bookingFunctions(c)).length, 1);
  } finally {
    await c.end();
  }
});

test('a booking function changed by hand stops it before anything changes: no columns are added', async () => {
  const c = await install('changed', PREVIOUS);
  try {
    await seed(c);
    await c.query(fnText(PREVIOUS).replace('-- Flood brake.', '-- Flood brake, changed by hand.'));
    const before = await snapshot(c);
    await assert.rejects(c.query(UPDATE), (e) => e.message === NOT_EXPECTED);
    assert.deepEqual(await snapshot(c), before);
    const added = (await c.query(`select column_name from information_schema.columns
                                   where table_schema = 'public' and column_name = any($1)`, [Object.values(NEW_COLUMNS).flat()])).rows;
    assert.deepEqual(added, []);
  } finally {
    await c.end();
  }
});

test('the same function pasted with Windows line endings is still the one it expects', async () => {
  const c = await install('crlf', PREVIOUS);
  try {
    await c.query(fnText(PREVIOUS).replace(/\n/g, '\r\n'));
    assert.match((await c.query(`select prosrc from pg_proc where oid = $1::regprocedure`, [OLD_FN])).rows[0].prosrc, /\r\n/);
    await c.query(UPDATE);
    assert.equal((await bookingFunctions(c)).map((f) => f.fn).join(),
      'public_create_booking(uuid,timestamp with time zone,text,text,text,text,jsonb,boolean,text,boolean,jsonb)');
  } finally {
    await c.end();
  }
});

test('an install that hasn’t had 2026-11-unpaid-limit.sql is asked to run it first; then this one runs', async () => {
  const fresh = await install('fresh2', SCHEMA);
  const c = await install('older', schemaAt(BEFORE_UNPAID));
  try {
    await seed(c);
    const before = await snapshot(c);
    await assert.rejects(c.query(UPDATE), (e) => e.message === NOT_EXPECTED);
    assert.deepEqual(await snapshot(c), before);
    await c.query(UNPAID_UPDATE);
    await c.query(UPDATE);
    assert.deepEqual(await bookingFunctions(c), await bookingFunctions(fresh));
  } finally {
    await fresh.end();
    await c.end();
  }
});

test('while the live app is busy with a table, it gives up after 5 seconds and changes nothing', async () => {
  const c = await install('busy', PREVIOUS);
  const app = new pg.Client({ ...conn, database: c.dbName });
  await app.connect();
  try {
    await seed(c);
    const before = await snapshot(c);
    // A long request still reading the diary.
    await app.query('begin');
    await app.query('select count(*) from public.appointments');
    const started = Date.now();
    await assert.rejects(c.query(UPDATE), (e) => e.code === '55P03' && /lock timeout/.test(e.message));
    assert.ok(Date.now() - started < 10_000);
    await app.query('rollback');
    assert.deepEqual(await snapshot(c), before);
    // Run again once it's quiet, it goes through.
    await c.query(UPDATE);
    assert.equal((await bookingFunctions(c)).length, 1);
  } finally {
    await app.end();
    await c.end();
  }
});

test('after the update, the live app’s bookings (the ten inputs, by name) still go through, and the public key still sees no table', async () => {
  const c = await install('live', PREVIOUS);
  try {
    const svc = await seed(c);
    await c.query(UPDATE);
    const r = await bookAsTheLiveAppDoes(c, svc);
    assert.deepEqual(Object.keys(r).sort(), ['reference', 'starts_at']);
    const a = (await c.query(`select * from public.appointments where reference = $1`, [r.reference])).rows[0];
    assert.equal(a.status, 'pending_deposit');
    assert.deepEqual([a.link_source, a.heard_from, a.heard_from_detail, a.first_visit_said], [null, null, null, null]);
    // The old ten-input version is gone, so there's no choosing between two.
    assert.equal((await c.query(`select to_regprocedure($1) as f`, [OLD_FN])).rows[0].f, null);
    // The booking page can call it, as before; it still can't read the tables.
    const may = async (role) => (await c.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, FN])).rows[0].ok;
    assert.deepEqual([await may('anon'), await may('authenticated')], [true, true]);
    for (const sql of ['select * from public.appointments', 'select * from public.clients', 'select link_source from public.appointments',
      'select marketing_ok_at from public.clients', 'select review_link from public.settings']) {
      await assert.rejects(asAnon(c, sql), /permission denied/, sql);
    }
    // And the new version of the app's bookings, with the answers, are kept.
    const r2 = await asAnon(c,
      `select public.public_create_booking(p_service_id => $1, p_starts_at => $2, p_full_name => 'Amy Example',
         p_email => 'amy.new@example.com', p_phone => '07700 900444', p_policy_accepted => true,
         p_extras => '{"link_source": "instagram", "heard_from": "friend", "heard_from_detail": "Sam", "first_visit": true}') as r`,
      [svc, await londonAt(c, 4, '10:00')]);
    const b = (await c.query(`select * from public.appointments where reference = $1`, [r2.rows[0].r.reference])).rows[0];
    assert.deepEqual([b.link_source, b.heard_from, b.heard_from_detail, b.first_visit_said], ['instagram', 'friend', 'Sam', true]);
  } finally {
    await c.end();
  }
});

test('the new columns are checked: a Google review link, short notes, and only the answers there are', async () => {
  const c = await install('checks', PREVIOUS);
  try {
    await seed(c);
    await c.query(UPDATE);
    const bad = [
      ['settings', 'review_link', 'http://g.page/r/demo'], ['settings', 'review_link', 'https://g.page/r/demo studio'],
      ['settings', 'review_link', 'g.page/r/demo'], ['settings', 'review_link', 'https://'],
      ['settings', 'review_link', `https://${'x'.repeat(291)}`], ['settings', 'wa_template_review', 'x'.repeat(1001)],
      ['clients', 'marketing_ok_note', 'x'.repeat(101)],
      ['appointments', 'link_source', 'Instagram'], ['appointments', 'link_source', 'free times'],
      ['appointments', 'link_source', 'x'.repeat(31)], ['appointments', 'link_source', ''],
      ['appointments', 'heard_from', 'tiktok'], ['appointments', 'heard_from', 'Friend'],
      ['appointments', 'heard_from_detail', 'x'.repeat(61)],
    ];
    for (const [table, column, value] of bad) {
      await assert.rejects(c.query(`update public.${table} set ${column} = $1`, [value]),
        new RegExp(`violates check constraint "${table}_${column}_check"`), `${table}.${column} = ${value}`);
    }
    // Right up to the limits is fine.
    await c.query(`update public.settings set review_link = $1, wa_template_review = $2`, [`https://${'x'.repeat(290)}`, 'x'.repeat(1000)]);
    await c.query(`update public.settings set review_link = 'https://g.page/r/demo-studio/review'`);
    await c.query(`update public.clients set marketing_ok_at = now(), marketing_ok_note = $1, review_asked_at = now()`, ['x'.repeat(100)]);
    for (const h of ['instagram', 'facebook', 'google', 'friend', 'card', 'other']) {
      await c.query(`update public.appointments set heard_from = $1, heard_from_detail = $2, link_source = $3, first_visit_said = false`,
        [h, 'x'.repeat(60), 'free-times-2']);
    }
  } finally {
    await c.end();
  }
});
