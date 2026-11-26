-- CP3: extraction schema, composite owner keys, RLS, grants, indexes, and
-- deletion relationships. This is the first CP3 implementation slice: schema and
-- row-level security only. No provider, API key, worker, or user material is
-- wired here.
--
-- Depends on CP2 migrations (20261124220000, 20261124224500, 20261124230500).
-- Apply in a development Supabase project first, then review before other
-- environments. Transactional and rerunnable: rerunning converges constraints,
-- policies, grants, and indexes without dropping or rewriting user rows.
--
-- Ownership model (unchanged from CP2): every business table carries user_id,
-- and cross-table references use a composite (id, user_id) foreign key so a row
-- can only be linked to another row owned by the same account. RLS defaults to
-- revoke-then-grant; the ciphertext, queue, and worker-internal tables stay
-- closed to anon/authenticated.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- ai_credentials — BYOK ciphertext only (ADR-001). Never plaintext.
-- The client may read only non-sensitive configuration + metadata; ciphertext,
-- nonce, wrapped DEK, and KEK material are never granted to anon/authenticated.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  label text,
  model text,
  endpoint text not null,
  protocol text not null,
  last_four text,
  ciphertext text not null,
  nonce text not null,
  wrapped_dek text not null,
  wrapped_dek_nonce text not null,
  kek_version text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz
);

