-- =============================================================================
-- Private photo storage for client nail photos. Run after schema.sql.
--
-- The bucket is private: photos are never reachable by a public link. The app
-- shows them through short-lived signed URLs that only the signed-in owner can
-- create.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-photos', 'client-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owner reads client photos"   on storage.objects;
drop policy if exists "owner adds client photos"    on storage.objects;
drop policy if exists "owner updates client photos" on storage.objects;
drop policy if exists "owner deletes client photos" on storage.objects;

create policy "owner reads client photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'client-photos' and public.is_owner());

create policy "owner adds client photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'client-photos' and public.is_owner());

create policy "owner updates client photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'client-photos' and public.is_owner())
  with check (bucket_id = 'client-photos' and public.is_owner());

create policy "owner deletes client photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'client-photos' and public.is_owner());
