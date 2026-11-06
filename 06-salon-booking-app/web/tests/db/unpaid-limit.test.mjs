// Database tests for the update an existing install runs once
// (supabase/updates/2026-11-unpaid-limit.sql): bookings waiting for a deposit
// count towards the booking page's limit of 15 only until they start. The rule
// itself is tested in booking.test.mjs.
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
const UPDATE = await readFile(new URL('../../../supabase/updates/2026-11-unpaid-limit.sql', here), 'utf8');
const conn = { host: process.env.PGHOST || '/var/run/postgresql', user: process.env.PGUSER || userInfo().username };

// main just before this update: what an existing install was set up with.
const BEFORE = 'aa6282b';
function previousSchema() {
  try {
    return execFileSync('git', ['show', `${BEFORE}:./supabase/schema.sql`], { cwd: APP, encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch (e) {
    throw new Error(`These tests read schema.sql as it was at ${BEFORE}, so they need the git history `
      + `(in a shallow copy, run git fetch --unshallow first): ${e.message}`);
  }
}
const PREVIOUS = previousSchema();

const FN = 'public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text, boolean)';
/** The function's own text, as written in a .sql file. */
const fnText = (sql) => sql.match(/^create or replace function public\.public_create_booking\([\s\S]*?^end \$\$;$/m)?.[0];

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
  const name = `booking_unpaid_${label}_${process.pid}`;
  made.push(name);
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  const c = new pg.Client({ ...conn, database: name });
  await c.connect();
  await c.query(SHIM);
  await c.query(schema);
  return c;
}

/** The booking function's definition, exactly as PostgreSQL prints it back. */
const definition = async (c) => (await c.query(`select pg_get_functiondef($1::regprocedure) as d`, [FN])).rows[0].d;

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
/** The same, with the booking function's definition left out. */
function withoutBookingDefinition(s) {
  return { ...s, functions: s.functions.map((f) => (f.name === 'public_create_booking' ? { ...f, def: '(left out)' } : f)) };
}

/** A diary in use: settings, opening hours, a client, a treatment, and 15 online bookings never paid for, all in the past. */
async function seed(c) {
  await c.query(`update public.settings set business_name = 'Kept Studio', owner_email = 'owner@example.com' where id = 1;
                 update public.opening_hours set is_open = true, open_time = '09:00', close_time = '18:00';`);
  const client = (await c.query(`insert into public.clients (full_name, email, phone) values ('Una Paid', 'unpaid@example.com', '07700 900321')
                                 returning id`)).rows[0];
  const svc = (await c.query(`insert into public.services (name, duration_min, price_pence) values ('Gel', 30, 2500) returning id`)).rows[0];
  // One at 10:00 on each of the last 15 days, booked three weeks ago (so the hourly and daily brakes don't come into it).
  await c.query(
    `insert into public.appointments (client_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until,
                                      reference, status, source, is_new_client, deposit_required_pence, deposit_due_at, created_at)
     select $1::uuid, 'Gel', 2500, 30, s, s, s, '', 'pending_deposit', 'online', true, 1000, s, now() - interval '20 days'
       from (select (((now() at time zone 'Europe/London')::date - d) + time '10:00') at time zone 'Europe/London' as s
               from generate_series(1, 15) d) x`,
    [client.id]);
  return svc.id;
}

/** A new client booking online, as the booking page does, three days ahead at 14:00. */
async function bookOnline(c, serviceId) {
  await c.query('begin');
  try {
    await c.query(`set local role anon`);
    await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    const r = await c.query(
      `select public.public_create_booking($1, (((now() at time zone 'Europe/London')::date + 3) + time '14:00') at time zone 'Europe/London',
                                           'New Client', 'new@example.com', '07700 900600', p_policy_accepted => true) as r`,
      [serviceId]);
    await c.query('commit');
    return r.rows[0].r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}

// ---------------------------------------------------------------------------

test('the update is the booking function from schema.sql, word for word, and who can call it: nothing else', () => {
  assert.ok(fnText(SCHEMA), 'schema.sql has the function');
  assert.equal(fnText(UPDATE), fnText(SCHEMA));
  // Besides the function, the one other statement says again who can call it, as schema.sql does:
  // nothing that drops, deletes or changes a table.
  const rest = UPDATE.replace(fnText(UPDATE), '').replace(/--.*$/gm, '').trim();
  assert.equal(rest.replace(/\s+/g, ' '), `grant execute on function ${FN} to anon, authenticated;`);
  // Inside the function, the only delete is its own tidying-up of old booking records, as before.
  assert.deepEqual(fnText(UPDATE).match(/\bdelete\s+from\s+[\w.]+/gi), ['delete from public.booking_attempts']);
  assert.doesNotMatch(fnText(UPDATE), /\bdrop\s+\w+|\btruncate\b|\balter\s+table\b/i);
  // What changed since the previous schema: the count of unpaid bookings leaves out those that have started.
  assert.notEqual(fnText(PREVIOUS), fnText(SCHEMA));
  assert.match(fnText(SCHEMA), /status = 'pending_deposit'\s+and starts_at > now\(\)\) >= 15/);
});

test('run twice on an install from before this version: the same function as a new install, and nothing else changes', async () => {
  const fresh = await install('fresh', SCHEMA);
  const old = await install('old', PREVIOUS);
  try {
    const svc = await seed(old);
    const before = await snapshot(old);
    assert.notEqual(await definition(old), await definition(fresh));
    // Before the update, the 15 old unpaid bookings turn a new client away.
    await assert.rejects(bookOnline(old, svc), /busy_try_later/);

    await old.query(UPDATE);
    const once = await snapshot(old);
    await old.query(UPDATE);
    const twice = await snapshot(old);

    assert.equal(await definition(old), await definition(fresh));
    assert.deepEqual(twice, once, 'running it again changes nothing');
    assert.deepEqual(withoutBookingDefinition(twice), withoutBookingDefinition(before), 'only the booking function has changed');
    // Who can call it is as it was, and as on a new install: the booking page and the signed-in app.
    const acl = async (c) => (await c.query(`select proacl::text as acl from pg_proc where oid = $1::regprocedure`, [FN])).rows[0].acl;
    assert.equal(await acl(old), await acl(fresh));
    const may = async (c, role) => (await c.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, FN])).rows[0].ok;
    assert.deepEqual([await may(old, 'anon'), await may(old, 'authenticated')], [true, true]);

    // And now the old unpaid bookings no longer stop a new client booking.
    const r = await bookOnline(old, svc);
    assert.match(r.reference, /^[A-HJ-NP-Z2-9]{6}$/);
  } finally {
    await fresh.end();
    await old.end();
  }
});

test('on an install that already has this version, it changes nothing at all', async () => {
  const c = await install('again', SCHEMA);
  try {
    await seed(c);
    const before = await snapshot(c);
    await c.query(UPDATE);
    assert.deepEqual(await snapshot(c), before);
  } finally {
    await c.end();
  }
});
