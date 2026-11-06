-- =============================================================================
-- Update, November 2026: the "Tax to put aside" estimate (Money → Tax year)
--
-- For an app set up with an older schema.sql, from before this version (if you're
-- not sure, run it: it's safe on any install). Run it once, BEFORE the new version
-- of the app goes live: Supabase → SQL Editor → New query → paste all of this
-- file → Run. It should say "Success. No rows returned".
--
-- It adds one private table for the two figures the estimate asks for (takings
-- not recorded in the app, and business expenses), one row per tax year. It
-- changes nothing else and touches no existing data. Running it again is safe.
--
-- A new install doesn't need it: schema.sql already includes the table.
-- =============================================================================

create table if not exists public.tax_years (
  start_year          int primary key check (start_year between 2000 and 2100),
  extra_takings_pence int not null default 0 check (extra_takings_pence between 0 and 100000000),
  expenses_pence      int not null default 0 check (expenses_pence between 0 and 100000000),
  updated_at          timestamptz not null default now()
);

create or replace trigger tax_years_updated_at before update on public.tax_years
  for each row execute function public.set_updated_at();

-- The same rule as every other table: only the signed-in owner can read or change it.
alter table public.tax_years enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'tax_years' and policyname = 'owner_all') then
    create policy owner_all on public.tax_years for all to authenticated
      using ((select public.is_owner())) with check ((select public.is_owner()));
  end if;
end $$;

-- Supabase no longer gives the app access to new tables by itself, so grant it
-- here: the signed-in owner (still limited by the rule above), and never the public key.
revoke all on public.tax_years from anon;
grant select, insert, update, delete on public.tax_years to authenticated;

-- Let the app's API see the new table straight away.
notify pgrst, 'reload schema';
