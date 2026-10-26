-- =============================================================================
-- Salon booking app — database schema (Supabase / PostgreSQL 15+)
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- then run storage.sql. It is safe to re-run: every object is created with
-- "if not exists" or "create or replace".
--
-- Security model, in one paragraph:
--   * Every table has Row Level Security switched on and only one policy:
--     "the signed-in owner can do everything". Nobody else can read a row.
--   * The public booking page never touches a table. It calls a small set of
--     functions (public_*) that check every input and only ever return what a
--     client needs to see: services, prices, opening hours and which times are
--     taken (never who took them).
--   * A client can see, change or cancel their own booking, and nothing else,
--     through the secret link in their confirmation email (/manage/<token>).
--   * The email sender (a Google Apps Script in the owner's own Gmail) calls
--     two functions (email_jobs_*) that refuse to run without a secret whose
--     hash is stored in settings.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Exactly one owner (the person whose business this is). Claimed once, on
-- first sign-in, by claim_owner().
create table if not exists public.owner (
  id         int primary key default 1 check (id = 1),
  user_id    uuid not null unique,
  created_at timestamptz not null default now()
);

-- One row of settings (id = 1). Everything the owner can change lives here.
create table if not exists public.settings (
  id                     int primary key default 1 check (id = 1),
  business_name          text not null default 'My Nail Studio' check (length(business_name) between 1 and 80),
  booking_intro          text check (length(booking_intro) <= 1000),
  -- Shown publicly on the booking page, e.g. "South Woodham Ferrers — full address in your confirmation".
  location_note          text check (length(location_note) <= 200),
  -- Full address: only ever sent in confirmation emails, never shown publicly.
  address                text check (length(address) <= 300),
  owner_email            text check (length(owner_email) <= 254),
  owner_phone            text check (length(owner_phone) <= 30),
  public_site_url        text check (length(public_site_url) <= 200),
  timezone               text not null default 'Europe/London',
  slot_interval_min      int  not null default 15 check (slot_interval_min between 5 and 120),
  buffer_min             int  not null default 10 check (buffer_min between 0 and 120),
  min_notice_hours       int  not null default 12 check (min_notice_hours between 0 and 336),
  max_days_ahead         int  not null default 60 check (max_days_ahead between 1 and 365),
  deposit_amount_pence   int  not null default 1000 check (deposit_amount_pence between 0 and 100000),
  deposit_deadline_hours int  not null default 24 check (deposit_deadline_hours between 1 and 336),
  bank_account_name      text check (length(bank_account_name) <= 80),
  bank_sort_code         text check (length(bank_sort_code) <= 20),
  bank_account_number    text check (length(bank_account_number) <= 20),
  cancellation_policy    text check (length(cancellation_policy) <= 1000),
  reminder_hours_before  int  not null default 72 check (reminder_hours_before between 2 and 168),
  wa_template_reminder   text check (length(wa_template_reminder) <= 1000),
  wa_template_deposit    text check (length(wa_template_deposit) <= 1000),
  wa_template_confirmed  text check (length(wa_template_confirmed) <= 1000),
  booking_enabled        boolean not null default true,
  -- The owner's legal name, for the privacy notice (a trading name is not a legal person).
  legal_name             text check (length(legal_name) <= 100),
  -- Release online bookings whose deposit hasn't arrived by the deadline.
  auto_cancel_unpaid     boolean not null default false,
  -- How much notice the cancellation policy asks for. Cancelling online after
  -- this point is still allowed, but the booking is flagged as a late cancellation.
  cancel_notice_hours    int  not null default 48 check (cancel_notice_hours between 0 and 336),
  -- Clients can change or cancel their own booking from the link in their emails.
  client_self_service    boolean not null default true,
  -- sha256 (hex) of the secret the email sender presents. The secret itself is never stored.
  email_secret_hash      text check (email_secret_hash ~ '^[0-9a-f]{64}$'),
  email_last_poll_at     timestamptz,
  updated_at             timestamptz not null default now()
);
-- The starting cancellation policy (editable in the app: Settings → Deposits & bank details).
insert into public.settings (id, cancellation_policy)
values (1, 'Please give at least 48 hours’ notice if you need to cancel or move your appointment. If you cancel with less than 48 hours’ notice, or don’t turn up, the full price of your treatment is payable.')
on conflict (id) do nothing;

-- Opening hours per ISO weekday (1 = Monday … 7 = Sunday).
create table if not exists public.opening_hours (
  weekday     int primary key check (weekday between 1 and 7),
  is_open     boolean not null default false,
  open_time   time not null default '09:00',
  close_time  time not null default '17:00',
  break_start time,
  break_end   time,
  check (close_time > open_time),
  check ((break_start is null) = (break_end is null)),
  check (break_start is null or (break_end > break_start and break_start >= open_time and break_end <= close_time))
);
insert into public.opening_hours (weekday, is_open, open_time, close_time) values
  (1, true,  '09:30', '17:30'),
  (2, true,  '09:30', '17:30'),
  (3, true,  '09:30', '17:30'),
  (4, true,  '09:30', '19:00'),
  (5, true,  '09:30', '17:30'),
  (6, true,  '09:00', '15:00'),
  (7, false, '10:00', '14:00')
on conflict (weekday) do nothing;

create table if not exists public.services (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 80),
  description    text check (length(description) <= 500),
  duration_min   int  not null check (duration_min between 5 and 600),
  price_pence    int  not null check (price_pence between 0 and 1000000),
  is_active      boolean not null default true,
  online_bookable boolean not null default true,
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null check (length(full_name) between 1 and 100),
  email       text check (length(email) <= 254),
  phone       text check (length(phone) <= 30),
  -- Digits only, international format without "+", e.g. 447700900123. Set by trigger.
  phone_e164  text,
  allergies   text check (length(allergies) <= 2000),
  notes       text check (length(notes) <= 5000),
  -- A regular moved over from another system: never asked for a new-client deposit.
  is_regular  boolean not null default false,
  -- When and how the client gave explicit consent to health information being kept
  -- (set automatically by the consultation form; the owner can record paper/in-person consent).
  health_consent_at   timestamptz,
  health_consent_note text check (length(health_consent_note) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists clients_email_unique on public.clients (lower(email)) where email is not null and email <> '';
create index if not exists clients_phone_idx on public.clients (phone_e164);

create table if not exists public.patch_tests (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  tested_on  date not null,
  product    text check (length(product) <= 200),
  result     text not null default 'pass' check (result in ('pass', 'reaction', 'pending')),
  notes      text check (length(notes) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists patch_tests_client_idx on public.patch_tests (client_id);

create table if not exists public.appointments (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id) on delete cascade,
  service_id             uuid references public.services(id) on delete set null,
  -- Snapshots, so changing a service later never rewrites history.
  service_name           text not null check (length(service_name) between 1 and 80),
  price_pence            int  not null default 0 check (price_pence >= 0),
  duration_min           int  not null check (duration_min between 5 and 600),
  starts_at              timestamptz not null,
  ends_at                timestamptz not null,
  -- ends_at plus the clean-up buffer. Set by trigger; used to stop double booking.
  busy_until             timestamptz not null,
  status                 text not null default 'confirmed'
                         check (status in ('pending_deposit', 'confirmed', 'completed', 'cancelled', 'no_show')),
  source                 text not null default 'owner' check (source in ('online', 'owner')),
  booking_name           text check (length(booking_name) <= 100),
  is_new_client          boolean not null default false,
  deposit_required_pence int  not null default 0 check (deposit_required_pence >= 0),
  deposit_due_at         timestamptz,
  deposit_paid_at        timestamptz,
  reference              text not null unique,
  public_token           uuid not null unique default gen_random_uuid(),
  client_notes           text check (length(client_notes) <= 1000),
  -- The exact cancellation policy the client ticked to agree to when booking online.
  cancellation_policy_agreed text check (length(cancellation_policy_agreed) <= 1000),
  owner_notes            text check (length(owner_notes) <= 2000),
  reminder_email_sent_at timestamptz,
  whatsapp_reminder_sent_at timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text check (length(cancel_reason) <= 500),
  -- 'client' (online), 'owner', or 'system' (an unpaid deposit released the slot).
  cancelled_by           text check (cancelled_by in ('client', 'owner', 'system')),
  -- Cancelled by the client inside the cancellation notice period.
  cancelled_late         boolean not null default false,
  -- Changes the client has made online. Capped, so a link can't be used to send endless emails.
  client_change_count    int not null default 0,
  client_changed_at      timestamptz,
  -- When the client was last sent their full booking details after booking (a
  -- "your booking has changed" or "deposit received" email, or a re-sent
  -- confirmation). A reminder isn't sent on top of one that went out inside
  -- the reminder window.
  details_sent_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (ends_at > starts_at),
  check (busy_until >= ends_at),
  -- The database itself refuses two live appointments whose busy times overlap.
  constraint appointments_no_overlap exclude using gist (tstzrange(starts_at, busy_until, '[)') with &&)
    where (status in ('pending_deposit', 'confirmed', 'completed'))
);
create index if not exists appointments_starts_idx on public.appointments (starts_at);
create index if not exists appointments_client_idx on public.appointments (client_id);

create table if not exists public.consultation_forms (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  answers        jsonb not null check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) < 20000),
  health_consent boolean not null check (health_consent),
  signed_name    text not null check (length(signed_name) between 2 and 100),
  -- Which consent wording the client agreed to. Set by the database, never by the browser.
  consent_version text not null default 'v1',
  submitted_at   timestamptz not null default now()
);
create index if not exists consultation_forms_client_idx on public.consultation_forms (client_id);
create unique index if not exists consultation_forms_one_per_appt on public.consultation_forms (appointment_id)
  where appointment_id is not null;

-- Every change a client makes to their own booking online, so the owner can see
-- what moved, when, and whether it was inside the cancellation notice period.
create table if not exists public.client_changes (
  id               bigint generated always as identity primary key,
  appointment_id   uuid not null references public.appointments(id) on delete cascade,
  changed_at       timestamptz not null default now(),
  action           text not null check (action in ('moved', 'treatment', 'moved_treatment', 'cancelled')),
  old_starts_at    timestamptz,
  new_starts_at    timestamptz,
  old_service_name text,
  new_service_name text,
  old_price_pence  int,
  new_price_pence  int,
  -- Made with less notice than the cancellation policy asks for.
  late             boolean not null default false,
  -- The client's reason, if they gave one when cancelling.
  note             text check (length(note) <= 300)
);
create index if not exists client_changes_appt_idx on public.client_changes (appointment_id);
create index if not exists client_changes_at_idx on public.client_changes (changed_at);

-- Successful online bookings per connection, for the flood brake in public_create_booking.
create table if not exists public.booking_attempts (
  id  bigint generated always as identity primary key,
  ip  text not null,
  at  timestamptz not null default now()
);
create index if not exists booking_attempts_at_idx on public.booking_attempts (at);

create table if not exists public.time_off (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  note       text check (length(note) <= 200),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists time_off_starts_idx on public.time_off (starts_at);

-- Money actually received. Cash and bank transfer only. Refunds are negative.
-- client_name / description are snapshots so the tax record survives a client
-- being deleted (UK records must be kept for 5 years after the 31 January
-- filing deadline).
create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id      uuid references public.clients(id) on delete set null,
  client_name    text check (length(client_name) <= 100),
  description    text check (length(description) <= 200),
  amount_pence   int  not null check (amount_pence <> 0 and abs(amount_pence) <= 10000000),
  method         text not null check (method in ('cash', 'bank_transfer')),
  kind           text not null default 'payment' check (kind in ('deposit', 'payment', 'tip', 'refund', 'other')),
  paid_on        date not null,
  note           text check (length(note) <= 500),
  created_at     timestamptz not null default now()
);
create index if not exists payments_paid_on_idx on public.payments (paid_on);

create table if not exists public.client_photos (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  storage_path   text not null unique check (length(storage_path) <= 300),
  caption        text check (length(caption) <= 200),
  taken_on       date not null default current_date,
  created_at     timestamptz not null default now()
);
create index if not exists client_photos_client_idx on public.client_photos (client_id);

-- Emails waiting to be sent by the Apps Script sender.
create table if not exists public.email_outbox (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in ('booking_received', 'deposit_received', 'reminder', 'cancelled', 'changed',
                                               'owner_new_booking', 'owner_changed', 'owner_cancelled')),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  to_email       text not null check (length(to_email) <= 254),
  status         text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts       int  not null default 0,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  unique (appointment_id, kind)
);
create index if not exists email_outbox_status_idx on public.email_outbox (status);

