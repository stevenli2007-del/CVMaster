-- CP2 review fix: prevent direct Data API deletes from bypassing file cleanup.
-- Apply after 20261124220000_cp2_identity_and_materials.sql. Application delete
-- actions verify the caller and remove Storage objects before using a server-only
-- service-role client for the final database delete.

begin;

revoke delete on table public.profiles from anon, authenticated;
revoke delete on table public.experiences from anon, authenticated;
revoke delete on table public.materials from anon, authenticated;

drop policy if exists profiles_delete_own on public.profiles;
drop policy if exists experiences_delete_own on public.experiences;
drop policy if exists materials_delete_own on public.materials;

commit;
