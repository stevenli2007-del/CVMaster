-- CP3: BYOK credential slice — envelope-encryption column completion and the
-- restricted credential write/delete functions (ADR-001).
--
-- Depends on 20261125160000_cp3_extraction_schema_rls.sql. Apply in a
-- development Supabase project first, then review before other environments.
-- Transactional and rerunnable.
--
-- What this slice changes:
--   * ai_credentials gains `wrapped_dek_tag` so the wrapped DEK is stored with
--     its own independent AES-256-GCM auth tag (the ciphertext already carries
--     its `nonce` + an embedded tag; the wrapped DEK needs a separate tag and
--     nonce, both of which now exist). No plaintext is ever stored.
--   * The `last_four` and ciphertext-related columns stay revoke-closed to
--     anon/authenticated (unchanged). No new client grants are added.
--
-- What this slice does NOT do (future slices):
--   * No decrypt function exposed to clients, no queue worker, no provider
--     requests, no "test connection". Application-layer envelope encryption is
--     performed in the Vercel server runtime using a versioned KEK from server
--     environment variables; the database only persists ciphertext + wrapped
--     DEK material.

begin;

-- ---------------------------------------------------------------------------
-- wrapped_dek_tag: the AES-256-GCM auth tag produced when wrapping the DEK
-- with the active KEK. Guards the wrapped DEK against tampering just as the
-- ciphertext's own tag guards the plaintext. Empty default for existing rows;
-- the application never reads a row with an empty tag as a decryptable record.
-- ---------------------------------------------------------------------------
alter table public.ai_credentials
  add column if not exists wrapped_dek_tag text not null default '';

commit;