-- ---------------------------------------------------------------------------
-- material_revisions — immutable source snapshot so evidence stays bound to the
-- content it was extracted from, not a mutable material (ADR-003).
-- ---------------------------------------------------------------------------
create table if not exists public.material_revisions (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_no integer not null,
  content_hash text not null,
  parser_version text,
  parse_status text not null default 'stored',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- material_segments — normalized, ordered text chunks with a stable locator and
-- hash. Evidence points at (revision_id, segment_id), never at raw material.
-- ---------------------------------------------------------------------------
create table if not exists public.material_segments (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence integer not null,
  text_content text not null,
  content_hash text not null,
  source_locator jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- processing_jobs — user-visible job state, idempotency, lease, and safe error
-- codes. Queue messages carry only the job UUID, never material or secrets.
-- ---------------------------------------------------------------------------
create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  target_id uuid,
  status text not null default 'queued',
  idempotency_key text not null,
  attempt integer not null default 0,
  lease_token text,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- extraction_consents — proves which revision/segments the user agreed to send
-- to which provider/model/endpoint/protocol (ADR-004). Immutable after creation.
-- ---------------------------------------------------------------------------
create table if not exists public.extraction_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  material_revision_id uuid not null,
  credential_id uuid,
  provider text not null,
  model text not null,
  endpoint text not null,
  protocol text not null,
  adapter_id text,
  adapter_version text,
  prompt_version text not null,
  schema_version text not null,
  payload_hash text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- extraction_consent_segments — the segment scope of a consent, as a proper
-- relation instead of a uuid[] column. The redundant revision_id column lets a
-- composite foreign key assert that each selected segment actually belongs to
-- the consent's revision (and the same owner) at the database level.
-- ---------------------------------------------------------------------------
create table if not exists public.extraction_consent_segments (
  consent_id uuid not null,
  segment_id uuid not null,
  revision_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (consent_id, segment_id)
);

-- ---------------------------------------------------------------------------
-- extraction_runs — audit, idempotency, cost, and failure recovery. Immutable
-- provider/model/endpoint/versions. Raw model output is not stored.
-- ---------------------------------------------------------------------------
create table if not exists public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_id uuid not null,
  credential_id uuid,
  provider text not null,
  model text not null,
  endpoint text not null,
  protocol text not null,
  adapter_id text,
  adapter_version text,
  prompt_version text not null,
  schema_version text not null,
  parser_version text,
  pipeline_version text,
  status text not null default 'queued',
  usage jsonb,
  attempts integer not null default 0,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- claims — separates origin (ai/user) from review state (pending/confirmed/
-- rejected). AI can only create origin='ai' + review_state='pending' via the
-- server path; authenticated cannot set origin/review_state directly.
-- ---------------------------------------------------------------------------
create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  experience_id uuid not null,
  run_id uuid,
  origin text not null default 'user',
  category text not null default 'other',
  claim_text text not null,
  review_state text not null default 'pending',
  version integer not null default 1,
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- claim_revisions — auditable user edits without overwriting the AI proposal.
-- ---------------------------------------------------------------------------
create table if not exists public.claim_revisions (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  previous_text text,
  new_text text not null,
  actor uuid not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- claim_evidence — many-to-many evidence links; each AI claim has >= 1 row.
-- Server verifies quote and offsets; authenticated cannot insert/update.
-- ---------------------------------------------------------------------------
create table if not exists public.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null,
  segment_id uuid not null,
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  quote text not null,
  offsets jsonb not null default '{}'::jsonb,
  content_hash text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- deletion_jobs — recoverable saga state across Storage/Postgres/queue cleanup.
-- ---------------------------------------------------------------------------
create table if not exists public.deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  status text not null default 'queued',
  stage text,
  pending_object_keys text[] not null default '{}'::text[],
  attempt integer not null default 0,
  error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- materials.current_revision_id — CP3 processing pointer (ADR-003). The CP2
-- source fields and UI semantics are unchanged; parse state lives in revisions.
-- ---------------------------------------------------------------------------
alter table public.materials
  add column if not exists current_revision_id uuid;

-- ---------------------------------------------------------------------------
-- Composite owner keys and foreign keys.
-- Every cross-table reference uses (id, user_id) so a row can only link to
-- another row owned by the same account. Guarded by existence checks so the
-- migration converges on rerun without failing on already-applied constraints.
-- ---------------------------------------------------------------------------
do $$
begin
  -- Composite (id, user_id) unique keys. Every composite owner FK below needs
  -- its referenced table to carry a unique constraint on (id, user_id). CP2
  -- already added these for materials and experiences; the CP3 tables add
  -- their own here (guarded so reruns converge).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_credentials'::regclass
      and conname = 'ai_credentials_id_user_id_key'
  ) then
    alter table public.ai_credentials
      add constraint ai_credentials_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_revisions'::regclass
      and conname = 'material_revisions_id_user_id_key'
  ) then
    alter table public.material_revisions
      add constraint material_revisions_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_segments'::regclass
      and conname = 'material_segments_id_user_id_key'
  ) then
    alter table public.material_segments
      add constraint material_segments_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_segments'::regclass
      and conname = 'material_segments_id_revision_user_key'
  ) then
    alter table public.material_segments
      add constraint material_segments_id_revision_user_key
      unique (id, revision_id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consents'::regclass
      and conname = 'extraction_consents_id_user_id_key'
  ) then
    alter table public.extraction_consents
      add constraint extraction_consents_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consents'::regclass
      and conname = 'extraction_consents_id_revision_user_key'
  ) then
    alter table public.extraction_consents
      add constraint extraction_consents_id_revision_user_key
      unique (id, material_revision_id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_runs'::regclass
      and conname = 'extraction_runs_id_user_id_key'
  ) then
    alter table public.extraction_runs
      add constraint extraction_runs_id_user_id_key unique (id, user_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass
      and conname = 'claims_id_user_id_key'
  ) then
    alter table public.claims
      add constraint claims_id_user_id_key unique (id, user_id);
  end if;

  -- material_revisions -> materials, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_revisions'::regclass
      and conname = 'material_revisions_material_owner_fkey'
  ) then
    alter table public.material_revisions
      add constraint material_revisions_material_owner_fkey
      foreign key (material_id, user_id)
      references public.materials(id, user_id) on delete cascade;
  end if;

  -- material_revisions unique per material
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_revisions'::regclass
      and conname = 'material_revisions_material_id_revision_no_key'
  ) then
    alter table public.material_revisions
      add constraint material_revisions_material_id_revision_no_key
      unique (material_id, revision_no);
  end if;

  -- materials.current_revision_id -> material_revisions. Single-column FK with
  -- ON DELETE SET NULL: only the pointer is nulled, not the NOT NULL user_id
  -- (a composite FK with SET NULL would try to null user_id and fail). Owner
  -- and same-material consistency are asserted by a deferred constraint trigger
  -- below (assert_revision_owner).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.materials'::regclass
      and conname = 'materials_current_revision_fkey'
  ) then
    alter table public.materials
      add constraint materials_current_revision_fkey
      foreign key (current_revision_id)
      references public.material_revisions(id) on delete set null;
  end if;

  -- material_segments -> material_revisions, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.material_segments'::regclass
      and conname = 'material_segments_revision_owner_fkey'
  ) then
    alter table public.material_segments
      add constraint material_segments_revision_owner_fkey
      foreign key (revision_id, user_id)
      references public.material_revisions(id, user_id) on delete cascade;
  end if;

  -- extraction_consents -> material_revisions, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consents'::regclass
      and conname = 'extraction_consents_revision_owner_fkey'
  ) then
    alter table public.extraction_consents
      add constraint extraction_consents_revision_owner_fkey
      foreign key (material_revision_id, user_id)
      references public.material_revisions(id, user_id) on delete cascade;
  end if;

  -- extraction_consents -> ai_credentials. Single-column FK + SET NULL so the
  -- consent (audit record) survives credential deletion while only credential_id
  -- is nulled. Owner consistency is asserted by assert_credential_owner below.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consents'::regclass
      and conname = 'extraction_consents_credential_fkey'
  ) then
    alter table public.extraction_consents
      add constraint extraction_consents_credential_fkey
      foreign key (credential_id)
      references public.ai_credentials(id) on delete set null;
  end if;

  -- extraction_runs -> extraction_consents, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_runs'::regclass
      and conname = 'extraction_runs_consent_owner_fkey'
  ) then
    alter table public.extraction_runs
      add constraint extraction_runs_consent_owner_fkey
      foreign key (consent_id, user_id)
      references public.extraction_consents(id, user_id) on delete cascade;
  end if;

  -- extraction_runs -> ai_credentials. Single-column FK + SET NULL (same
  -- rationale as consent.credential_id above).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_runs'::regclass
      and conname = 'extraction_runs_credential_fkey'
  ) then
    alter table public.extraction_runs
      add constraint extraction_runs_credential_fkey
      foreign key (credential_id)
      references public.ai_credentials(id) on delete set null;
  end if;

  -- claims -> experiences, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass
      and conname = 'claims_experience_owner_fkey'
  ) then
    alter table public.claims
      add constraint claims_experience_owner_fkey
      foreign key (experience_id, user_id)
      references public.experiences(id, user_id) on delete cascade;
  end if;

  -- claims -> extraction_runs. ON DELETE CASCADE: an AI claim exists only as a
  -- derivative of its run, so deleting the run (e.g. when its source revision is
  -- deleted) must remove the claim, not orphan it. Manual claims have run_id
  -- null and are unaffected (enforced by claims_origin_run_check below).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass
      and conname = 'claims_run_owner_fkey'
  ) then
    alter table public.claims
      add constraint claims_run_owner_fkey
      foreign key (run_id, user_id)
      references public.extraction_runs(id, user_id) on delete cascade;
  end if;

  -- claim_revisions -> claims, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claim_revisions'::regclass
      and conname = 'claim_revisions_claim_owner_fkey'
  ) then
    alter table public.claim_revisions
      add constraint claim_revisions_claim_owner_fkey
      foreign key (claim_id, user_id)
      references public.claims(id, user_id) on delete cascade;
  end if;

  -- claim_evidence -> claims, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claim_evidence'::regclass
      and conname = 'claim_evidence_claim_owner_fkey'
  ) then
    alter table public.claim_evidence
      add constraint claim_evidence_claim_owner_fkey
      foreign key (claim_id, user_id)
      references public.claims(id, user_id) on delete cascade;
  end if;

  -- claim_evidence -> material_segments, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claim_evidence'::regclass
      and conname = 'claim_evidence_segment_owner_fkey'
  ) then
    alter table public.claim_evidence
      add constraint claim_evidence_segment_owner_fkey
      foreign key (segment_id, user_id)
      references public.material_segments(id, user_id) on delete cascade;
  end if;

  -- claim_evidence -> extraction_runs, same owner
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claim_evidence'::regclass
      and conname = 'claim_evidence_run_owner_fkey'
  ) then
    alter table public.claim_evidence
      add constraint claim_evidence_run_owner_fkey
      foreign key (run_id, user_id)
      references public.extraction_runs(id, user_id) on delete cascade;
  end if;

  -- extraction_consent_segments -> extraction_consents. The redundant
  -- revision_id column is carried through the composite FK so the selected
  -- segment is provably within the consent's revision (and same owner).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consent_segments'::regclass
      and conname = 'extraction_consent_segments_consent_fkey'
  ) then
    alter table public.extraction_consent_segments
      add constraint extraction_consent_segments_consent_fkey
      foreign key (consent_id, revision_id, user_id)
      references public.extraction_consents(id, material_revision_id, user_id)
      on delete cascade;
  end if;

  -- extraction_consent_segments -> material_segments. Same owner and same
  -- revision, so the segment belongs to the consent's revision.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.extraction_consent_segments'::regclass
      and conname = 'extraction_consent_segments_segment_fkey'
  ) then
    alter table public.extraction_consent_segments
      add constraint extraction_consent_segments_segment_fkey
      foreign key (segment_id, revision_id, user_id)
      references public.material_segments(id, revision_id, user_id)
      on delete cascade;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enumerated-domain CHECK constraints. Dropped first so the migration converges
