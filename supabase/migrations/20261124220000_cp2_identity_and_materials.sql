-- CP2: identity, experiences, materials, and private file storage.
-- Safe for a fresh project and for projects that applied the earlier two-file
-- CP2 migration (20261124173000 / 20261124173100). This migration is rerunnable:
-- it preserves user rows and objects while converging constraints and policies.
-- Apply in a development Supabase project first. All application access uses the
-- caller's JWT; no service-role credential is required by the application.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  contact jsonb not null default '{}'::jsonb,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.experiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text,
  summary text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  experience_id uuid not null,
  type text not null,
  source_url text,
  object_key text,
  text_content text,
  original_filename text,
  mime_type text,
  size_bytes bigint,
  content_hash text,
  processing_status text not null default 'ready',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Converge constraints introduced by either the fresh or legacy CP2 schema.
-- No user content is truncated or rewritten. Existing rows that violate a
-- current constraint abort the transaction instead of being silently changed.
alter table public.profiles drop constraint if exists profiles_display_name_check;
alter table public.profiles
  add constraint profiles_display_name_check check (char_length(display_name) <= 80);
alter table public.profiles drop constraint if exists profiles_contact_check;
alter table public.profiles
  add constraint profiles_contact_check check (jsonb_typeof(contact) = 'object');
alter table public.profiles drop constraint if exists profiles_locale_check;
alter table public.profiles
  add constraint profiles_locale_check check (char_length(locale) <= 20);

alter table public.experiences drop constraint if exists experiences_name_check;
alter table public.experiences
  add constraint experiences_name_check check (char_length(name) between 1 and 80);
alter table public.experiences drop constraint if exists experiences_status_check;
alter table public.experiences
  add constraint experiences_status_check check (status in ('active', 'archived'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass
      and conname = 'experiences_id_user_id_key'
  ) then
    alter table public.experiences
      add constraint experiences_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.materials'::regclass
      and conname = 'materials_experience_owner_fkey'
  ) and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.materials'::regclass
      and conname = 'materials_experience_id_user_id_fkey'
  ) then
    alter table public.materials
      add constraint materials_experience_owner_fkey
      foreign key (experience_id, user_id)
      references public.experiences(id, user_id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.materials'::regclass
      and conname = 'materials_id_user_id_key'
  ) then
    alter table public.materials
      add constraint materials_id_user_id_key unique (id, user_id);
  end if;
end;
$$;

alter table public.materials drop constraint if exists materials_type_check;
alter table public.materials
  add constraint materials_type_check
  check (type in ('web', 'github', 'note', 'voice', 'image', 'file'));
alter table public.materials drop constraint if exists materials_processing_status_check;
alter table public.materials
  add constraint materials_processing_status_check
  check (processing_status in ('queued', 'processing', 'ready', 'failed'));

-- Legacy payload/object-key checks are replaced together. Legacy keys with a
-- filename extension and current UUID-only keys both satisfy the owner prefix.
alter table public.materials drop constraint if exists materials_payload_matches_type;
alter table public.materials drop constraint if exists materials_object_key_shape;
alter table public.materials drop constraint if exists materials_source_shape;
alter table public.materials
  add constraint materials_source_shape check (
    (
      type = 'note'
      and text_content is not null
      and char_length(text_content) between 1 and 20000
      and source_url is null
      and object_key is null
    ) or (
      type in ('web', 'github')
      and source_url is not null
      and char_length(source_url) <= 2048
      and source_url ~* '^https?://'
      and text_content is null
      and object_key is null
    ) or (
      type in ('voice', 'image', 'file')
      and object_key is not null
      and object_key like (user_id::text || '/%')
      and original_filename is not null
      and char_length(original_filename) between 1 and 255
      and mime_type is not null
      and size_bytes is not null
      and size_bytes > 0
      and size_bytes <= 4194304
      and source_url is null
      and text_content is null
    )
  );

create index if not exists experiences_user_created_idx
  on public.experiences (user_id, created_at desc);
create index if not exists materials_user_created_idx
  on public.materials (user_id, created_at desc);
create index if not exists materials_experience_created_idx
  on public.materials (experience_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists experiences_set_updated_at on public.experiences;
drop trigger if exists experiences_touch_updated_at on public.experiences;
create trigger experiences_set_updated_at
before update on public.experiences
for each row execute function public.set_updated_at();

drop trigger if exists materials_set_updated_at on public.materials;
drop trigger if exists materials_touch_updated_at on public.materials;
create trigger materials_set_updated_at
before update on public.materials
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill accounts that existed before this migration.
insert into public.profiles (id, display_name)
select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 80)
from auth.users
on conflict (id) do nothing;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.experiences from anon, authenticated;
revoke all on table public.materials from anon, authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.experiences to authenticated;
grant select, insert, update, delete on table public.materials to authenticated;

alter table public.profiles enable row level security;
alter table public.experiences enable row level security;
alter table public.materials enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select to authenticated using ((select auth.uid()) = id);
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
for delete to authenticated using ((select auth.uid()) = id);

drop policy if exists experiences_select_own on public.experiences;
create policy experiences_select_own on public.experiences
for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists experiences_insert_own on public.experiences;
create policy experiences_insert_own on public.experiences
for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists experiences_update_own on public.experiences;
create policy experiences_update_own on public.experiences
for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists experiences_delete_own on public.experiences;
create policy experiences_delete_own on public.experiences
for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists materials_select_own on public.materials;
create policy materials_select_own on public.materials
for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists materials_insert_own on public.materials;
create policy materials_insert_own on public.materials
for insert to authenticated with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.experiences
    where id = experience_id and user_id = (select auth.uid())
  )
);
drop policy if exists materials_update_own on public.materials;
create policy materials_update_own on public.materials
for update to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.experiences
    where id = experience_id and user_id = (select auth.uid())
  )
);
drop policy if exists materials_delete_own on public.materials;
create policy materials_delete_own on public.materials
for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'materials',
  'materials',
  false,
  4194304,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Object keys are <auth user UUID>/<experience UUID>/<material UUID> with an
-- optional legacy extension. The experience predicate blocks cross-owner paths.
drop policy if exists materials_objects_select_own on storage.objects;
create policy materials_objects_select_own on storage.objects
for select to authenticated using (
  bucket_id = 'materials'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.experiences
    where id::text = (storage.foldername(name))[2]
      and user_id = (select auth.uid())
  )
);
drop policy if exists materials_objects_insert_own on storage.objects;
create policy materials_objects_insert_own on storage.objects
for insert to authenticated with check (
  bucket_id = 'materials'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.experiences
    where id::text = (storage.foldername(name))[2]
      and user_id = (select auth.uid())
  )
);
drop policy if exists materials_objects_update_own on storage.objects;
create policy materials_objects_update_own on storage.objects
for update to authenticated using (
  bucket_id = 'materials'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.experiences
    where id::text = (storage.foldername(name))[2]
      and user_id = (select auth.uid())
  )
) with check (
  bucket_id = 'materials'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.experiences
    where id::text = (storage.foldername(name))[2]
      and user_id = (select auth.uid())
  )
);
drop policy if exists materials_objects_delete_own on storage.objects;
create policy materials_objects_delete_own on storage.objects
for delete to authenticated using (
  bucket_id = 'materials'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.experiences
    where id::text = (storage.foldername(name))[2]
      and user_id = (select auth.uid())
  )
);

commit;

-- Forward fixes are preferred. Never drop these tables, triggers, bucket objects,
-- or policies on production data without an explicit backup and deletion approval.
