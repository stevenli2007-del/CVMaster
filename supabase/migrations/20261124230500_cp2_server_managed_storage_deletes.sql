-- CP2 review fix: keep Storage and database deletes on the coordinated server path.
-- Apply after 20261124224500_cp2_server_managed_deletes.sql. Users retain private
-- upload/read access, but only the server-side service role can delete objects
-- after the application verifies ownership and coordinates the database delete.

begin;

drop policy if exists materials_objects_delete_own on storage.objects;

commit;