-- on rerun without failing on an existing constraint with a different shape.
-- ---------------------------------------------------------------------------
alter table public.ai_credentials drop constraint if exists ai_credentials_status_check;
alter table public.ai_credentials
  add constraint ai_credentials_status_check
  check (status in ('active', 'deleting'));

alter table public.material_revisions drop constraint if exists material_revisions_parse_status_check;
alter table public.material_revisions
  add constraint material_revisions_parse_status_check
  check (parse_status in ('stored', 'parsing', 'ready', 'unsupported', 'needs_user_input', 'failed'));

alter table public.processing_jobs drop constraint if exists processing_jobs_kind_check;
alter table public.processing_jobs
  add constraint processing_jobs_kind_check
  check (kind in ('fetch_web', 'parse_file', 'normalize_note', 'extract_claims', 'delete_material', 'delete_experience', 'delete_account', 'reap_temporary_data'));

alter table public.processing_jobs drop constraint if exists processing_jobs_status_check;
alter table public.processing_jobs
  add constraint processing_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'canceled'));

alter table public.extraction_runs drop constraint if exists extraction_runs_status_check;
alter table public.extraction_runs
  add constraint extraction_runs_status_check
  check (status in ('queued', 'running', 'validating', 'completed', 'partial', 'failed', 'outcome_unknown'));

