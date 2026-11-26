-- CP3 queue/parser slice: enable pgmq and wire the first enqueue into the
-- material-revision snapshot transaction (ADR-003 topology step 1, "transaction
-- write processing_jobs + enqueue, message carries only the job UUID").
--
-- This slice creates the durable queue and makes create_material_revision send a
-- single message (just the job UUID) in the same transaction that writes the
-- processing_jobs row. No worker, scheduler, lease, or provider call is wired
-- here — those remain future slices.
--
-- Depends on 20261125200000_cp3_revision_snapshot.sql (create_material_revision).
-- Rerunnable: create extension / create queue / create-or-replace function are
-- all idempotent; no user rows are touched.
--
-- Queue semantics (ADR-003 §1): a basic (logged) pgmq queue, never unlogged, so
-- messages survive a crash. Messages carry only the job UUID — no material, key,
-- or URL. processing_jobs remains the reliability boundary: if pgmq is
-- unavailable, new enqueue fails closed (the whole snapshot transaction rolls
-- back) rather than persisting a job with no queue message.
--
-- pgmq requires Postgres >= 15.6.1.143 (Supabase Queues). On an older dev
-- project this migration will fail at `create extension`; that is intentional —
-- the queue slice cannot run without pgmq.

begin;

create extension if not exists pgmq;

-- Idempotently create the durable queue. pgmq.create() errors if the queue
-- already exists, so guard it against the queue's backing table (the portable
-- signal across pgmq versions, vs. list_queues() whose column set varies).
do $$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'pgmq'
      and tablename = 'q_processing_jobs'
  ) then
    perform pgmq.create('processing_jobs');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rework create_material_revision to enqueue the job UUID in the same
-- transaction. The signature and return shape are unchanged, so the application
-- layer (lib/revisions.ts) needs no change: it still calls
-- create_material_revision(p_user_id, p_material_id, p_content_hash, p_kind).
-- The only behavioral addition is the pgmq.send after the processing_jobs
-- insert. Because this runs inside the same function (SECURITY DEFINER, owner
-- postgres), a send failure aborts the transaction and no revision/job/pointer
-- is left half-written.
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
  -- present. Return it without creating a duplicate revision or job (and
  -- without re-enqueuing).
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

  -- Enqueue a message carrying only the job UUID. A send failure aborts this
  -- transaction, so a queued job is never persisted without its queue message.
  perform pgmq.send(
    'processing_jobs',
    jsonb_build_object('job_id', v_job_id)
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
--   select pgmq.drop_queue('processing_jobs');  -- removes q_ and archive table
--   (create_material_revision is reverted by reapplying the pre-enqueue body,
--    or drop the function and re-create from 20261125200000.)
--
-- The queue is additive. The application already treats the RPC as the atomic
-- boundary; a worker lease/dequeue RPC and the reconcile job (to recover a job
-- whose queue message was lost) are future slices per ADR-003.
-- ---------------------------------------------------------------------------
