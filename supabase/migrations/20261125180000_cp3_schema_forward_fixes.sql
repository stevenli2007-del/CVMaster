-- CP3 schema forward-fix slice: apply the approved forward-convergence items
-- (CP3 schema/RLS design §7) that are pure additive schema constraints. This
-- migration does NOT implement item 1 (materials column-level permission
-- tightening) — that item also requires coordinated application-code changes
-- (file registration must move off the authenticated client write path first),
-- so it is deferred to the next slice. Item 4 (polymorphic job target) is a
-- server-only transactional/RPC responsibility and intentionally adds no FK or
-- trigger, so it has no SQL here either.
--
-- Depends on 20261125160000_cp3_extraction_schema_rls.sql and
-- 20261125170000_cp3_byok_credential_slice.sql. Apply in a development Supabase
-- project first, then review before other environments. Transactional and
-- rerunnable: constraints are dropped and re-added (or guarded) so applying
-- over an already-migrated project converges instead of failing.
--
-- What this slice adds (mapping to the six approved forward-convergence items):
--   (2) material_segments: unique (revision_id, sequence) + sequence > 0.
--   (3) AI claim evidence integrity closed on both sides: (a) the claim-side
--       guard (assert_ai_claim_has_evidence) is upgraded via CREATE OR REPLACE
--       so an AI claim must carry at least one evidence matching its current
--       run_id (covering run_id updates); (b)/(c) a deferred trigger
--       (assert_evidence_removal_preserves_ai_claim) rejects DELETE of the last
--       evidence or an UPDATE that moves evidence to another claim, stranding
--       the old AI claim; it holds a row lock on the claim to serialize
--       concurrent removals. Cascades (which remove the claim in the same
--       transaction) are not blocked.
--   (4) processing_jobs/deletion_jobs polymorphic target_id: no SQL — enforced
--       by the server-only transactional write path (documented, not added).
--   (5) claim_revisions.actor must equal the claim's owner.
--   (6) CHECK constraints: attempts >= 0, version/revision_no > 0, sequence > 0,
--       SHA-256 64-hex shape for content_hash, JSON object shape for
--       source_locator/offsets/usage, non-empty bounded idempotency_key, and
--       lease token/expiry pairing with running jobs requiring a lease.
--
-- Item 1 is intentionally NOT in this file (see header above).

begin;

-- ---------------------------------------------------------------------------
-- (2) material_segments: ordered uniqueness + positive sequence.
-- ---------------------------------------------------------------------------

-- Unique (revision_id, sequence) so a revision can never carry two segments at
-- the same position. The base CP3 migration already created a non-unique
-- (revision_id, sequence) index; this unique constraint backs its own unique
-- index and supersedes it for lookups (the plain index is left in place).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_segments'::regclass
      and conname = 'material_segments_revision_sequence_key'
  ) then
    alter table public.material_segments
      add constraint material_segments_revision_sequence_key
      unique (revision_id, sequence);
  end if;
end;
$$;

alter table public.material_segments
  drop constraint if exists material_segments_sequence_positive_check;
alter table public.material_segments
  add constraint material_segments_sequence_positive_check
  check (sequence > 0);

-- ---------------------------------------------------------------------------
-- (6) material_revisions: positive revision_no.
-- ---------------------------------------------------------------------------
alter table public.material_revisions
  drop constraint if exists material_revisions_revision_no_positive_check;
alter table public.material_revisions
  add constraint material_revisions_revision_no_positive_check
  check (revision_no > 0);

-- ---------------------------------------------------------------------------
-- (6) claims: version > 0.
-- ---------------------------------------------------------------------------
alter table public.claims
  drop constraint if exists claims_version_positive_check;
alter table public.claims
  add constraint claims_version_positive_check
  check (version > 0);

-- ---------------------------------------------------------------------------
-- (6) attempt counters >= 0 across job/run/deletion tables.
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  drop constraint if exists processing_jobs_attempt_nonnegative_check;
alter table public.processing_jobs
  add constraint processing_jobs_attempt_nonnegative_check
  check (attempt >= 0);

alter table public.extraction_runs
  drop constraint if exists extraction_runs_attempts_nonnegative_check;
alter table public.extraction_runs
  add constraint extraction_runs_attempts_nonnegative_check
  check (attempts >= 0);

alter table public.deletion_jobs
  drop constraint if exists deletion_jobs_attempt_nonnegative_check;
alter table public.deletion_jobs
  add constraint deletion_jobs_attempt_nonnegative_check
  check (attempt >= 0);

-- ---------------------------------------------------------------------------
-- (6) SHA-256 content_hash: exactly 64 lowercase hex characters. Applies to the
-- three content_hash columns (material_revisions, material_segments,
-- claim_evidence). Parser/extraction must emit lowercase hex; the columns are
-- already NOT NULL, so this only pins the shape.
-- ---------------------------------------------------------------------------
alter table public.material_revisions
  drop constraint if exists material_revisions_content_hash_sha256_check;
