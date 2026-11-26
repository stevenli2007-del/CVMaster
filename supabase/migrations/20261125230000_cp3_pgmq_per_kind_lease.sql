-- CP3 queue/parser slice: fix the worker lease contract to actually consume
-- pgmq messages, and split the queue per parse kind.
--
-- Review finding: the previous lease_processing_job claimed jobs straight from
-- the processing_jobs table and never read/deleted/archived the pgmq message,
-- so messages piled up and a worker could be handed one message while leasing a
-- different job. Because workers are split by kind with different egress grants
-- (ADR-003 §1: parse has no egress, fetch has controlled egress), a single
-- mixed queue cannot be pulled by kind — hence one durable queue per parse kind.
--
-- This migration:
--   * creates a durable queue per parse kind (fetch_web, parse_file,
--     normalize_note) and re-homes any pending messages from the old single
--     "processing_jobs" queue into the matching kind queue before dropping it,
--     so no queued job loses its message.
--   * reworks create_material_revision to enqueue into the kind's own queue.
--   * reworks lease_processing_job to pull from pgmq first: the message's job
--     UUID is the only thing that decides which job is leased, so message and
--     job stay one-to-one.
--   * adds a message-id to complete/fail so the worker archives the message it
--     consumed (pgmq.archive — kept for the 7-day queue archive retention),
--     with the archive made best-effort so an archive error never rolls back
--     the job's completion/failure.
--   * whitelists fail_processing_job's error_code to fixed safe classifications.
--
-- Depends on 20261125210000 (pgmq enqueue) and 20261125220000 (lease contract).
-- Rerunnable: create queue is guarded, create-or-replace functions, idempotent
-- grants. The drop of the old queue is guarded by existence.

begin;

-- One durable queue per parse kind. Queue name == processing_jobs.kind, so the
-- enqueue and read paths share a single mapping. Basic (logged), never unlogged.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'pgmq' and tablename = 'q_fetch_web') then
    perform pgmq.create('fetch_web');
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'pgmq' and tablename = 'q_parse_file') then
    perform pgmq.create('parse_file');
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'pgmq' and tablename = 'q_normalize_note') then
    perform pgmq.create('normalize_note');
  end if;
end;
$$;

-- Re-home any pending messages from the superseded single mixed queue before
-- dropping it. The previous slice (20261125210000) enqueued job-UUID messages
-- into 'processing_jobs'; "no worker has run" does NOT mean the queue is empty.
-- Each surviving message carries a job UUID whose processing_jobs row may still
-- be 'queued'. If we dropped the queue outright, those jobs would lose their
-- message and stay stuck in 'queued' forever. So: read every message, look up
-- its job's kind, and re-send the message to that kind's own queue; only then
-- drop the old queue.
do $$
declare
  v_msg record;
  v_kind text;
begin
  if exists (select 1 from pg_tables where schemaname = 'pgmq' and tablename = 'q_processing_jobs') then
    -- pgmq.read with vt=1 and a large qty drains the queue; archived messages
    -- are not read, so this only touches live messages.
    for v_msg in select * from pgmq.read('processing_jobs', 1, 1000) loop
      select kind into v_kind
        from public.processing_jobs
       where id = (v_msg.message ->> 'job_id')::uuid
       limit 1;

      -- Re-send only messages whose job is a supported parse kind and is still
      -- queued; anything else is dead weight and can be archived away.
      if v_kind in ('fetch_web', 'parse_file', 'normalize_note') then
        perform pgmq.send(v_kind, v_msg.message);
      end if;

      perform pgmq.archive('processing_jobs', v_msg.msg_id);
    end loop;

    perform pgmq.drop_queue('processing_jobs');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_material_revision: enqueue into the kind's own queue. Same signature