-- Columns added after the first release (no-ops on a fresh install).
alter table public.settings add column if not exists legal_name text check (length(legal_name) <= 100);
alter table public.settings add column if not exists auto_cancel_unpaid boolean not null default false;
alter table public.clients add column if not exists is_regular boolean not null default false;
alter table public.clients add column if not exists health_consent_at timestamptz;
alter table public.clients add column if not exists health_consent_note text check (length(health_consent_note) <= 200);
alter table public.consultation_forms add column if not exists consent_version text not null default 'v1';
alter table public.appointments add column if not exists cancellation_policy_agreed text
  check (length(cancellation_policy_agreed) <= 1000);
alter table public.settings alter column reminder_hours_before set default 72;
alter table public.settings add column if not exists cancel_notice_hours int not null default 48
  check (cancel_notice_hours between 0 and 336);
alter table public.settings add column if not exists client_self_service boolean not null default true;
alter table public.appointments add column if not exists cancelled_by text
  check (cancelled_by in ('client', 'owner', 'system'));
alter table public.appointments add column if not exists cancelled_late boolean not null default false;
alter table public.appointments add column if not exists client_change_count int not null default 0;
alter table public.appointments add column if not exists client_changed_at timestamptz;
alter table public.appointments add column if not exists details_sent_at timestamptz;
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_received', 'deposit_received', 'reminder', 'cancelled', 'changed',
                  'owner_new_booking', 'owner_changed', 'owner_cancelled'));

-- The consent wording currently shown on the form (web/src/lib/consultation.ts).
create or replace function public.current_consent_version()
returns text language sql immutable as $$ select 'v2-2026-10' $$;