alter table public.material_revisions
  add constraint material_revisions_content_hash_sha256_check
  check (content_hash ~ '^[0-9a-f]{64}$');

alter table public.material_segments
  drop constraint if exists material_segments_content_hash_sha256_check;
alter table public.material_segments
  add constraint material_segments_content_hash_sha256_check
  check (content_hash ~ '^[0-9a-f]{64}$');

alter table public.claim_evidence
  drop constraint if exists claim_evidence_content_hash_sha256_check;
alter table public.claim_evidence
  add constraint claim_evidence_content_hash_sha256_check
  check (content_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- (6) JSON object shape for the locator/offset/usage columns. These carry
-- bounded, server-validated structures, never raw provider payloads; the
-- object shape is asserted so a scalar/array cannot be smuggled in.
-- ---------------------------------------------------------------------------
alter table public.material_segments
  drop constraint if exists material_segments_source_locator_object_check;
alter table public.material_segments
  add constraint material_segments_source_locator_object_check
  check (jsonb_typeof(source_locator) = 'object');

alter table public.claim_evidence
  drop constraint if exists claim_evidence_offsets_object_check;
alter table public.claim_evidence
  add constraint claim_evidence_offsets_object_check
  check (jsonb_typeof(offsets) = 'object');

alter table public.extraction_runs
  drop constraint if exists extraction_runs_usage_object_check;
alter table public.extraction_runs
  add constraint extraction_runs_usage_object_check
  check (usage is null or jsonb_typeof(usage) = 'object');

-- ---------------------------------------------------------------------------
-- (6) idempotency_key: non-empty and bounded. The base migration declared it
-- NOT NULL; this pins a sensible upper bound. Idempotency keys take the form
-- "<kind>:<uuid>:<version-or-hash>" (ADR-003 §队列、幂等与失败恢复), e.g.
-- "extract:<uuid>:<64-hex>" ≈ 110 chars; 256 leaves ample headroom without
-- permitting unbounded keys.
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  drop constraint if exists processing_jobs_idempotency_key_bounds_check;
alter table public.processing_jobs
  add constraint processing_jobs_idempotency_key_bounds_check
  check (char_length(idempotency_key) between 1 and 256);

-- ---------------------------------------------------------------------------
-- (6) lease token/expiry pairing AND running jobs must hold a lease. The first
-- constraint enforces both-or-neither; the second requires a running job to
-- actually have a lease so a worker can be held accountable for progress.
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  drop constraint if exists processing_jobs_lease_pairing_check;
alter table public.processing_jobs
  add constraint processing_jobs_lease_pairing_check
  check ((lease_token is null) = (lease_expires_at is null));

alter table public.processing_jobs
  drop constraint if exists processing_jobs_running_requires_lease_check;
alter table public.processing_jobs
  add constraint processing_jobs_running_requires_lease_check
  check (
    status <> 'running'
    or (lease_token is not null and lease_expires_at is not null)
  );

-- ---------------------------------------------------------------------------
-- (5) claim_revisions.actor must be the claim's owner. The base migration
-- stored an arbitrary actor uuid; this deferred constraint trigger binds it to
-- the claim's user_id. Deferred so the audit row can be written in the same
-- transaction as the claim edit it records.
-- ---------------------------------------------------------------------------
create or replace function public.assert_claim_revision_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.claims where id = new.claim_id;
  if v_owner is distinct from new.actor then
    raise exception 'claim revision actor must be the claim owner';
  end if;
  return new;
end;
$$;
revoke all on function public.assert_claim_revision_actor() from public, anon, authenticated;

drop trigger if exists claim_revisions_actor_owner on public.claim_revisions;
create constraint trigger claim_revisions_actor_owner
after insert or update of claim_id, actor on public.claim_revisions
deferrable initially deferred
for each row execute function public.assert_claim_revision_actor();

-- ---------------------------------------------------------------------------
-- (3) AI claim evidence integrity, closed on both sides of the relation.
--
-- The base migration left three holes:
--
--   (a) claim side: assert_ai_claim_has_evidence only counts evidence rows; it
--       never verifies that any evidence actually belongs to the claim's
--       current run. Updating an AI claim's run_id therefore leaves old
--       evidence pointing at the previous run with no check. The consistency
--       trigger (assert_claim_evidence_consistency) only fires when an evidence
--       row is inserted/updated, not when the claim's run_id changes.
--
--   (b) evidence side, direct removal: DELETE of the last evidence of a
--       surviving AI claim was not checked.
--
--   (c) evidence side, association move: UPDATE that moves an evidence row to a
--       different claim (claim_id change) could silently strand the OLD claim
--       at zero evidence.
--
-- This slice closes all three:
--   * (a) is closed by CREATE OR REPLACE of assert_ai_claim_has_evidence so
--     that an AI claim must have at least one evidence whose run matches the
--     claim's current run_id (deferred, so claim-then-evidence insert order
--     still passes). The existing claims_ai_evidence trigger already fires on
--     `update of run_id`, so the upgraded function is exercised on that path.
--   * (b) and (c) are closed by assert_evidence_removal_preserves_ai_claim
--     below, which examines the claim whose evidence set shrank (OLD.claim_id)
--     at commit time and holds a row lock to serialize concurrent removals.
--
-- Why deferred: a cascaded delete (material/experience -> ... -> claim_evidence
-- and -> claims) removes the evidence before the claim, but by commit time the
-- claim is gone too, so the invariant is vacuous and cascades are NOT blocked.
-- A direct delete, an association move, or a run_id change that strands a
-- surviving AI claim IS rejected. This matches the approved "新增/修改/删除路径
-- 上保证每条存活 AI claim 至少一条同 revision、同 run evidence" requirement
-- (design §7 item 3); the same-revision property is transitively guaranteed by
-- assert_claim_evidence_consistency (evidence.run == claim.run and
-- evidence.segment.revision == run.revision).
-- ---------------------------------------------------------------------------

