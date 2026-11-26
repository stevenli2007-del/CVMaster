-- CP3 schema forward-fix slice: tighten materials permissions so the
-- authenticated client can no longer write server-managed columns. This is the
-- implementation of CP3 schema/RLS design §7 item 1 and §4 (materials row).
--
-- Depends on 20261124220000_cp2_identity_and_materials.sql (CP2 grants),
-- 20261124224500_cp2_server_managed_deletes.sql (already revoked DELETE), and
-- 20261125160000_cp3_extraction_schema_rls.sql (added materials.current_revision_id).
--
-- What this slice changes:
--   * revokes the CP2 table-level INSERT and UPDATE grants on public.materials
--     for authenticated (DELETE was already revoked in CP2 review fix).
--   * grants only a column-level INSERT allowlist for note/link source capture:
--     (user_id, experience_id, type, source_url, text_content). processing_status
--     falls back to its DB default ('ready'); the authenticated client cannot set
--     or read past its own rows, and cannot touch server-managed columns.
--
-- Server-managed columns — object_key, original_filename, mime_type, size_bytes,
-- content_hash, processing_status, error_code, current_revision_id — are written
-- only by the service role after the caller's session and ownership are verified.
-- File registration therefore moves off the authenticated write path (see the
-- coordinated application change: app/api/materials/upload/route.ts now registers
-- the material row through the service-role admin client).
--
-- The existing materials_insert_own RLS policy (owner + experience ownership
-- with check) is retained; it governs which *rows* a client may insert, while the
-- column-level grant governs which *columns* it may set. Together they close the
-- hole where an authenticated client could forge processing_status, object_key,
-- or the current revision pointer.
--
-- Rerunnable: grants are idempotent (revoke then grant); no user rows are touched.

begin;

-- Table-level write grants for authenticated are removed. SELECT stays.
revoke insert, update on table public.materials from authenticated;

-- Column-level INSERT allowlist for note/link source capture only. The client
-- supplies ownership, target experience, type, and the source content; every
-- other column (processing_status via default, object_key, file metadata,
-- content_hash, error_code, current_revision_id) is server-managed.
grant insert (user_id, experience_id, type, source_url, text_content)
  on table public.materials to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Rollback / forward-fix notes (documentation only; not executed).
--
-- This slice is additive-permission-tightening. To revert on a development
-- project, restore the CP2 table-level grants and drop the column-level grant:
--   revoke insert on table public.materials from authenticated;
--   grant insert, update on table public.materials to authenticated;
--
-- Do NOT re-grant DELETE: the CP2 review fixes (20261124224500,
-- 20261124230500) removed direct client deletes so that Storage + database
-- cleanup stays on the coordinated server path.
-- ---------------------------------------------------------------------------
