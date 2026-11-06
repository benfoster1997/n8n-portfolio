// Database tests for the tax estimate's figures (public.tax_years): the same
// owner-only rule as every other table, the checks on the figures, and the
// update script an existing install runs once
// (supabase/updates/2026-11-tax-estimate.sql).
//
//   npm run test:db        (needs a local PostgreSQL reachable as the current OS user)
//
// Each run creates throwaway databases and drops them afterwards.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import pg from 'pg';

const here = new URL('.', import.meta.url);
const SHIM = await readFile(new URL('../../../supabase/test/supabase-shim.sql', here), 'utf8');
const SCHEMA = await readFile(new URL('../../../supabase/schema.sql', here), 'utf8');
const UPDATE = await readFile(new URL('../../../supabase/updates/2026-11-tax-estimate.sql', here), 'utf8');
const DB = `booking_tax_test_${process.pid}`;
const conn = { host: process.env.PGHOST || '/var/run/postgresql', user: process.env.PGUSER || userInfo().username };

const OWNER = randomUUID();
const STRANGER = randomUUID();
let admin; // the maintenance db, to create and drop the test dbs
let db;    // superuser connection to the test db

before(async () => {
  admin = new pg.Client({ ...conn, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  db = new pg.Client({ ...conn, database: DB });
  await db.connect();
  await db.query(SHIM);
  await db.query(SCHEMA);
});

after(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${DB}`);
  await admin?.end();
});

beforeEach(async () => {
  await db.query(`truncate public.tax_years, public.owner;
                  insert into public.owner (id, user_id) values (1, '${OWNER}');`);
});

/** Run SQL as one of Supabase's API roles, signed in as `uid` (or not signed in). */
async function as(c, role, uid, sql, params = []) {
  await c.query('begin');
  try {
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}
const asAnon = (sql, params, c = db) => as(c, 'anon', null, sql, params);
const asOwner = (sql, params, c = db) => as(c, 'authenticated', OWNER, sql, params);
const asStranger = (sql, params, c = db) => as(c, 'authenticated', STRANGER, sql, params);

async function rejects(promise, pattern) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, pattern);
    return true;
  });
}

// What the app sends: supabaseApi.saveTaxYear() is an upsert on start_year.
const UPSERT = `insert into public.tax_years (start_year, extra_takings_pence, expenses_pence) values ($1, $2, $3)
                on conflict (start_year) do update
                  set extra_takings_pence = excluded.extra_takings_pence, expenses_pence = excluded.expenses_pence
                returning start_year, extra_takings_pence, expenses_pence, updated_at::text as at`;
const FIGURES = `select start_year, extra_takings_pence, expenses_pence from public.tax_years order by start_year`;
const figures = async (c = db) => (await c.query(FIGURES)).rows;

/** How the table is protected: row-level security, its policies, and who has which privileges. */
async function locks(c) {
  return (await c.query(`select
      (select relrowsecurity from pg_class where oid = 'public.tax_years'::regclass) as rls,
      (select json_agg(json_build_object('name', policyname, 'cmd', cmd, 'roles', roles::text, 'using', qual, 'check', with_check))
         from pg_policies where schemaname = 'public' and tablename = 'tax_years') as policies,
      (select json_build_object('using', qual, 'check', with_check)
         from pg_policies where schemaname = 'public' and tablename = 'payments' and policyname = 'owner_all') as payments_rule,
      has_table_privilege('anon', 'public.tax_years', 'select, insert, update, delete, truncate, references, trigger') as anon_any,
      has_table_privilege('authenticated', 'public.tax_years', 'select') as auth_select,
      has_table_privilege('authenticated', 'public.tax_years', 'insert') as auth_insert,
      has_table_privilege('authenticated', 'public.tax_years', 'update') as auth_update,
      has_table_privilege('authenticated', 'public.tax_years', 'delete') as auth_delete`)).rows[0];
}
function assertLocked(l) {
  assert.equal(l.rls, true);
  assert.equal(l.policies.length, 1);
  assert.deepEqual(l.policies[0], { name: 'owner_all', cmd: 'ALL', roles: '{authenticated}', ...l.payments_rule });
  assert.equal(l.anon_any, false);
  assert.deepEqual([l.auth_select, l.auth_insert, l.auth_update, l.auth_delete], [true, true, true, true]);
}

/** The table's shape: columns, checks and triggers. */
async function shape(c) {
  const columns = (await c.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
                                   where table_schema = 'public' and table_name = 'tax_years' order by ordinal_position`)).rows;
  const checks = (await c.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
                                  where conrelid = 'public.tax_years'::regclass order by conname`)).rows;
  const triggers = (await c.query(`select tgname from pg_trigger where tgrelid = 'public.tax_years'::regclass and not tgisinternal`)).rows;
  return { columns, checks, triggers };
}

// ---------------------------------------------------------------------------

test('the owner saves a tax year’s figures, changes them, and reads them back', async () => {
  const { at, ...saved } = (await asOwner(UPSERT, [2026, 450000, 120000])).rows[0];
  assert.deepEqual(saved, { start_year: 2026, extra_takings_pence: 450000, expenses_pence: 120000 });
  await db.query(`select pg_sleep(0.01)`);
  // Saving again replaces the figures: still one row for the tax year, and updated_at moves on.
  await asOwner(UPSERT, [2026, 500000, 0]);
  const moved = (await db.query(`select updated_at > $1::timestamptz as later from public.tax_years where start_year = 2026`, [at])).rows[0];
  assert.equal(moved.later, true);
  await asOwner(UPSERT, [2025, 0, 30000]);
  // Only some figures: the rest are 0.
  await asOwner(`insert into public.tax_years (start_year, expenses_pence) values (2024, 5000)`);
  assert.deepEqual((await asOwner(FIGURES)).rows, [
    { start_year: 2024, extra_takings_pence: 0, expenses_pence: 5000 },
    { start_year: 2025, extra_takings_pence: 0, expenses_pence: 30000 },
    { start_year: 2026, extra_takings_pence: 500000, expenses_pence: 0 },
  ]);
  assert.equal((await asOwner(`delete from public.tax_years where start_year = 2024`)).rowCount, 1);
  assert.equal((await figures()).length, 2);
});

test('another signed-in user can’t see, add, change or delete the figures', async () => {
  await asOwner(UPSERT, [2026, 450000, 120000]);
  assert.equal((await asStranger(`select * from public.tax_years`)).rowCount, 0);
  await rejects(asStranger(UPSERT, [2025, 100, 100]), /row-level security/);
  assert.equal((await asStranger(`update public.tax_years set expenses_pence = 0`)).rowCount, 0);
  assert.equal((await asStranger(`delete from public.tax_years`)).rowCount, 0);
  assert.deepEqual(await figures(), [{ start_year: 2026, extra_takings_pence: 450000, expenses_pence: 120000 }]);
});

test('the public key can’t read or write the figures at all', async () => {
  await asOwner(UPSERT, [2026, 450000, 120000]);
  await rejects(asAnon(`select * from public.tax_years`), /permission denied/);
  await rejects(asAnon(UPSERT, [2026, 0, 0]), /permission denied/);
  await rejects(asAnon(`update public.tax_years set expenses_pence = 0`), /permission denied/);
  await rejects(asAnon(`delete from public.tax_years`), /permission denied/);
  assert.equal((await figures()).length, 1);
});

test('the checks turn away figures that can’t be right', async () => {
  for (const values of [[2026, -1, 0], [2026, 0, -100], [2026, 100000001, 0], [2026, 0, 100000001], [1999, 0, 0], [2101, 0, 0]]) {
    await rejects(asOwner(UPSERT, values), /violates check constraint/);
  }
  await rejects(asOwner(UPSERT, [2026, null, 0]), /violates not-null constraint/);
  await rejects(asOwner(UPSERT, [2026, 0, null]), /violates not-null constraint/);
  await rejects(asOwner(UPSERT, [null, 0, 0]), /violates not-null constraint/);
  // The limits themselves are allowed: £0 and £1,000,000, from 2000–01 to 2100–01.
  await asOwner(UPSERT, [2000, 0, 0]);
  await asOwner(UPSERT, [2100, 100000000, 100000000]);
  assert.equal((await figures()).length, 2);
});

test('the table is locked like every other one: row-level security, the owner rule, no public access', async () => {
  assertLocked(await locks(db));
});

test('the update script runs cleanly twice on top of the full schema, keeping the figures and the locks', async () => {
  // It adds and changes nothing else, so it has nothing that drops or deletes (and no warning in Supabase's editor).
  assert.doesNotMatch(UPDATE.replace(/--.*$/gm, ''), /\bdrop\s+\w+|\bdelete\s+from\b|\btruncate\b/i);
  await asOwner(UPSERT, [2026, 450000, 120000]);
  const before = await shape(db);
  await db.query(UPDATE);
  await db.query(UPDATE);
  assert.deepEqual(await shape(db), before);
  assertLocked(await locks(db));
  assert.deepEqual(await figures(), [{ start_year: 2026, extra_takings_pence: 450000, expenses_pence: 120000 }]);
  await asOwner(UPSERT, [2026, 1, 2]);
  assert.equal((await asStranger(`select * from public.tax_years`)).rowCount, 0);
  await rejects(asAnon(`select * from public.tax_years`), /permission denied/);
});

test('an install from before the update gets the same table from the script, on a project that no longer exposes new tables', async () => {
  const old = `booking_tax_old_${process.pid}`;
  await admin.query(`drop database if exists ${old}`);
  await admin.query(`create database ${old}`);
  const c = new pg.Client({ ...conn, database: old });
  await c.connect();
  try {
    await c.query(SHIM);
    await c.query(SCHEMA);
    const fresh = await shape(c);
    // As an install made before this version: everything except the new table…
    await c.query(`drop table public.tax_years`);
    // …on a project where new tables get no API access by themselves (Supabase from 30 October 2026).
    await c.query(`alter default privileges in schema public revoke all on tables from anon, authenticated, service_role`);
    await c.query(`insert into public.owner (id, user_id) values (1, '${OWNER}')`);
    await c.query(UPDATE);
    await c.query(UPDATE);
    assert.deepEqual(await shape(c), fresh);
    assertLocked(await locks(c));
    // The owner can use it straight away; nobody else can.
    await asOwner(UPSERT, [2026, 250000, 80000], c);
    assert.deepEqual(await figures(c), [{ start_year: 2026, extra_takings_pence: 250000, expenses_pence: 80000 }]);
    assert.equal((await asStranger(`select * from public.tax_years`, [], c)).rowCount, 0);
    await rejects(asAnon(`select * from public.tax_years`, [], c), /permission denied/);
  } finally {
    await c.end();
    await admin.query(`drop database if exists ${old}`);
  }
});