alter table public.claims drop constraint if exists claims_origin_check;
alter table public.claims
  add constraint claims_origin_check check (origin in ('ai', 'user'));

alter table public.claims drop constraint if exists claims_review_state_check;
alter table public.claims
  add constraint claims_review_state_check
  check (review_state in ('pending', 'confirmed', 'rejected'));

alter table public.claims drop constraint if exists claims_category_check;
alter table public.claims
  add constraint claims_category_check
  check (category in ('project', 'organization', 'role', 'action', 'technology', 'outcome', 'metric', 'date', 'skill', 'learning', 'other'));

alter table public.claims drop constraint if exists claims_manual_origin_state_check;
alter table public.claims
  add constraint claims_manual_origin_state_check
  check (origin = 'ai' or (origin = 'user' and run_id is null));

alter table public.claims drop constraint if exists claims_origin_run_check;
alter table public.claims
  add constraint claims_origin_run_check
  check (
    (origin = 'user' and run_id is null)
    or (origin = 'ai' and run_id is not null)
  );

alter table public.deletion_jobs drop constraint if exists deletion_jobs_target_type_check;
alter table public.deletion_jobs
  add constraint deletion_jobs_target_type_check
  check (target_type in ('material', 'experience', 'account', 'credential'));

alter table public.deletion_jobs drop constraint if exists deletion_jobs_status_check;
alter table public.deletion_jobs
  add constraint deletion_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed'));