-- How many times a client can change one booking online before they have to get in touch.
create or replace function public.max_client_changes()
returns int language sql immutable as $$ select 6 $$;

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- UK-first phone normalisation: "07700 900123" → "447700900123".
create or replace function public.normalize_uk_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if d = '' then return null; end if;
  if left(d, 2) = '00' then d := substr(d, 3); end if;
  if left(d, 3) = '440' then d := '44' || substr(d, 4); end if;   -- "+44 (0)7700…"
  if left(d, 1) = '0' then d := '44' || substr(d, 2);
  elsif length(d) = 10 and left(d, 1) = '7' then d := '44' || d;
  end if;
  return d;
end $$;

-- Short booking reference used on bank transfers, e.g. "K3Q7XP".
-- No 0/O/1/I so it can be read out over the phone.
create or replace function public.gen_reference()
returns text language sql volatile as $$
  -- The first 6 bytes of a v4 UUID are fully random; 256 is a multiple of 32,
  -- so "% 32" picks every character with equal probability.
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '' order by i)
  from (select uuid_send(gen_random_uuid()) as b) x, generate_series(0, 5) as i
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owner where user_id = auth.uid())
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.clients_before_write()
returns trigger language plpgsql as $$
begin
  new.email := nullif(lower(btrim(new.email)), '');
  new.phone := nullif(btrim(new.phone), '');
  new.phone_e164 := public.normalize_uk_phone(new.phone);
  new.full_name := btrim(new.full_name);
  new.updated_at := now();
  return new;
end $$;

-- Fill in ends_at / busy_until / reference so the owner's app can insert an
-- appointment with just a start time and a duration.
create or replace function public.appointments_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_buffer int;
begin
  if tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at
     or new.duration_min is distinct from old.duration_min then
    new.ends_at := new.starts_at + make_interval(mins => new.duration_min);
    select buffer_min into v_buffer from public.settings where id = 1;
    new.busy_until := new.ends_at + make_interval(mins => coalesce(v_buffer, 0));
  else
    new.ends_at := old.ends_at;
    new.busy_until := old.busy_until;
  end if;
  if tg_op = 'UPDATE' and new.starts_at is distinct from old.starts_at then
    new.reminder_email_sent_at := null;
    new.whatsapp_reminder_sent_at := null;
    delete from public.email_outbox where appointment_id = new.id and kind = 'reminder' and status <> 'sending';
  end if;
  if new.deposit_due_at is not null and new.deposit_due_at > new.starts_at then
    new.deposit_due_at := new.starts_at;   -- moved earlier: the deposit is due by the new time
  end if;
  if new.reference is null or new.reference = '' then
    new.reference := public.gen_reference();
  end if;
  if new.status = 'cancelled' and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists clients_before_write on public.clients;
create trigger clients_before_write before insert or update on public.clients
  for each row execute function public.clients_before_write();

drop trigger if exists appointments_before_write on public.appointments;
create trigger appointments_before_write before insert or update on public.appointments
  for each row execute function public.appointments_before_write();

drop trigger if exists settings_updated_at on public.settings;
create trigger settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Owner set-up
-- ---------------------------------------------------------------------------

-- The first signed-in user becomes the owner; everyone after that gets false.
-- If settings.owner_email has been set (SETUP.md does this in the SQL editor
-- before anyone signs in), only an account with that email can claim it, and
-- never an anonymous session.
create or replace function public.claim_owner()
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_expected text;
  v_claims   jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
begin
  if auth.uid() is null then
    raise exception 'not_signed_in';
  end if;
  if not exists (select 1 from public.owner) then
    if coalesce((v_claims ->> 'is_anonymous')::boolean, false) then
      return false;
    end if;
    select lower(nullif(btrim(owner_email), '')) into v_expected from public.settings where id = 1;
    if v_expected is not null and v_expected is distinct from lower(v_claims ->> 'email') then
      return false;
    end if;
    insert into public.owner (id, user_id) values (1, auth.uid()) on conflict (id) do nothing;
  end if;
  return exists (select 1 from public.owner where user_id = auth.uid());
end $$;

-- Lets the sign-in screen decide whether to offer "create the owner account".
create or replace function public.public_owner_exists()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owner)
$$;

-- ---------------------------------------------------------------------------
-- Public booking functions (callable by anyone with the public key)
-- ---------------------------------------------------------------------------

create or replace function public.public_booking_info()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'business_name',          s.business_name,
    'booking_intro',          s.booking_intro,
    'location_note',          s.location_note,
    'cancellation_policy',    s.cancellation_policy,
    'timezone',               s.timezone,
    'slot_interval_min',      s.slot_interval_min,
    'buffer_min',             s.buffer_min,
    'min_notice_hours',       s.min_notice_hours,
    'max_days_ahead',         s.max_days_ahead,
    'deposit_amount_pence',   s.deposit_amount_pence,
    'deposit_deadline_hours', s.deposit_deadline_hours,
    'booking_enabled',        s.booking_enabled,
    -- For the privacy notice: who the controller is and how to contact them.
    'legal_name',             s.legal_name,
    'contact_email',          s.owner_email,
    'hours', (select coalesce(jsonb_agg(jsonb_build_object(
                'weekday', h.weekday, 'is_open', h.is_open,
                'open_time', to_char(h.open_time, 'HH24:MI'), 'close_time', to_char(h.close_time, 'HH24:MI'),
                'break_start', to_char(h.break_start, 'HH24:MI'), 'break_end', to_char(h.break_end, 'HH24:MI'))
              order by h.weekday), '[]'::jsonb) from public.opening_hours h),
    'services', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', v.id, 'name', v.name, 'description', v.description,
                'duration_min', v.duration_min, 'price_pence', v.price_pence)
              order by v.sort_order, v.name), '[]'::jsonb)
              from public.services v where v.is_active and v.online_bookable)
  )
  from public.settings s where s.id = 1
$$;

-- Busy time ranges between two instants: appointments (including the clean-up
-- buffer) and time off. No names, no services, nothing personal.
create or replace function public.public_busy_times(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '400 days'
     or (p_from < now() - interval '2 days' and not public.is_owner()) then
    raise exception 'invalid_range';
  end if;
  return query
    select a.starts_at, a.busy_until
      from public.appointments a
     where a.status in ('pending_deposit', 'confirmed', 'completed')
       and tstzrange(a.starts_at, a.busy_until, '[)') && tstzrange(p_from, p_to, '[)')
    union all
    select t.starts_at, t.ends_at
      from public.time_off t
     where tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_from, p_to, '[)')
    order by 1;
end $$;

-- Validate a requested start time against the rules a client must follow.
-- Raises a short machine-readable error the booking page translates.
create or replace function public.check_bookable_time(p_starts_at timestamptz, p_duration_min int)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  s        public.settings;
  h        public.opening_hours;
  v_local  timestamp;
  v_day    date;
  v_end    timestamp;
