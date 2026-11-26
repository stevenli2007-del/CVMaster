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
--   (3) AI claim evidence integrity on the DELETE path: a deferred constraint
--       trigger rejects deleting the last evidence of a surviving AI claim,
--       while still permitting cascaded deletes (the claim is removed in the
--       same transaction, so the invariant is vacuous by commit time).
--   (4) processing_jobs/deletion_jobs polymorphic target_id: no SQL — enforced
--       by the server-only transactional write path (documented, not added).
--   (5) claim_revisions.actor must equal the claim's owner.
--   (6) CHECK constraints: attempts >= 0, version > 0, revision_no > 0,
--       sequence > 0, JSON object shape for source_locator/offsets/usage, and
--       lease token/expiry pairing. content_hash format is intentionally not
--       pinned here — the parser has not defined hex vs base64 yet; the columns
--       are already NOT NULL and a non-empty guard is added conservatively.
--
-- Item 1 is intentionally NOT in this file (see header above).

begin;

-- ---------------------------------------------------------------------------
-- (2) material_segments: ordered uniqueness + positive sequence.
-- ---------------------------------------------------------------------------

-- Unique (revision_id, sequence) so a revision can never carry two segments at
-- the same position. Guarded because the base CP3 migration already created
-- the (revision_id, sequence) index (non-unique); we add the unique constraint
-- under a distinct name and drop the now-redundant plain index is unnecessary
-- (a unique constraint backs a unique index). The base migration created
-- `material_segments_revision_idx` (revision_id, sequence) — leave it; the
-- unique constraint coexists and supersedes it for lookups.
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
-- (6) material_revisions: positive revision_no (version > 0 semantics).
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
-- (6) lease token/expiry pairing on processing_jobs: both present or both null.
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  drop constraint if exists processing_jobs_lease_pairing_check;
alter table public.processing_jobs
  add constraint processing_jobs_lease_pairing_check
  check ((lease_token is null) = (lease_expires_at is null));

-- ---------------------------------------------------------------------------
-- (6) content_hash non-empty guard (format left to the parser slice). The
-- columns are already NOT NULL; this only rejects empty strings.
-- ---------------------------------------------------------------------------
alter table public.material_revisions
  drop constraint if exists material_revisions_content_hash_nonempty_check;
alter table public.material_revisions
  add constraint material_revisions_content_hash_nonempty_check
  check (char_length(content_hash) > 0);

alter table public.material_segments
  drop constraint if exists material_segments_content_hash_nonempty_check;
alter table public.material_segments
  add constraint material_segments_content_hash_nonempty_check
  check (char_length(content_hash) > 0);

alter table public.claim_evidence
  drop constraint if exists claim_evidence_content_hash_nonempty_check;
alter table public.claim_evidence
  add constraint claim_evidence_content_hash_nonempty_check
  check (char_length(content_hash) > 0);

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
-- (3) Evidence integrity on the DELETE path. The base migration only asserted
-- "AI claim has >= 1 evidence" on claim insert/update. A deferred constraint
-- trigger on claim_evidence DELETE closes the gap: at commit time it checks the
-- claim that owned the deleted evidence — if that claim is still alive and is
-- an AI claim with zero remaining evidence, the transaction aborts.
--
-- Why deferred: a cascaded delete (material/experience -> ... -> claim_evidence
-- and -> claims) removes the evidence before the claim, but by commit time the
-- claim is gone too, so the invariant is vacuous and cascades are not blocked.
-- A direct delete of an evidence row that strands a surviving AI claim IS
-- rejected. This matches the approved "新增/修改/删除路径上保证每条存活 AI
-- claim 至少一条有效 evidence" requirement.
-- ---------------------------------------------------------------------------
create or replace function public.assert_evidence_delete_preserves_ai_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_origin text;
  v_remaining integer;
begin
  -- The claim that owned the deleted evidence. If it was itself deleted in the
  -- same transaction (cascade), this returns no row and the check is skipped.
  select origin into v_origin from public.claims where id = old.claim_id;
  if v_origin = 'ai' then
    select count(*) into v_remaining
      from public.claim_evidence
      where claim_id = old.claim_id;
    if v_remaining = 0 then
      raise exception 'deleting this evidence would leave an AI claim with no evidence';
    end if;
  end if;
  return old;
end;
$$;
revoke all on function public.assert_evidence_delete_preserves_ai_claim() from public, anon, authenticated;

drop trigger if exists claim_evidence_delete_preserves_ai_claim on public.claim_evidence;
create constraint trigger claim_evidence_delete_preserves_ai_claim
after delete on public.claim_evidence
deferrable initially deferred
for each row execute function public.assert_evidence_delete_preserves_ai_claim();

commit;

-- ---------------------------------------------------------------------------
-- Rollback and forward-fix notes (documentation only; not executed).
--
-- These constraints are additive and safe to leave in place. To revert on an
-- empty development project (destructive), drop each constraint/trigger/function
-- added above by name, e.g.:
--   drop trigger if exists claim_evidence_delete_preserves_ai_claim on public.claim_evidence;
--   drop trigger if exists claim_revisions_actor_owner on public.claim_revisions;
--   drop function if exists public.assert_evidence_delete_preserves_ai_claim();
--   drop function if exists public.assert_claim_revision_actor();
--   alter table public.material_segments drop constraint if exists material_segments_revision_sequence_key;
--   ... (drop each *_check constraint added above) ...
--
-- Item 1 (materials column-level permission tightening) and item 4 (polymorphic
-- target server-only validation) are intentionally out of scope for this slice
-- and remain pending (item 1) or are handled in application code (item 4).
-- ---------------------------------------------------------------------------
