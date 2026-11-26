-- CP3 queue/parser slice: the server-only lease/complete/fail contract for the
-- parse/fetch worker. This is the database surface the worker calls BEFORE any
-- worker hosting is chosen — no Cloud Run, scheduler, or provider is wired here.
--
-- Depends on 20261125180000_cp3_schema_forward_fixes.sql (lease pairing /
-- running-requires-lease CHECKs) and 20261125210000_cp3_pgmq_enqueue.sql.
-- Rerunnable: all functions are CREATE OR REPLACE; grants are idempotent.
--
-- Scope (parse/fetch only): lease is gated to the three source-parsing kinds
-- whose polymorphic target is a material — fetch_web, parse_file, normalize_note.
-- extract_claims and delete_* have different targets/lifecycles and are future
-- slices; their lease/complete semantics are intentionally out of scope here.
--
-- Concurrency: lease uses SELECT ... FOR UPDATE SKIP LOCKED so exactly one
-- caller claims a given queued job; a second caller skips to the next job.
--
-- Optimistic concurrency (ADR-003 §队列、幂等与失败恢复): complete/fail are
-- conditional on the lease_token still matching AND the lease not having
-- expired. A worker whose lease lapsed (another worker re-leased the job) cannot
-- commit a late result — it gets false and must not write segments/evidence.
-- This is what makes a crashed/overrun worker harmless: its lease expires, the
-- reconcile/next poll re-leases, and the stale commit is rejected.

begin;

-- ---------------------------------------------------------------------------
-- lease_processing_job(p_kind, p_lease_seconds)
--
-- Atomically claims the oldest queued job of the given parse kind for the
-- caller. Returns one row (or none) with the job metadata the worker needs to
-- start: id, user_id, kind, target_id (the material UUID), attempt (post-claim
-- value), lease_token, and lease_expires_at. The worker then reads the material
-- / revision input under the service role using the returned ids.
--
-- The target material is re-verified here (existence + same owner) so a worker
-- never leases a job whose material was already removed. Deletion-lifecycle
-- gating (a material marked deleting) belongs to the deletion saga slice, which
-- will add that marker; today the only protection is the row's presence.
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
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
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

  -- Claim the oldest queued job of this kind, skipping rows already locked by a
  -- concurrent lease. Re-verify the target material still exists and is owned by
  -- the same account (polymorphic target validation, CP3 design §7 item 4).
  select j.id, j.user_id, j.kind, j.target_id, j.attempt
    into v_job
    from public.processing_jobs j
    join public.materials m
      on m.id = j.target_id
     and m.user_id = j.user_id
   where j.kind = p_kind
     and j.status = 'queued'
   order by j.created_at asc
   for update of j skip locked
   limit 1;

  if v_job is null then
    return;
  end if;

  v_token := gen_random_uuid();
  v_expires := now() + make_interval(secs => p_lease_seconds);

  update public.processing_jobs
     set status = 'running',
         lease_token = v_token,
         lease_expires_at = v_expires,
         attempt = v_job.attempt + 1
   where id = v_job.id;

  return query
    select v_job.id, v_job.user_id, v_job.kind, v_job.target_id,
           v_job.attempt + 1, v_token, v_expires;
end;
$$;
revoke all on function public.lease_processing_job(text, integer) from public, anon, authenticated;
grant execute on function public.lease_processing_job(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- complete_processing_job(p_job_id, p_lease_token)
--
-- Marks a leased job completed. Conditional on the lease token still matching
-- and the lease not expired (optimistic lock): a stale/expired lease is refused
-- so a late worker commit cannot clobber a re-leased attempt. Returns true on
-- success, false when the token does not match or the lease lapsed.
-- ---------------------------------------------------------------------------
create or replace function public.complete_processing_job(
  p_job_id uuid,
  p_lease_token uuid
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
  return v_updated > 0;
end;
$$;
revoke all on function public.complete_processing_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- fail_processing_job(p_job_id, p_lease_token, p_error_code)
--
-- Marks a leased job failed with a safe error code. Same optimistic lock as
-- complete: the token must match and the lease must be unexpired. The error
-- code is a fixed safe classification (never a provider message, material text,
-- or URL); p_error_code is validated against a bounded shape and may be null.
-- Returns true on success, false when the token does not match / lease lapsed.
-- ---------------------------------------------------------------------------
create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_lease_token uuid,
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
  if p_error_code is not null and char_length(p_error_code) > 64 then
    raise exception 'error_code too long';
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
  return v_updated > 0;
end;
$$;
revoke all on function public.fail_processing_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, uuid, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Rollback / forward-fix notes (documentation only; not executed).
--
-- To revert on a development project:
--   drop function if exists public.lease_processing_job(text, integer);
--   drop function if exists public.complete_processing_job(uuid, uuid);
--   drop function if exists public.fail_processing_job(uuid, uuid, text);
--
-- Future slices: a heartbeat RPC to extend lease_expires_at within a long lease;
-- a reconcile job that re-leases jobs whose lease lapsed with no completion
-- (queue-message loss recovery, ADR-003); deletion-lifecycle gating in lease.
-- ---------------------------------------------------------------------------