begin
  select * into s from public.settings where id = 1;
  if p_starts_at is null or date_trunc('minute', p_starts_at) <> p_starts_at then
    raise exception 'invalid_time';
  end if;
  if p_starts_at < now() + make_interval(hours => s.min_notice_hours) then
    raise exception 'too_soon';
  end if;
  if p_starts_at > now() + make_interval(days => s.max_days_ahead) then
    raise exception 'too_far';
  end if;
  v_local := p_starts_at at time zone s.timezone;
  v_day   := v_local::date;
  v_end   := v_local + make_interval(mins => p_duration_min);
  select * into h from public.opening_hours where weekday = extract(isodow from v_local)::int;
  if not found or not h.is_open then
    raise exception 'closed';
  end if;
  if v_local < v_day + h.open_time or v_end > v_day + h.close_time then
    raise exception 'outside_hours';
  end if;
  if (extract(epoch from (v_local - (v_day + h.open_time)))::int / 60) % s.slot_interval_min <> 0 then
    raise exception 'invalid_time';
  end if;
  if h.break_start is not null and v_local < v_day + h.break_end and v_end > v_day + h.break_start then
    raise exception 'outside_hours';
  end if;
  -- Time off keeps the same clean-up gap in front of it as an appointment would.
  if exists (select 1 from public.time_off t
              where tstzrange(t.starts_at, t.ends_at, '[)')
                 && tstzrange(p_starts_at, p_starts_at + make_interval(mins => p_duration_min + s.buffer_min), '[)')) then
    raise exception 'slot_taken';
  end if;
end $$;

drop function if exists public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text);

