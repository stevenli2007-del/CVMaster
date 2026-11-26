-- CP3 queue/parser slice: the server-only "material revision snapshot"
-- transaction (CP3 schema/RLS design §5, ADR-003 topology step 1). This is the
-- first half of the queue/parser slice: create the immutable material_revisions
-- row, atomically set materials.current_revision_id, and enqueue a
-- processing_jobs row. It does NOT create the pgmq queue, choose worker
-- hosting, or send any material to a provider — those remain future slices.
--
-- Depends on 20261125160000_cp3_extraction_schema_rls.sql (revision/segment/
-- job tables + RLS + composite FKs) and 20261125190000_cp3_materials_column_permissions.sql
-- (current_revision_id is server-managed). Rerunnable: the function is
-- CREATE OR REPLACE and grants are idempotent; no user rows are touched.
--
-- Why a SECURITY DEFINER function instead of application-side sequential
-- writes: design §5 requires the revision, the current_revision_id pointer, and
-- the enqueued job to commit atomically, and §7 item 4 requires polymorphic job
-- target validation to be a server-only transactional path with no client
-- execute grant. The function locks the material row, re-verifies ownership,
-- and writes all three in one transaction. It is called by the application
-- (service role) with an already-authenticated user_id — never by anon or
-- authenticated.

begin;

-- ---------------------------------------------------------------------------
-- create_material_revision(p_user_id, p_material_id, p_content_hash, p_kind)
--
-- Idempotent first-snapshot semantics (design §5 step 3): if the material
-- already carries a current_revision_id, the snapshot already exists and the
-- function returns it without creating a duplicate revision or job. Otherwise
-- it creates revision_no=1, atomically points materials.current_revision_id at
-- it, and enqueues one processing_jobs row with the idempotency key
-- "parse:<revision_id>:<content_hash>". A repeated call with the same material
-- converges to the same revision instead of fabricating a new one.
--
-- Returns (revision_id, revision_no, job_id, created). created is true only
-- when a new revision/job was written in this call.
-- ---------------------------------------------------------------------------
create or replace function public.create_material_revision(
  p_user_id uuid,
  p_material_id uuid,
  p_content_hash text,
  p_kind text
)
returns table (revision_id uuid, revision_no integer, job_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material record;
  v_revision_id uuid;
  v_job_id uuid;
begin
  -- Lock and re-verify ownership of the material. A row not owned by
  -- p_user_id (or already gone) is rejected before any write.
  select id, user_id, current_revision_id
    into v_material
    from public.materials
    where id = p_material_id
    for update;

  if v_material is null or v_material.user_id is distinct from p_user_id then
    raise exception 'material not found for this owner';
  end if;

  -- Idempotent reuse: an existing pointer means the first snapshot is already
  -- present. Return it without creating a duplicate revision or job.
  if v_material.current_revision_id is not null then
    return query
      select r.id, r.revision_no, j.id, false
      from public.material_revisions r
      left join public.processing_jobs j
        on j.user_id = p_user_id
       and j.kind = p_kind
       and j.idempotency_key = 'parse:' || r.id || ':' || r.content_hash
       and j.status in ('queued', 'running')
      where r.id = v_material.current_revision_id
        and r.user_id = p_user_id
      limit 1;
    return;
  end if;

  -- First snapshot: revision_no = 1, immutable source hash, parse_status
  -- starts at 'stored' (DB default; the worker advances it to 'parsing'/'ready').
  v_revision_id := gen_random_uuid();
  v_job_id := gen_random_uuid();

  insert into public.material_revisions (
    id, material_id, user_id, revision_no, content_hash
  ) values (
    v_revision_id, p_material_id, p_user_id, 1, p_content_hash
  );

  update public.materials
     set current_revision_id = v_revision_id
   where id = p_material_id
     and user_id = p_user_id;

  insert into public.processing_jobs (
    id, user_id, kind, target_id, status, idempotency_key, attempt
  ) values (
    v_job_id, p_user_id, p_kind, p_material_id, 'queued',
    'parse:' || v_revision_id || ':' || p_content_hash, 0
  );

  return query
    select v_revision_id, 1, v_job_id, true;
end;
$$;

revoke all on function public.create_material_revision(uuid, uuid, text, text)
  from public, anon, authenticated;

-- The application calls this through the service role only. No client grant.
grant execute on function public.create_material_revision(uuid, uuid, text, text)
  to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Rollback / forward-fix notes (documentation only; not executed).
--
-- To revert on a development project:
--   drop function if exists public.create_material_revision(uuid, uuid, text, text);
--
-- The function is additive; removing it does not affect the tables it writes.
-- Future slices (pgmq enqueue, parser worker, claim/evidence extraction,
-- deletion saga) build on top of the revision + queued job written here.
-- ---------------------------------------------------------------------------