-- ---------------------------------------------------------------------------
-- Deferred constraint triggers: assert owner/derivation consistency for the
-- single-column "nullable reference" FKs that cannot carry a composite owner
-- key (a composite FK with ON DELETE SET NULL would null the NOT NULL user_id).
-- These run at commit time so insert-then-backfill sequences stay valid.
-- ---------------------------------------------------------------------------

-- materials.current_revision_id must point at a revision of this material and
-- the same owner.
create or replace function public.assert_material_revision_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_revision_id is not null then
    if not exists (
      select 1 from public.material_revisions r
      where r.id = new.current_revision_id
        and r.material_id = new.id
        and r.user_id = new.user_id
    ) then
      raise exception 'current_revision_id does not belong to this material or owner';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.assert_material_revision_owner() from public, anon, authenticated;

drop trigger if exists materials_current_revision_owner on public.materials;
create constraint trigger materials_current_revision_owner
after insert or update of current_revision_id on public.materials
deferrable initially deferred
for each row execute function public.assert_material_revision_owner();

-- credential_id references must stay within the same owner (single-column FK
-- can only assert existence, not ownership).
create or replace function public.assert_credential_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.credential_id is not null then
    if not exists (
      select 1 from public.ai_credentials c
      where c.id = new.credential_id
        and c.user_id = new.user_id
    ) then
      raise exception 'credential_id does not belong to this owner';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.assert_credential_owner() from public, anon, authenticated;

drop trigger if exists extraction_consents_credential_owner on public.extraction_consents;
create constraint trigger extraction_consents_credential_owner
after insert or update of credential_id on public.extraction_consents
deferrable initially deferred
for each row execute function public.assert_credential_owner();

drop trigger if exists extraction_runs_credential_owner on public.extraction_runs;
create constraint trigger extraction_runs_credential_owner
after insert or update of credential_id on public.extraction_runs
deferrable initially deferred
for each row execute function public.assert_credential_owner();

-- claim_evidence: the claim, its run, and the cited segment must form a
-- consistent derivation chain — the segment belongs to the run's revision and
-- the claim was produced by that same run.
create or replace function public.assert_claim_evidence_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_segment_revision uuid;
  v_run_revision uuid;
  v_claim_run uuid;
begin
  select revision_id into v_segment_revision
    from public.material_segments where id = new.segment_id;

  select c.material_revision_id into v_run_revision
    from public.extraction_runs r
    join public.extraction_consents c on c.id = r.consent_id
    where r.id = new.run_id;

  select run_id into v_claim_run
    from public.claims where id = new.claim_id;

  if v_segment_revision is distinct from v_run_revision then
    raise exception 'evidence segment revision does not match run revision';
  end if;
  if v_claim_run is distinct from new.run_id then
    raise exception 'evidence claim was not produced by this run';
  end if;
  return new;
end;
$$;
revoke all on function public.assert_claim_evidence_consistency() from public, anon, authenticated;

drop trigger if exists claim_evidence_consistency on public.claim_evidence;
create constraint trigger claim_evidence_consistency
after insert or update on public.claim_evidence
deferrable initially deferred
for each row execute function public.assert_claim_evidence_consistency();

-- ---------------------------------------------------------------------------
-- Indexes: owner + status/time, revision segments, claim evidence, job lease
-- and idempotency, and deletion retry.
-- ---------------------------------------------------------------------------
create index if not exists ai_credentials_user_idx
  on public.ai_credentials (user_id, created_at desc);
create index if not exists material_revisions_material_idx
  on public.material_revisions (material_id, revision_no desc);
create index if not exists material_segments_revision_idx
  on public.material_segments (revision_id, sequence);
create index if not exists processing_jobs_user_status_idx
  on public.processing_jobs (user_id, status, created_at desc);

-- Idempotency: only one active (queued/running) job per idempotency key and
-- owner. Completed/failed jobs release the key so a user retry can enqueue a
-- fresh job with the same key.
drop index if exists processing_jobs_idempotency_idx;
create unique index processing_jobs_idempotency_idx
  on public.processing_jobs (user_id, idempotency_key)
  where status in ('queued', 'running');
create index if not exists extraction_consents_user_idx
  on public.extraction_consents (user_id, created_at desc);