-- and return shape; only the queue name changes from 'processing_jobs' to p_kind.
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
  select id, user_id, current_revision_id
    into v_material
    from public.materials
    where id = p_material_id
    for update;

  if v_material is null or v_material.user_id is distinct from p_user_id then
    raise exception 'material not found for this owner';
  end if;

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

  -- The queue name is the job kind; the message carries only the job UUID.
  perform pgmq.send(
    p_kind,
    jsonb_build_object('job_id', v_job_id)
  );

  return query
    select v_revision_id, 1, v_job_id, true;
end;
$$;

revoke all on function public.create_material_revision(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_material_revision(uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- lease_processing_job(p_kind, p_lease_seconds)
--
-- Pull model: the ONLY source of a lease is a pgmq message. Read one message
-- from the kind's queue (visibility timeout = lease duration), take its job
-- UUID, and lease that exact job. A message and its job therefore stay
-- one-to-one; the worker can never be handed one message while leasing another.
--
-- Returns (job_id, user_id, kind, target_id, attempt, lease_token,
-- lease_expires_at, msg_id). msg_id is the pgmq message id the worker must pass
-- back to complete/fail so the message is archived (7-day retention). Returns
-- no row when the queue has no leaseable job.
--
-- Stale/duplicate handling: if the message's job is no longer 'queued' (it was
-- completed/failed, re-leased, or its material was removed), the message is
-- archived and the loop reads the next one. This keeps the queue from blocking
-- on a dead message.
-- ---------------------------------------------------------------------------
create or replace function public.lease_processing_job(
  p_kind text,
  p_lease_seconds integer default 300
)
returns table (
  job_id uuid,
  user_id uuid,
  kind text,
  target_id uuid,
  attempt integer,
  lease_token uuid,
  lease_expires_at timestamptz,
  msg_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg record;
  v_job record;
  v_token uuid;
  v_expires timestamptz;
begin
  if p_kind not in ('fetch_web', 'parse_file', 'normalize_note') then
    raise exception 'unsupported lease kind';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds out of range';
  end if;

  loop
    -- Pull the next message with a visibility timeout equal to the lease, so
    -- the message and the job lease lapse together.
    select * into v_msg
      from pgmq.read(p_kind, p_lease_seconds, 1)
      limit 1;

    exit when v_msg is null;

    -- The message must be a single job UUID; anything else is archived.
    if v_msg.message is null or (v_msg.message ->> 'job_id') is null then
      perform pgmq.archive(p_kind, v_msg.msg_id);
      continue;
    end if;

    -- Re-verify the job is still claimable and its target material still exists
    -- and is owned by the same account.
    select j.id, j.user_id, j.kind, j.target_id, j.attempt
      into v_job
      from public.processing_jobs j
      join public.materials m
        on m.id = j.target_id
       and m.user_id = j.user_id
     where j.id = (v_msg.message ->> 'job_id')::uuid
       and j.kind = p_kind
       and j.status = 'queued';

    if v_job is null then
      -- Completed/failed/re-leased job, removed material, or a stale message:
      -- archive it and move on so a dead message cannot block the queue.
      perform pgmq.archive(p_kind, v_msg.msg_id);
      continue;
    end if;

    v_token := gen_random_uuid();
    v_expires := now() + make_interval(secs => p_lease_seconds);

    update public.processing_jobs
       set status = 'running',
           lease_token = v_token,
           lease_expires_at = v_expires,
           attempt = v_job.attempt + 1
     where id = v_job.id
       and status = 'queued';

    -- The conditional update can lose to a concurrent lease of the same job
    -- (two messages for one job). If it did not take effect, archive this
    -- message and read the next one.
    if not found then
      perform pgmq.archive(p_kind, v_msg.msg_id);
      continue;
    end if;

    return query
      select v_job.id, v_job.user_id, v_job.kind, v_job.target_id,
             v_job.attempt + 1, v_token, v_expires, v_msg.msg_id;
    return;
  end loop;
end;
$$;
revoke all on function public.lease_processing_job(text, integer) from public, anon, authenticated;
grant execute on function public.lease_processing_job(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- complete_processing_job(p_job_id, p_kind, p_lease_token, p_msg_id)
--
-- Marks a leased job completed and archives its queue message. Optimistic lock:
-- the lease token must still match and the lease must not have expired, so a
-- stale worker cannot clobber a re-leased attempt. The message archive is
-- best-effort: if it fails (e.g. already archived), the job completion still
-- stands and the janitor reconciles the queue.
-- ---------------------------------------------------------------------------
create or replace function public.complete_processing_job(
  p_job_id uuid,
  p_kind text,
  p_lease_token uuid,
  p_msg_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.processing_jobs
     set status = 'completed',
         lease_token = null,
         lease_expires_at = null,
         error_code = null
   where id = p_job_id
     and status = 'running'
     and lease_token = p_lease_token
     and lease_expires_at > now();

  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    -- Best-effort archive: an already-archived or missing message must not roll
    -- back the job completion, so swallow archive errors. The janitor reconciles
    -- any message that slips through.
    begin
      perform pgmq.archive(p_kind, p_msg_id);
    exception
      when others then
        null;
    end;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.complete_processing_job(uuid, text, uuid, bigint) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text, uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- fail_processing_job(p_job_id, p_kind, p_lease_token, p_msg_id, p_error_code)
--
-- Marks a leased job failed with a whitelisted safe error code and archives the
-- message. Same optimistic lock as complete. error_code must be one of the fixed
-- safe classifications below — never a provider message, material text, or URL.
-- ---------------------------------------------------------------------------
create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_kind text,
  p_lease_token uuid,
  p_msg_id bigint,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_error_code is not null and p_error_code not in (
    'unsupported_type',     -- file/link type outside the first parsing matrix
    'needs_user_input',     -- e.g. scanned PDF with no text layer
    'fetch_failed',         -- network/HTTP failure fetching a URL
    'fetch_timeout',        -- fetch exceeded the time budget
    'fetch_blocked',        -- SSRF/egress/robots/policy refused the fetch
    'too_large',            -- content exceeded a size/decompression limit
    'parse_failed',         -- parser could not produce segments
    'malformed_content',    -- structurally invalid input
    'invalid_mime',         -- declared MIME does not match magic bytes
    'rate_limited',         -- retry/backoff budget exhausted
    'internal_error'        -- unexpected worker failure (no detail leaked)
  ) then
    raise exception 'invalid error_code';
  end if;

  update public.processing_jobs
     set status = 'failed',
         lease_token = null,
         lease_expires_at = null,
         error_code = p_error_code
   where id = p_job_id
     and status = 'running'
     and lease_token = p_lease_token
     and lease_expires_at > now();

  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    -- Best-effort archive (see complete_processing_job): an archive failure must
    -- not roll back the failed status.
    begin
      perform pgmq.archive(p_kind, p_msg_id);
    exception
      when others then
        null;
    end;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.fail_processing_job(uuid, text, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, text, uuid, bigint, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Rollback / forward-fix notes (documentation only; not executed).
--
-- To revert on a development project:
--   drop function if exists public.lease_processing_job(text, integer);
--   drop function if exists public.complete_processing_job(uuid, text, uuid, bigint);
--   drop function if exists public.fail_processing_job(uuid, text, uuid, bigint, text);
--   -- then re-create the single-queue enqueue from 20261125210000, or drop the
--   -- three kind queues: select pgmq.drop_queue('fetch_web'), etc.
--
-- Known limitation (unchanged, must be fixed before a worker goes live): a job
-- whose lease lapses is not automatically re-leased here. The reconcile job that
-- re-enqueues lapsed leases and recovers lost queue messages is a future slice
-- (ADR-003 §1, "processing_jobs is the reliability boundary"). Archive retention
-- (7 days) purge is also deferred to the reap_temporary_data job.
-- ---------------------------------------------------------------------------
