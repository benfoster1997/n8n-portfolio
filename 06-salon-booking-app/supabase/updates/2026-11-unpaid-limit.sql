-- =============================================================================
-- Update, November 2026: old unpaid bookings no longer stop online booking
--
-- For an app set up with an older schema.sql, from before this version (if you're
-- not sure, run it: it's safe on any install). Run it once: Supabase → SQL Editor
-- → New query → paste all of this file → Run. It should say "Success. No rows
-- returned". It doesn't depend on the app, so before or after the new version of
-- the app goes live are both fine.
--
-- The booking page turns everyone away ("Lots of bookings are coming in right
-- now") while 15 online bookings are waiting for a deposit. Until now that count
-- included bookings whose time had passed, such as a new client who never paid
-- and never came, so a few old ones left at "Deposit due" could quietly switch
-- online booking off. Now only bookings that haven't started yet are counted.
--
-- It replaces that one database function (public_create_booking) with the
-- version in schema.sql. Who can use it stays the same, and it changes nothing
-- else: no tables, no settings and no bookings. Running it again is safe.
--
-- A new install doesn't need it: schema.sql already includes this version.
-- =============================================================================

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
  -- Bookings waiting for a deposit count only until they start: an old one
  -- nobody finished, marked as a no-show or cancelled mustn't turn clients away.
  if (select count(*) from public.appointments where source = 'online' and created_at > now() - interval '1 hour') >= 6
     or (select count(*) from public.appointments where source = 'online' and created_at > now() - interval '1 day') >= 25
     or (select count(*) from public.appointments where source = 'online' and status = 'pending_deposit'
                                                   and starts_at > now()) >= 15
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
      reference, client_notes, cancellation_policy_agreed, booking_phone)
    values (
      v_client.id, v_service.id, v_service.name, v_service.price_pence, v_service.duration_min,
      p_starts_at, p_starts_at, p_starts_at,             -- ends_at / busy_until recomputed by trigger
      case when v_deposit > 0 then 'pending_deposit' else 'confirmed' end,
      'online', v_name, v_is_new, v_deposit,
      case when v_deposit > 0 then least(now() + make_interval(hours => s.deposit_deadline_hours), p_starts_at) end,
      '', nullif(btrim(coalesce(p_notes, '')), ''), nullif(btrim(coalesce(s.cancellation_policy, '')), ''),
      -- A returning client who typed a different mobile: kept for the owner to
      -- check, so reminders and links never go to a number nobody has confirmed.
      case when not v_created and v_phone is distinct from v_client.phone_e164 then btrim(p_phone) end)
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

-- The booking page calls it with Supabase's public key, as before.
grant execute on function public.public_create_booking(uuid, timestamptz, text, text, text, text, jsonb, boolean, text, boolean)
  to anon, authenticated;