create index if not exists extraction_runs_user_status_idx
  on public.extraction_runs (user_id, status, created_at desc);
create index if not exists claims_experience_state_idx
  on public.claims (experience_id, review_state);
create index if not exists claims_user_idx
  on public.claims (user_id, created_at desc);
create index if not exists claim_evidence_claim_idx
  on public.claim_evidence (claim_id);
create index if not exists claim_evidence_segment_idx
  on public.claim_evidence (segment_id);
create index if not exists deletion_jobs_user_status_idx
  on public.deletion_jobs (user_id, status, created_at desc);

-- One active deletion job per target: prevents duplicate/parallel cleanup of
-- the same material/experience/account/credential.
drop index if exists deletion_jobs_active_target_idx;
create unique index deletion_jobs_active_target_idx
  on public.deletion_jobs (user_id, target_type, target_id)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- updated_at trigger coverage for tables that carry the column.
-- ---------------------------------------------------------------------------
drop trigger if exists ai_credentials_set_updated_at on public.ai_credentials;
create trigger ai_credentials_set_updated_at
before update on public.ai_credentials
for each row execute function public.set_updated_at();

drop trigger if exists material_revisions_set_updated_at on public.material_revisions;
create trigger material_revisions_set_updated_at
before update on public.material_revisions
for each row execute function public.set_updated_at();

drop trigger if exists processing_jobs_set_updated_at on public.processing_jobs;
create trigger processing_jobs_set_updated_at
before update on public.processing_jobs
for each row execute function public.set_updated_at();

drop trigger if exists extraction_runs_set_updated_at on public.extraction_runs;
create trigger extraction_runs_set_updated_at
before update on public.extraction_runs
for each row execute function public.set_updated_at();

drop trigger if exists claims_set_updated_at on public.claims;
create trigger claims_set_updated_at
before update on public.claims
for each row execute function public.set_updated_at();

drop trigger if exists deletion_jobs_set_updated_at on public.deletion_jobs;
create trigger deletion_jobs_set_updated_at
before update on public.deletion_jobs
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and RLS.
--
-- Principles (CP3 design section 3, ADR-001/003/004):
--   * Default revoke, then grant the minimum.
--   * ai_credentials: client reads non-sensitive config/metadata only; the
--     ciphertext, nonce, wrapped DEK, and KEK columns are NOT granted. Write,
--     decrypt, and delete go through restricted server functions (future slice).
--   * processing_jobs, deletion_jobs: worker/internal state; closed to clients.
--   * claims/claim_evidence: server-only writes. authenticated may read and
--     delete is denied (server-managed cleanup); origin/review_state/run are
--     never client-writable.
--   * material_revisions/material_segments/extraction_consents/extraction_runs:
--     read-only to the owner (audit/source traceability); server writes.
-- ---------------------------------------------------------------------------

-- ai_credentials: table-level revoke, then column-level grants for the safe set.
revoke all on table public.ai_credentials from anon, authenticated;
grant select (
  id, user_id, provider, label, model, endpoint, protocol, last_four,
  status, created_at, updated_at, rotated_at
) on table public.ai_credentials to authenticated;

revoke all on table public.material_revisions from anon, authenticated;
grant select on table public.material_revisions to authenticated;

revoke all on table public.material_segments from anon, authenticated;
grant select on table public.material_segments to authenticated;

-- processing_jobs and deletion_jobs stay closed to anon/authenticated entirely.
revoke all on table public.processing_jobs from anon, authenticated;
revoke all on table public.deletion_jobs from anon, authenticated;

revoke all on table public.extraction_consents from anon, authenticated;
grant select on table public.extraction_consents to authenticated;

revoke all on table public.extraction_consent_segments from anon, authenticated;
grant select on table public.extraction_consent_segments to authenticated;

revoke all on table public.extraction_runs from anon, authenticated;
grant select on table public.extraction_runs to authenticated;

-- claims: owner read only. No insert/update/delete grant — confirm/edit/reject
-- and server-side AI writes are the only mutation paths.
revoke all on table public.claims from anon, authenticated;
grant select on table public.claims to authenticated;

