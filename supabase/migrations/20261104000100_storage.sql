-- Storage: private bucket "user-files". Each user only touches objects under "<user id>/...", with a quota in
-- bytes and in number of files (checked on uploads and overwrites).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-files', 'user-files', false, 26214400,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do nothing;

-- Quota per user in bytes. Change it in a new migration and keep USER_STORAGE_QUOTA_BYTES in
-- src/features/files/config.ts in sync (used only for messages in the UI).
create function public.storage_quota_bytes() returns bigint
language sql immutable set search_path = '' as $$
  select 1073741824::bigint; -- 1 GiB
$$;
revoke execute on function public.storage_quota_bytes() from public, anon;
grant execute on function public.storage_quota_bytes() to authenticated, service_role;

-- Bytes already stored by the signed-in user in "user-files". EXECUTE plans the query with the real prefix, so
-- `name like '<uid>/%'` is a constant prefix match that can use the index on storage.objects (bucket_id, name)
-- instead of splitting every object name with storage.foldername().
create function public.user_storage_bytes() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v_total bigint;
begin
  execute 'select coalesce(sum((metadata ->> ''size'')::bigint), 0) from storage.objects '
       || 'where bucket_id = $1 and name like $2'
    into v_total
    using 'user-files', (select auth.uid())::text || '/%';
  return coalesce(v_total, 0);
end;
$$;
revoke execute on function public.user_storage_bytes() from public, anon;
grant execute on function public.user_storage_bytes() to authenticated, service_role;

-- Files per user: empty files add no bytes, so the count is capped too (row bloat). Keep in sync with
-- USER_STORAGE_QUOTA_FILES in src/features/files/config.ts.
create function public.storage_quota_files() returns bigint
language sql immutable set search_path = '' as $$
  select 10000::bigint;
$$;
revoke execute on function public.storage_quota_files() from public, anon;
grant execute on function public.storage_quota_files() to authenticated, service_role;

-- Can the signed-in user write object `p_name` with `p_new_size` bytes? Used by the INSERT and the UPDATE policies
-- (an upsert/overwrite runs as UPDATE): total = stored bytes - bytes of the object being replaced + new bytes.
-- A new name also counts against the file cap. The new size is only known when Storage sends it in metadata, so
-- the last write can exceed the byte quota by at most the bucket's per-file limit.
create function public.storage_write_allowed(p_name text, p_new_size bigint) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_bytes bigint;
  v_files bigint;
  v_old bigint;
  v_exists boolean;
begin
  execute 'select coalesce(sum((metadata ->> ''size'')::bigint), 0), count(*) from storage.objects '
       || 'where bucket_id = $1 and name like $2'
    into v_bytes, v_files
    using 'user-files', (select auth.uid())::text || '/%';
  select true, (o.metadata ->> 'size')::bigint into v_exists, v_old
  from storage.objects o where o.bucket_id = 'user-files' and o.name = p_name;
  if not coalesce(v_exists, false) and v_files >= public.storage_quota_files() then
    return false;
  end if;
  return v_bytes - coalesce(v_old, 0) + coalesce(p_new_size, 0) <= public.storage_quota_bytes();
end;
$$;
revoke execute on function public.storage_write_allowed(text, bigint) from public, anon;
grant execute on function public.storage_write_allowed(text, bigint) to authenticated, service_role;

-- Owner = first path segment, checked with a prefix LIKE (no per-row array split).
create policy "user-files: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-files' and name like ((select auth.uid())::text || '/%'));

-- Quota (bytes and files) on every write, including overwrites (upsert = UPDATE): see storage_write_allowed().
-- A JWT stays valid for up to 1h after the account is deleted: without a profile there is no upload (no orphans).
create policy "user-files: upload own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-files'
    and name like ((select auth.uid())::text || '/%')
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()))
    and public.storage_write_allowed(name, (metadata ->> 'size')::bigint)
  );
create policy "user-files: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'user-files' and name like ((select auth.uid())::text || '/%'))
  with check (
    bucket_id = 'user-files'
    and name like ((select auth.uid())::text || '/%')
    and public.storage_write_allowed(name, (metadata ->> 'size')::bigint)
  );
create policy "user-files: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'user-files' and name like ((select auth.uid())::text || '/%'));

-- Two-step verification: enrolled users need aal2 for their files too (see mfa_satisfied()).
create policy "mfa: aal2 when enrolled (user-files)" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'user-files' or (select public.mfa_satisfied()))
  with check (bucket_id <> 'user-files' or (select public.mfa_satisfied()));