-- (a) Upgrade the claim-side guard: an AI claim must carry at least one
-- evidence that belongs to its current run. Same function name and signature,
-- so the base migration's claims_ai_evidence trigger keeps firing on it.
create or replace function public.assert_ai_claim_has_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.origin = 'ai' then
    if new.run_id is not null then
      if not exists (
        select 1 from public.claim_evidence e
        where e.claim_id = new.id
          and e.run_id = new.run_id
      ) then
        raise exception 'AI claim must have at least one evidence matching its run';
      end if;
    else
      -- Defensive fallback: an AI claim with a null run is already rejected by
      -- the origin/run check; keep the quantity-only guard for safety.
      if not exists (
        select 1 from public.claim_evidence e
        where e.claim_id = new.id
      ) then
        raise exception 'AI claim must have at least one evidence row';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.assert_ai_claim_has_evidence() from public, anon, authenticated;

-- (b)/(c) Evidence-side guard: serialize and reject removals that strand a
-- surviving AI claim.
create or replace function public.assert_evidence_removal_preserves_ai_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_affected uuid;
  v_origin text;
  v_remaining integer;
begin
  -- The claim whose evidence set shrank. On DELETE it is the removed row's
  -- claim. On UPDATE it is the old claim, and only when the association moved
  -- (a same-claim update cannot shrink the old claim's evidence count). A
  -- quote/offset/segment/run update that does not touch claim_id does not fire
  -- this trigger (it is declared `update of claim_id`).
  if tg_op = 'DELETE' then
    v_affected := old.claim_id;
  elsif old.claim_id is distinct from new.claim_id then
    v_affected := old.claim_id;
  else
    -- Same-claim update: the old claim's evidence count is unchanged.
    return old;
  end if;

  -- Lock the affected claim row to serialize concurrent evidence removals
  -- against the same claim. Without the lock, two transactions each deleting
  -- one of the claim's two evidence rows can both pass their count check (each
  -- sees the other's delete as not-yet-committed), leaving the claim with zero
  -- evidence after both commit. `for update` forces the second to wait until
  -- the first commits, at which point the second re-reads and sees the first's
  -- committed delete.
  --
  -- If the affected claim was itself removed in the same transaction (cascade),
  -- the `for update` returns no row (v_origin stays null) and the check is
  -- skipped — a cascade removes the claim together with its evidence, so there
  -- is no surviving claim to protect.
  select origin into v_origin from public.claims where id = v_affected for update;
  if v_origin = 'ai' then
    select count(*) into v_remaining
      from public.claim_evidence
      where claim_id = v_affected;
    if v_remaining = 0 then
      raise exception 'this change would leave an AI claim with no evidence';
    end if;
  end if;

  return old;
end;
$$;
revoke all on function public.assert_evidence_removal_preserves_ai_claim() from public, anon, authenticated;

drop trigger if exists claim_evidence_removal_preserves_ai_claim on public.claim_evidence;
create constraint trigger claim_evidence_removal_preserves_ai_claim
after delete or update of claim_id on public.claim_evidence
deferrable initially deferred
for each row execute function public.assert_evidence_removal_preserves_ai_claim();

commit;

-- ---------------------------------------------------------------------------
-- Rollback and forward-fix notes (documentation only; not executed).
--
-- These constraints are additive and safe to leave in place. To revert on an
-- empty development project (destructive), drop each constraint/trigger/function
-- added above by name, e.g.:
--   drop trigger if exists claim_evidence_removal_preserves_ai_claim on public.claim_evidence;
--   drop trigger if exists claim_revisions_actor_owner on public.claim_revisions;
--   drop function if exists public.assert_evidence_removal_preserves_ai_claim();
--   drop function if exists public.assert_claim_revision_actor();
--   alter table public.material_segments drop constraint if exists material_segments_revision_sequence_key;
--   ... (drop each *_check constraint added above) ...
--
-- Item 1 (materials column-level permission tightening) and item 4 (polymorphic
-- target server-only validation) are intentionally out of scope for this slice
-- and remain pending (item 1) or are handled in application code (item 4).
-- ---------------------------------------------------------------------------