revoke all on table public.claim_revisions from anon, authenticated;
grant select on table public.claim_revisions to authenticated;

revoke all on table public.claim_evidence from anon, authenticated;
grant select on table public.claim_evidence to authenticated;

alter table public.ai_credentials enable row level security;
alter table public.material_revisions enable row level security;
alter table public.material_segments enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.extraction_consents enable row level security;
alter table public.extraction_consent_segments enable row level security;
alter table public.extraction_runs enable row level security;
alter table public.claims enable row level security;
alter table public.claim_revisions enable row level security;
alter table public.claim_evidence enable row level security;
alter table public.deletion_jobs enable row level security;

-- ai_credentials: owner can read its own non-sensitive columns only (column-
-- level grant already excludes ciphertext). No write policy for clients.
drop policy if exists ai_credentials_select_own on public.ai_credentials;
create policy ai_credentials_select_own on public.ai_credentials
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists material_revisions_select_own on public.material_revisions;
create policy material_revisions_select_own on public.material_revisions
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists material_segments_select_own on public.material_segments;
create policy material_segments_select_own on public.material_segments
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists extraction_consents_select_own on public.extraction_consents;
create policy extraction_consents_select_own on public.extraction_consents
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists extraction_consent_segments_select_own on public.extraction_consent_segments;
create policy extraction_consent_segments_select_own on public.extraction_consent_segments
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists extraction_runs_select_own on public.extraction_runs;
create policy extraction_runs_select_own on public.extraction_runs
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists claims_select_own on public.claims;
create policy claims_select_own on public.claims
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists claim_revisions_select_own on public.claim_revisions;
create policy claim_revisions_select_own on public.claim_revisions
for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists claim_evidence_select_own on public.claim_evidence;
create policy claim_evidence_select_own on public.claim_evidence
for select to authenticated using ((select auth.uid()) = user_id);

commit;

-- ---------------------------------------------------------------------------
-- Rollback and forward-fix notes (documentation only; not executed).
--
-- Forward fix is the preferred path. Never drop these tables, triggers,
-- policies, or grants on production data without an explicit backup and
-- deletion approval.
--
-- To roll back this slice on a development project (destructive):
--   drop policy if exists ai_credentials_select_own on public.ai_credentials;
--   ... (drop each *_select_own policy above) ...
--   alter table public.ai_credentials disable row level security;
--   ... (disable RLS on the other new tables) ...
--   drop trigger if exists materials_current_revision_owner on public.materials;
--   drop trigger if exists extraction_consents_credential_owner on public.extraction_consents;
--   drop trigger if exists extraction_runs_credential_owner on public.extraction_runs;
--   drop trigger if exists claim_evidence_consistency on public.claim_evidence;
--   drop function if exists public.assert_material_revision_owner();
--   drop function if exists public.assert_credential_owner();
--   drop function if exists public.assert_claim_evidence_consistency();
--   alter table public.materials drop column if exists current_revision_id;
--   drop table if exists public.extraction_consent_segments cascade;
--   drop table if exists public.claim_evidence, public.claim_revisions,
--     public.claims, public.extraction_runs, public.extraction_consents,
--     public.processing_jobs, public.material_segments, public.material_revisions,
--     public.ai_credentials, public.deletion_jobs cascade;
-- This ordering is mandatory: drop the deferred constraint triggers and the
-- extraction_consent_segments relation first (they reference consents/segments),
-- then child tables (claim_evidence, claim_revisions, extraction_runs,
-- extraction_consents, material_segments) before their composite-FK parents
-- (claims, material_revisions, ai_credentials), and materials.current_revision_id
-- before material_revisions so the single-column FK does not block the drop.
--
-- Forward fixes already expected in later slices (do not implement here):
--   * BYOK save/replace/delete/decrypt as restricted SECURITY DEFINER functions
--     (ADR-001), not client grants.
--   * processing_jobs queue enqueue/dequeue and lease heartbeat via server path.
--   * claim confirm/edit/reject RPC bound to auth.uid() with optimistic locking.
--   * deletion_jobs saga orchestration (server-managed deletes, CP2 regression).
-- ---------------------------------------------------------------------------