create or replace function public.public_create_booking(
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_full_name      text,
  p_email          text,
  p_phone          text,
  p_notes          text    default null,
  p_consultation   jsonb   default null,
  p_health_consent boolean default false,
  p_signed_name    text    default null,
  p_policy_accepted boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s         public.settings;
  v_service public.services;
  v_client  public.clients;
  v_appt    public.appointments;
  v_name    text := btrim(coalesce(p_full_name, ''));
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_phone   text := public.normalize_uk_phone(p_phone);
  v_is_new  boolean;
  v_deposit int;
  v_created boolean;
  v_ip      text := nullif(btrim(split_part(coalesce(
                 nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), '');
begin
  select * into s from public.settings where id = 1;
  if not s.booking_enabled then raise exception 'booking_disabled'; end if;

  -- Flood brake. A one-person diary never sees more than a handful of online
  -- bookings an hour; anything beyond that is a script filling the diary or
  -- using the confirmation emails to spam strangers through the owner's Gmail.
  if (select count(*) from public.appointments where source = 'online' and created_at > now() - interval '1 hour') >= 6
     or (select count(*) from public.appointments where source = 'online' and created_at > now() - interval '1 day') >= 25
     or (select count(*) from public.appointments where source = 'online' and status = 'pending_deposit') >= 15
     or (v_ip is not null and (select count(*) from public.booking_attempts
                                where ip = v_ip and at > now() - interval '1 hour') >= 3) then
    raise exception 'busy_try_later';
  end if;

  -- Names only: no links, email addresses or markup to smuggle into emails.
  if length(v_name) < 2 or length(v_name) > 100
     or v_name ~ '[0-9@/:<>{}\[\][:cntrl:]]'
     or v_name ~* '(www\.|https?|\.(com|net|org|co|uk|io|ru|xyz|info|biz|top|link|site)\M)' then
    raise exception 'invalid_name';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]?&#%]+@[^@[:space:]?&#%]+\.[^@[:space:]?&#%]+$' then
    raise exception 'invalid_email';
  end if;
  if v_phone is null or length(v_phone) not between 10 and 15 or length(btrim(p_phone)) > 30 then raise exception 'invalid_phone'; end if;
  if length(coalesce(p_notes, '')) > 1000 then raise exception 'invalid_notes'; end if;
  -- Clients must agree to the cancellation policy (when there is one) before booking.
  if coalesce(btrim(s.cancellation_policy), '') <> '' and not coalesce(p_policy_accepted, false) then
    raise exception 'policy_required';
  end if;

  select * into v_service from public.services
   where id = p_service_id and is_active and online_bookable;
  if not found then raise exception 'invalid_service'; end if;

  perform public.check_bookable_time(p_starts_at, v_service.duration_min);

  -- Match an existing client by email only, and never change an existing record from here.
  select * into v_client from public.clients where lower(email) = v_email limit 1;
  v_created := not found;
  if v_created then
    begin
      insert into public.clients (full_name, email, phone)
      values (v_name, v_email, btrim(p_phone))
      returning * into v_client;
    exception when unique_violation then
      select * into v_client from public.clients where lower(email) = v_email;
      v_created := false;
    end;
  end if;
  perform 1 from public.clients where id = v_client.id for update;  -- serialise the per-client brake

  -- "New" means: has never had a completed appointment (and isn't a regular the
  -- owner moved across from another system). Someone who booked before but
  -- never turned up still pays a deposit.
  v_is_new := not (v_client.is_regular or exists (select 1 from public.appointments
                                                  where client_id = v_client.id and status = 'completed'));

  -- A light brake on spam: three upcoming online bookings per client at most.
  if (select count(*) from public.appointments
       where client_id = v_client.id and starts_at > now()
         and status in ('pending_deposit', 'confirmed')) >= 3 then
    raise exception 'too_many_bookings';
  end if;

  v_deposit := case when v_is_new then s.deposit_amount_pence else 0 end;

  begin
    insert into public.appointments (
      client_id, service_id, service_name, price_pence, duration_min, starts_at, ends_at, busy_until,
      status, source, booking_name, is_new_client, deposit_required_pence, deposit_due_at,
      reference, client_notes, cancellation_policy_agreed)
    values (
      v_client.id, v_service.id, v_service.name, v_service.price_pence, v_service.duration_min,
      p_starts_at, p_starts_at, p_starts_at,             -- ends_at / busy_until recomputed by trigger
      case when v_deposit > 0 then 'pending_deposit' else 'confirmed' end,
      'online', v_name, v_is_new, v_deposit,
      case when v_deposit > 0 then least(now() + make_interval(hours => s.deposit_deadline_hours), p_starts_at) end,
      '', nullif(btrim(coalesce(p_notes, '')), ''), nullif(btrim(coalesce(s.cancellation_policy, '')), ''))
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken';
  end;

  if p_consultation is not null and v_created then
    if jsonb_typeof(p_consultation) <> 'object' or pg_column_size(p_consultation) >= 20000 then
      raise exception 'invalid_form';
    end if;
    if not coalesce(p_health_consent, false) then raise exception 'consent_required'; end if;
    if length(btrim(coalesce(p_signed_name, ''))) < 2 then raise exception 'signature_required'; end if;
    insert into public.consultation_forms (client_id, appointment_id, answers, health_consent, signed_name, consent_version)
    values (v_client.id, v_appt.id, p_consultation, true, left(btrim(p_signed_name), 100), public.current_consent_version());
    update public.clients set health_consent_at = now(), health_consent_note = 'Online consultation form'
     where id = v_client.id;
  end if;

  if v_ip is not null then
    insert into public.booking_attempts (ip) values (v_ip);
    delete from public.booking_attempts where at < now() - interval '2 days';
  end if;

  insert into public.email_outbox (kind, appointment_id, to_email)
  values ('booking_received', v_appt.id, v_email)
  on conflict do nothing;

  if coalesce(s.owner_email, '') <> '' then
    insert into public.email_outbox (kind, appointment_id, to_email)
    values ('owner_new_booking', v_appt.id, s.owner_email)
    on conflict do nothing;
  end if;

  -- Deliberately does not say whether the person was recognised as an
  -- existing client: that would let anyone test whether someone is a client.
  return jsonb_build_object('reference', v_appt.reference, 'starts_at', v_appt.starts_at);
exception
  when sqlstate 'P0001' then raise;                     -- our own short codes
  when others then raise exception 'booking_failed';    -- never echo a row back to the public key
end $$;

-- Consultation form link sent by email to new clients who did not fill it in
-- while booking.
create or replace function public.public_get_form(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'business_name', s.business_name,
    'first_name',    split_part(c.full_name, ' ', 1),
    'service_name',  a.service_name,
    'starts_at',     a.starts_at,
    'submitted',     exists (select 1 from public.consultation_forms f where f.appointment_id = a.id))
  from public.appointments a
  join public.clients c on c.id = a.client_id
  cross join public.settings s
  where a.public_token = p_token
    and s.id = 1
    and a.status in ('pending_deposit', 'confirmed')
    and a.starts_at > now() - interval '1 day'
$$;

create or replace function public.public_submit_form(
  p_token uuid, p_answers jsonb, p_health_consent boolean, p_signed_name text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_appt public.appointments;
begin
  select * into v_appt from public.appointments
   where public_token = p_token
     and status in ('pending_deposit', 'confirmed')
     and starts_at > now() - interval '1 day';
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from public.consultation_forms where appointment_id = v_appt.id) then
    raise exception 'already_submitted';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or pg_column_size(p_answers) >= 20000 then
    raise exception 'invalid_form';
  end if;
  if not coalesce(p_health_consent, false) then raise exception 'consent_required'; end if;
  if length(btrim(coalesce(p_signed_name, ''))) < 2 then raise exception 'signature_required'; end if;
  begin
    insert into public.consultation_forms (client_id, appointment_id, answers, health_consent, signed_name, consent_version)
    values (v_appt.client_id, v_appt.id, p_answers, true, left(btrim(p_signed_name), 100), public.current_consent_version());
  exception when unique_violation then
    raise exception 'already_submitted';
  end;
  update public.clients
     set health_consent_at = now(), health_consent_note = 'Online consultation form'
   where id = v_appt.client_id;
  return true;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'form_failed';
end $$;

-- ---------------------------------------------------------------------------
-- A client managing their own booking (the link in their emails)
--
-- The secret is the appointment's public_token: a random UUID that only ever
-- goes to the client (in their emails, or a WhatsApp from the owner). It is
-- never returned by public_create_booking, so booking with someone else's
-- email address doesn't give you their link.
-- ---------------------------------------------------------------------------

-- Put an email in the queue. p_requeue: send it again even if one of this kind
-- has gone before (a booking can be changed more than once).
create or replace function public.queue_email(p_appointment_id uuid, p_kind text, p_to text, p_requeue boolean default false)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if coalesce(btrim(p_to), '') = '' then return; end if;
  if p_requeue then
    insert into public.email_outbox (kind, appointment_id, to_email)
    values (p_kind, p_appointment_id, p_to)
    on conflict (appointment_id, kind) do update
       set status = 'pending', attempts = 0, last_error = null, to_email = excluded.to_email, claimed_at = null
     where public.email_outbox.status <> 'sending';   -- one going out right now is re-queued when it reports back
  else
    insert into public.email_outbox (kind, appointment_id, to_email)
    values (p_kind, p_appointment_id, p_to)
    on conflict (appointment_id, kind) do nothing;
  end if;
end $$;

-- Everything the manage page shows: the booking, the rules for picking a new
-- time, and the bank details while a deposit is still owed. Null when the link
-- is unknown or the appointment is more than a day in the past.
create or replace function public.public_get_booking(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s       public.settings;
  a       public.appointments;
  v_first text;
begin
  select * into s from public.settings where id = 1;
  select * into a from public.appointments
   where public_token = p_token and starts_at > now() - interval '1 day';
  if not found then return null; end if;
  select split_part(coalesce(nullif(a.booking_name, ''), c.full_name), ' ', 1) into v_first
    from public.clients c where c.id = a.client_id;
  return jsonb_build_object(
    'info',                public.public_booking_info(),
    'contact_phone',       s.owner_phone,
    'cancel_notice_hours', s.cancel_notice_hours,
    'client_self_service', s.client_self_service,
    'booking', jsonb_build_object(
      'reference',              a.reference,
      'status',                 a.status,
      'first_name',             v_first,
      'service_id',             a.service_id,
      'service_name',           a.service_name,
      'price_pence',            a.price_pence,
      'duration_min',           a.duration_min,
      'starts_at',              a.starts_at,
      'ends_at',                a.ends_at,
      'deposit_required_pence', a.deposit_required_pence,
      'deposit_due_at',         a.deposit_due_at,
      'deposit_paid',           a.deposit_paid_at is not null,
      'cancelled_at',           a.cancelled_at,
      'cancelled_by',           a.cancelled_by,
      'cancelled_late',         a.cancelled_late,
      'changes_left',           greatest(0, public.max_client_changes() - a.client_change_count),
      -- Whether a change or cancellation will be confirmed by email (not the address itself).
      'has_email',              exists (select 1 from public.clients c
                                         where c.id = a.client_id and coalesce(c.email, '') <> ''),
      'form_needed',            a.is_new_client and not exists (
                                  select 1 from public.consultation_forms f where f.client_id = a.client_id),
      -- Changes or cancellations after this time are inside the notice period.
      'free_until',             case when s.cancel_notice_hours > 0
                                     then a.starts_at - make_interval(hours => s.cancel_notice_hours) end),
    'bank', case when a.status = 'pending_deposit' then jsonb_build_object(
      'account_name',   s.bank_account_name,
      'sort_code',      s.bank_sort_code,
      'account_number', s.bank_account_number) end
  );
end $$;

-- Busy times for a client choosing a new time: the same as public_busy_times,
-- except their own appointment doesn't block them.
create or replace function public.public_busy_times_except(p_token uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  select a.id into v_id from public.appointments a where a.public_token = p_token;
  if v_id is null then raise exception 'not_found'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '400 days'
     or p_from < now() - interval '2 days' then
    raise exception 'invalid_range';
  end if;
  return query
    select a.starts_at, a.busy_until
      from public.appointments a
     where a.status in ('pending_deposit', 'confirmed', 'completed')
       and a.id <> v_id
       and tstzrange(a.starts_at, a.busy_until, '[)') && tstzrange(p_from, p_to, '[)')
    union all
    select t.starts_at, t.ends_at
      from public.time_off t
     where tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_from, p_to, '[)')
    order by 1;
end $$;

-- A client moves their booking and/or switches treatment. The new time has to
-- follow the same rules as a new online booking. Moving a booking inside the
-- notice period is allowed, but flagged for the owner.
create or replace function public.public_change_booking(p_token uuid, p_service_id uuid, p_starts_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s            public.settings;
  v_old        public.appointments;
  v_appt       public.appointments;
  v_service    public.services;
  v_service_id uuid;
  v_name       text;
  v_price      int;
  v_duration   int;
  v_start      timestamptz;
  v_moved      boolean;
  v_switched   boolean;
  v_late       boolean;
  v_email      text;
begin
  select * into s from public.settings where id = 1;
  select * into v_old from public.appointments where public_token = p_token for update;
  if not found then raise exception 'not_found'; end if;
  if v_old.status not in ('pending_deposit', 'confirmed') then raise exception 'not_changeable'; end if;
  if v_old.starts_at <= now() then raise exception 'too_late'; end if;
  if not s.client_self_service then raise exception 'changes_disabled'; end if;
  if not s.booking_enabled then raise exception 'booking_disabled'; end if;
  if v_old.client_change_count >= public.max_client_changes() then raise exception 'too_many_changes'; end if;

  -- Keeping the same treatment keeps the price it was booked at.
  if p_service_id is null or p_service_id is not distinct from v_old.service_id then
    v_service_id := v_old.service_id;
    v_name       := v_old.service_name;
    v_price      := v_old.price_pence;
    v_duration   := v_old.duration_min;
  else
    select * into v_service from public.services where id = p_service_id and is_active and online_bookable;
    if not found then raise exception 'invalid_service'; end if;
    v_service_id := v_service.id;
    v_name       := v_service.name;
    v_price      := v_service.price_pence;
    v_duration   := v_service.duration_min;
  end if;
  v_start    := coalesce(p_starts_at, v_old.starts_at);
  v_moved    := v_start <> v_old.starts_at;
  v_switched := v_service_id is distinct from v_old.service_id or v_duration <> v_old.duration_min;
  if not v_moved and not v_switched then raise exception 'no_change'; end if;

  perform public.check_bookable_time(v_start, v_duration);

  v_late := v_moved and s.cancel_notice_hours > 0
            and now() > v_old.starts_at - make_interval(hours => s.cancel_notice_hours);
  select email into v_email from public.clients where id = v_old.client_id;

  begin
    update public.appointments
       set service_id = v_service_id, service_name = v_name, price_pence = v_price, duration_min = v_duration,
           starts_at = v_start,           -- ends_at / busy_until / reminders follow in the trigger
           client_change_count = client_change_count + 1, client_changed_at = now(),
           -- Only when an email will actually carry the new details (a client with
           -- no email, using the link from a WhatsApp, still gets a reminder later).
           details_sent_at = case when coalesce(btrim(v_email), '') <> '' then now() else details_sent_at end
     where id = v_old.id
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception 'slot_taken';
  end;

  insert into public.client_changes (appointment_id, action, old_starts_at, new_starts_at,
                                     old_service_name, new_service_name, old_price_pence, new_price_pence, late)
  values (v_appt.id,
          case when v_moved and v_switched then 'moved_treatment' when v_moved then 'moved' else 'treatment' end,
          v_old.starts_at, v_appt.starts_at, v_old.service_name, v_appt.service_name,
          v_old.price_pence, v_appt.price_pence, v_late);

  -- Tell the client and the owner. A confirmation or new-booking alert that
  -- hasn't gone yet will carry the new details anyway, so it isn't doubled up.
  if not exists (select 1 from public.email_outbox
                  where appointment_id = v_appt.id and kind = 'booking_received' and status = 'pending') then
    perform public.queue_email(v_appt.id, 'changed', v_email, true);
  end if;
  if not exists (select 1 from public.email_outbox
                  where appointment_id = v_appt.id and kind = 'owner_new_booking' and status = 'pending') then
    perform public.queue_email(v_appt.id, 'owner_changed', s.owner_email, true);
  end if;

  return jsonb_build_object(
    'reference',    v_appt.reference,
    'starts_at',    v_appt.starts_at,
    'service_name', v_appt.service_name,
    'price_pence',  v_appt.price_pence,
    'late',         v_late);
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'change_failed';
end $$;

-- A client cancels. Always allowed before the appointment starts; inside the
-- notice period it is flagged as a late cancellation, and the owner decides
-- what to charge (the app doesn't take payments).
create or replace function public.public_cancel_booking(p_token uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s        public.settings;
  v_appt   public.appointments;
  v_late   boolean;
  v_email  text;
  -- One line of plain text: newlines, tabs and runs of spaces become one space,
  -- trimmed again after the cut so it never ends in a space.
  v_reason text := nullif(btrim(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 300)), '');
begin
  select * into s from public.settings where id = 1;
  select * into v_appt from public.appointments where public_token = p_token for update;
  if not found then raise exception 'not_found'; end if;
  if v_appt.status not in ('pending_deposit', 'confirmed') then raise exception 'not_changeable'; end if;
  if v_appt.starts_at <= now() then raise exception 'too_late'; end if;
  if not s.client_self_service then raise exception 'changes_disabled'; end if;

  v_late := s.cancel_notice_hours > 0 and now() > v_appt.starts_at - make_interval(hours => s.cancel_notice_hours);

  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'client', cancelled_late = v_late,
         cancel_reason = v_reason, client_changed_at = now()
   where id = v_appt.id
  returning * into v_appt;

  -- Reminders and change notices still waiting are no longer wanted.
  update public.email_outbox set status = 'skipped'
   where appointment_id = v_appt.id and status = 'pending' and kind not in ('cancelled', 'owner_cancelled');

  insert into public.client_changes (appointment_id, action, old_starts_at, old_service_name, old_price_pence, late, note)
  values (v_appt.id, 'cancelled', v_appt.starts_at, v_appt.service_name, v_appt.price_pence, v_late, v_reason);

  select email into v_email from public.clients where id = v_appt.client_id;
  perform public.queue_email(v_appt.id, 'cancelled', v_email);
  perform public.queue_email(v_appt.id, 'owner_cancelled', s.owner_email);

  return jsonb_build_object('cancelled', true, 'late', v_late);
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'cancel_failed';
end $$;

-- ---------------------------------------------------------------------------
-- Owner actions that must happen together (all-or-nothing)
-- ---------------------------------------------------------------------------

create or replace function public.owner_mark_deposit_paid(p_appointment_id uuid, p_method text)
returns public.appointments language plpgsql volatile security definer set search_path = public as $$
declare
  v_appt   public.appointments;
  v_client public.clients;
  s        public.settings;
begin
  if not public.is_owner() then raise exception 'not_allowed'; end if;
  if p_method not in ('cash', 'bank_transfer') then raise exception 'invalid_method'; end if;
  select * into s from public.settings where id = 1;
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_appt.status <> 'pending_deposit' then raise exception 'not_pending_deposit'; end if;
  select * into v_client from public.clients where id = v_appt.client_id;

  -- The "you're confirmed" email carries the full details, so when it goes out
  -- inside the reminder window a reminder isn't sent straight after it.
  update public.appointments
     set status = 'confirmed', deposit_paid_at = now(),
         details_sent_at = case when coalesce(v_client.email, '') <> '' then now() else details_sent_at end
   where id = v_appt.id
  returning * into v_appt;

  if v_appt.deposit_required_pence > 0 then
    insert into public.payments (appointment_id, client_id, client_name, description, amount_pence, method, kind, paid_on)
    values (v_appt.id, v_client.id, v_client.full_name, 'Deposit · ' || v_appt.service_name,
            v_appt.deposit_required_pence, p_method, 'deposit', (now() at time zone s.timezone)::date);
  end if;

  if coalesce(v_client.email, '') <> '' then
    insert into public.email_outbox (kind, appointment_id, to_email)
    values ('deposit_received', v_appt.id, v_client.email)
    on conflict do nothing;
  end if;
  return v_appt;
end $$;

-- Finish an appointment and record what was paid on the day (the deposit, if
-- any, was recorded when it arrived, so only pass the balance here).
create or replace function public.owner_complete_appointment(
  p_appointment_id uuid, p_amount_pence int, p_method text, p_tip_pence int default 0, p_note text default null)
returns public.appointments language plpgsql volatile security definer set search_path = public as $$
declare
  v_appt   public.appointments;
  v_client public.clients;
  s        public.settings;
  v_today  date;
begin
  if not public.is_owner() then raise exception 'not_allowed'; end if;
  if p_method not in ('cash', 'bank_transfer') then raise exception 'invalid_method'; end if;
  if coalesce(p_amount_pence, 0) < 0 or coalesce(p_tip_pence, 0) < 0 then raise exception 'invalid_amount'; end if;
  select * into s from public.settings where id = 1;
  v_today := (now() at time zone s.timezone)::date;
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_appt.status not in ('confirmed', 'pending_deposit') then raise exception 'not_completable'; end if;
  select * into v_client from public.clients where id = v_appt.client_id;

  update public.appointments set status = 'completed' where id = v_appt.id returning * into v_appt;

  if coalesce(p_amount_pence, 0) > 0 then
    insert into public.payments (appointment_id, client_id, client_name, description, amount_pence, method, kind, paid_on, note)
    values (v_appt.id, v_client.id, v_client.full_name, v_appt.service_name, p_amount_pence, p_method, 'payment', v_today,
            nullif(btrim(coalesce(p_note, '')), ''));
  end if;
  if coalesce(p_tip_pence, 0) > 0 then
    insert into public.payments (appointment_id, client_id, client_name, description, amount_pence, method, kind, paid_on)
    values (v_appt.id, v_client.id, v_client.full_name, 'Tip · ' || v_appt.service_name, p_tip_pence, p_method, 'tip', v_today);
  end if;
  return v_appt;
end $$;

-- p_late: the client cancelled with too little notice (told her by phone or
-- WhatsApp), so the booking is flagged like a late online cancellation.
drop function if exists public.owner_cancel_appointment(uuid, text, boolean);

create or replace function public.owner_cancel_appointment(
  p_appointment_id uuid, p_reason text default null, p_notify boolean default true, p_late boolean default false)
returns public.appointments language plpgsql volatile security definer set search_path = public as $$
declare
  v_appt   public.appointments;
  v_client public.clients;
begin
  if not public.is_owner() then raise exception 'not_allowed'; end if;
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_appt.status not in ('pending_deposit', 'confirmed') then raise exception 'not_cancellable'; end if;
  select * into v_client from public.clients where id = v_appt.client_id;

  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'owner', cancelled_late = coalesce(p_late, false),
         cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = v_appt.id
  returning * into v_appt;

  -- Any reminder still waiting is no longer wanted.
  update public.email_outbox set status = 'skipped'
   where appointment_id = v_appt.id and status = 'pending' and kind not in ('cancelled', 'owner_cancelled');

  if p_notify and coalesce(v_client.email, '') <> '' then
    insert into public.email_outbox (kind, appointment_id, to_email)
    values ('cancelled', v_appt.id, v_client.email)
    on conflict do nothing;
  end if;
  return v_appt;
end $$;

-- Queue (or re-queue) a confirmation email for an appointment the owner made,
-- or a "your booking has changed" email after she moves one.
create or replace function public.owner_queue_email(p_appointment_id uuid, p_kind text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_email text;
begin
  if not public.is_owner() then raise exception 'not_allowed'; end if;
  if p_kind not in ('booking_received', 'deposit_received', 'reminder', 'changed') then raise exception 'invalid_kind'; end if;
  select c.email into v_email
    from public.appointments a join public.clients c on c.id = a.client_id
   where a.id = p_appointment_id and a.status in ('pending_deposit', 'confirmed');
  if coalesce(v_email, '') = '' then raise exception 'no_email'; end if;
  insert into public.email_outbox (kind, appointment_id, to_email)
  values (p_kind, p_appointment_id, v_email)
  on conflict (appointment_id, kind) do update
     set status = 'pending', attempts = 0, last_error = null, to_email = excluded.to_email,
         claimed_at = null, sent_at = null
   where public.email_outbox.status <> 'sending';   -- never re-queue one that is going out right now
  if p_kind in ('booking_received', 'deposit_received', 'changed') then
    update public.appointments set details_sent_at = now() where id = p_appointment_id;
  end if;
  return true;
end $$;

-- A client withdraws consent for their health information, but stays a client:
-- remove consultation forms, patch tests and allergy notes, keep everything else.
create or replace function public.owner_delete_health_data(p_client_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not_allowed'; end if;
  delete from public.consultation_forms where client_id = p_client_id;
  delete from public.patch_tests where client_id = p_client_id;
  update public.clients set allergies = null, health_consent_at = null, health_consent_note = null
   where id = p_client_id;
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- Email sender (Apps Script) functions — protected by a shared secret
-- ---------------------------------------------------------------------------

create or replace function public.email_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_secret, '') <> ''
     and exists (select 1 from public.settings
                  where id = 1
                    and email_secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'))
$$;

-- Queue any reminders that are now due, then hand over up to 50 emails to send.
drop function if exists public.email_jobs_claim(text);

-- p_limit: how many emails the sender can still send today (Gmail's daily quota).
create or replace function public.email_jobs_claim(p_secret text, p_limit int default 50)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s      public.settings;
  v_jobs jsonb;
begin
  if not public.email_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  update public.settings set email_last_poll_at = now() where id = 1 returning * into s;

  -- Optional: release online bookings whose deposit didn't arrive in time,
  -- and tell the client.
  if s.auto_cancel_unpaid then
    with released as (
      update public.appointments
         set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system',
             cancel_reason = 'The deposit didn''t arrive in time, so the slot has been released.'
       where status = 'pending_deposit' and source = 'online' and deposit_due_at < now()
      returning id, client_id
    )
    insert into public.email_outbox (kind, appointment_id, to_email)
    select 'cancelled', r.id, c.email
      from released r join public.clients c on c.id = r.client_id
     where coalesce(c.email, '') <> ''
    on conflict (appointment_id, kind) do nothing;
  end if;

  -- Reminders: confirmed appointments starting within the reminder window,
  -- whose details didn't already go out inside that window (a last-minute
  -- booking, or a change the client has just been emailed about), and at
  -- least two hours away.
  insert into public.email_outbox (kind, appointment_id, to_email)
  select 'reminder', a.id, c.email
    from public.appointments a
    join public.clients c on c.id = a.client_id
   where a.status = 'confirmed'
     and coalesce(c.email, '') <> ''
     and a.starts_at >  now() + interval '2 hours'
     and a.starts_at <= now() + make_interval(hours => s.reminder_hours_before)
     and greatest(a.created_at, a.details_sent_at) < a.starts_at - make_interval(hours => s.reminder_hours_before)
  on conflict (appointment_id, kind) do nothing;

  -- Anything about an appointment that has since been cancelled is dropped
  -- (except the cancellation notices themselves).
  update public.email_outbox o set status = 'skipped'
    from public.appointments a
   where a.id = o.appointment_id
     and o.status in ('pending', 'sending')
     and o.kind not in ('cancelled', 'owner_cancelled')
     and a.status in ('cancelled', 'no_show');

  update public.email_outbox set status = 'failed', last_error = coalesce(last_error, 'no report from sender')
   where status = 'sending' and attempts >= 5 and claimed_at < now() - interval '15 minutes';

  with claimed as (
    update public.email_outbox o
       set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
     where o.id in (
       select id from public.email_outbox
        where (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '15 minutes'))
          and attempts < 5
        order by id
        limit greatest(0, least(coalesce(p_limit, 50), 50))
        for update skip locked)
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                     cl.id,
           'kind',                   cl.kind,
           'to',                     cl.to_email,
           'reference',              a.reference,
           'status',                 a.status,
           'client_name',            c.full_name,
           'booking_name',           a.booking_name,
           'first_name',             split_part(coalesce(nullif(a.booking_name, ''), c.full_name), ' ', 1),
           'service_name',           a.service_name,
           'price_pence',            a.price_pence,
           'starts_at',              a.starts_at,
           'ends_at',                a.ends_at,
           'is_new_client',          a.is_new_client,
           'deposit_required_pence', a.deposit_required_pence,
           'deposit_due_at',         a.deposit_due_at,
           'client_notes',           a.client_notes,
           'client_phone',           c.phone,
           'client_email',           c.email,
           'form_needed',            a.is_new_client and not exists (
                                       select 1 from public.consultation_forms f where f.client_id = a.client_id),
           'form_url',               case when coalesce(s.public_site_url, '') <> ''
                                          then rtrim(s.public_site_url, '/') || '/form/' || a.public_token end,
           -- The client's own change/cancel page. Only ever goes in emails to the client.
           'manage_url',             case when coalesce(s.public_site_url, '') <> ''
                                          then rtrim(s.public_site_url, '/') || '/manage/' || a.public_token end,
           'free_until',             case when s.cancel_notice_hours > 0
                                          then a.starts_at - make_interval(hours => s.cancel_notice_hours) end,
           'deposit_paid',           a.deposit_paid_at is not null,
           'cancel_reason',          a.cancel_reason,
           'cancelled_by',           a.cancelled_by,
           'cancelled_late',         a.cancelled_late,
           -- The client's last few online changes, oldest first (for the owner's alert).
           'changes',                (select coalesce(jsonb_agg(jsonb_build_object(
                                         'at',               x.changed_at,
                                         'action',           x.action,
                                         'old_starts_at',    x.old_starts_at,
                                         'new_starts_at',    x.new_starts_at,
                                         'old_service_name', x.old_service_name,
                                         'new_service_name', x.new_service_name,
                                         'late',             x.late) order by x.changed_at, x.id), '[]'::jsonb)
                                        from (select * from public.client_changes h
                                               where h.appointment_id = a.id
                                               order by h.changed_at desc, h.id desc limit 3) x)
         ) order by cl.id), '[]'::jsonb)
    into v_jobs
    from claimed cl
    join public.appointments a on a.id = cl.appointment_id
    join public.clients c on c.id = a.client_id;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'business_name',       s.business_name,
      'owner_email',         s.owner_email,
      'owner_phone',         s.owner_phone,
      'address',             s.address,
      'timezone',            s.timezone,
      'cancellation_policy', s.cancellation_policy,
      'cancel_notice_hours', s.cancel_notice_hours,
      'client_self_service', s.client_self_service,
      'bank_account_name',   s.bank_account_name,
      'bank_sort_code',      s.bank_sort_code,
      'bank_account_number', s.bank_account_number,
      'public_site_url',     s.public_site_url),
    'jobs', v_jobs);
end $$;

-- p_results: [{"id": 12, "ok": true}, {"id": 13, "ok": false, "error": "…"}]
create or replace function public.email_jobs_report(p_secret text, p_results jsonb)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  r       jsonb;
  v_count int := 0;
  v_row   public.email_outbox;
  v_hit   boolean;
begin
  if not public.email_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' then raise exception 'invalid_results'; end if;
  for r in select * from jsonb_array_elements(p_results) loop
    if coalesce((r->>'ok')::boolean, false) then
      update public.email_outbox
         set status = 'sent', sent_at = now(), last_error = null
       where id = (r->>'id')::bigint and status = 'sending'
      returning * into v_row;
      v_hit := found;
      if v_hit and v_row.kind = 'reminder' then
        begin
          update public.appointments set reminder_email_sent_at = now() where id = v_row.appointment_id;
        exception when others then null;
        end;
      end if;
      -- The client changed the booking again while this notice was going out:
      -- send it once more so the latest details arrive.
      if v_hit and v_row.kind in ('changed', 'owner_changed') and exists (
           select 1 from public.appointments
            where id = v_row.appointment_id and client_changed_at > v_row.claimed_at
              and status in ('pending_deposit', 'confirmed')) then
        update public.email_outbox set status = 'pending', attempts = 0, claimed_at = null where id = v_row.id;
      end if;
    else
      update public.email_outbox
         set status = case when attempts >= 5 then 'failed' else 'pending' end,
             last_error = left(coalesce(r->>'error', 'unknown error'), 500)
       where id = (r->>'id')::bigint and status = 'sending'
      returning * into v_row;
      v_hit := found;
    end if;
    if v_hit then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security: the owner, and only the owner, can touch the tables
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['owner', 'settings', 'opening_hours', 'services', 'clients', 'patch_tests',
                           'appointments', 'consultation_forms', 'time_off', 'payments',
                           'client_photos', 'email_outbox', 'booking_attempts', 'client_changes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated
                      using ((select public.is_owner())) with check ((select public.is_owner()))', t);
    -- Belt and braces: the public key gets no table access at all.
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Explicit grants. Newer Supabase projects no longer grant table access to the
-- API roles automatically, so say it out loud: the signed-in owner gets table
-- access (still filtered by the policies above); the public key gets none.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- The owner row itself is read-only from the app (claim_owner() writes it).
revoke insert, update, delete on public.owner from authenticated;

-- ---------------------------------------------------------------------------
-- Who may call which function
-- ---------------------------------------------------------------------------

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proowner = current_user::regrole
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function public.public_owner_exists()                       to anon, authenticated;
grant execute on function public.public_booking_info()                       to anon, authenticated;
grant execute on function public.public_busy_times(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text, boolean)
                                                                              to anon, authenticated;
grant execute on function public.public_get_form(uuid)                       to anon, authenticated;
grant execute on function public.public_submit_form(uuid, jsonb, boolean, text) to anon, authenticated;
grant execute on function public.public_get_booking(uuid)                    to anon, authenticated;
grant execute on function public.public_busy_times_except(uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.public_change_booking(uuid, uuid, timestamptz) to anon, authenticated;
grant execute on function public.public_cancel_booking(uuid, text)           to anon, authenticated;
grant execute on function public.email_jobs_claim(text, int)                 to anon;
grant execute on function public.email_jobs_report(text, jsonb)              to anon;

grant execute on function public.is_owner()                                  to authenticated;
grant execute on function public.claim_owner()                               to authenticated;
grant execute on function public.normalize_uk_phone(text)                    to authenticated;
grant execute on function public.gen_reference()                             to authenticated;
grant execute on function public.owner_mark_deposit_paid(uuid, text)         to authenticated;
grant execute on function public.owner_complete_appointment(uuid, int, text, int, text) to authenticated;
grant execute on function public.owner_cancel_appointment(uuid, text, boolean, boolean) to authenticated;
grant execute on function public.owner_queue_email(uuid, text)               to authenticated;
grant execute on function public.owner_delete_health_data(uuid)               to authenticated;
