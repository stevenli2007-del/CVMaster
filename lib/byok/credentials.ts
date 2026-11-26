import { sealCredentialKey } from "@/lib/byok/crypto";
import { validateEndpoint } from "@/lib/byok/endpoint";
import { toCredentialDTO } from "@/lib/credential-dto";
import type { Database } from "@/lib/database.types";
import type { CredentialDTO } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

// Server-only BYOK credential operations. Every path verifies owner first and
// never returns ciphertext/plaintext. This module must only be imported from
// Route Handlers / server runtime (it depends on node crypto + service role).

type AdminClient = SupabaseClient<Database>;

// The metadata-only column subset that is safe to select and map to a DTO.
export type CredentialMetadata = Pick<
  Database["public"]["Tables"]["ai_credentials"]["Row"],
  "id" | "user_id" | "provider" | "label" | "model" | "endpoint" | "protocol" | "last_four" | "status" | "created_at" | "updated_at"
>;

export type CredentialInput = {
  provider: string;
  label?: string | null | undefined;
  model?: string | null | undefined;
  endpoint: string;
  protocol: string;
  apiKey: string;
};

// Replace input: apiKey and endpoint may be omitted to keep the existing
// value; provider/protocol/label/model are always re-specified.
export type CredentialReplaceInput = {
  provider: string;
  label?: string | null | undefined;
  model?: string | null | undefined;
  endpoint?: string | null | undefined;
  protocol: string;
  apiKey?: string | null | undefined;
};

export type CredentialError =
  | { kind: "unauthenticated" }
  | { kind: "invalid_input"; message: string }
  | { kind: "endpoint"; code: string }
  | { kind: "not_found" }
  | { kind: "concurrent_update" }
  | { kind: "crypto_unavailable"; message: string }
  | { kind: "store_failure" };

export type CredentialResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CredentialError };

const SAFE_ENDPOINT_MESSAGES: Record<string, string> = {
  endpoint_invalid: "Enter a valid endpoint URL.",
  endpoint_requires_https: "Only HTTPS endpoints are allowed.",
  endpoint_userinfo: "Endpoint must not include a username or password.",
  endpoint_fragment: "Endpoint must not include a fragment.",
  endpoint_query_secret: "Endpoint query must not contain an API key or secret.",
  endpoint_blocked_hostname: "This endpoint host is not allowed.",
  endpoint_dns_unresolvable: "This endpoint host could not be resolved.",
  endpoint_loopback: "Endpoint must not point to a local or loopback address.",
  endpoint_private_address: "Endpoint must point to a public internet address.",
};

function endpointMessage(code: string): string {
  return SAFE_ENDPOINT_MESSAGES[code] ?? "This endpoint is not allowed.";
}

function normalizeProtocol(protocol: string): string {
  return protocol.trim().toLowerCase();
}

function normalizeProvider(provider: string): string {
  return provider.trim();
}

// Save a new credential. Generates the credential id before sealing so the
// AAD can bind credential_id (ADR-001 §1.3).
export async function saveCredential(
  admin: AdminClient,
  userId: string,
  input: CredentialInput,
): Promise<CredentialResult<CredentialDTO>> {
  const endpointResult = await validateEndpoint(input.endpoint);
  if (!endpointResult.ok) return { ok: false, error: { kind: "endpoint", code: endpointResult.code } };

  const credentialId = crypto.randomUUID();
  const provider = normalizeProvider(input.provider);

  let sealed;
  try {
    sealed = sealCredentialKey({
      plaintextKey: input.apiKey,
      userId,
      credentialId,
      provider,
    });
  } catch (err) {
    // The API key is never logged; only a safe, generic message surfaces.
    const message = err instanceof Error && err.message.includes("KEK") ? err.message : "Could not secure this API key.";
    return { ok: false, error: { kind: "crypto_unavailable", message } };
  }

  const { data, error } = await admin
    .from("ai_credentials")
    .insert({
      id: credentialId,
      user_id: userId,
      provider,
      label: input.label?.trim() || null,
      model: input.model?.trim() || null,
      endpoint: endpointResult.normalized,
      protocol: normalizeProtocol(input.protocol),
      last_four: sealed.lastFour,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      wrapped_dek: sealed.wrappedDek,
      wrapped_dek_nonce: sealed.wrappedDekNonce,
      wrapped_dek_tag: sealed.wrappedDekTag,
      kek_version: sealed.kekVersion,
      status: "active",
    })
    .select("id, user_id, provider, label, model, endpoint, protocol, last_four, status, created_at, updated_at")
    .single();

  if (error || !data) return { ok: false, error: { kind: "store_failure" } };
  return { ok: true, data: toCredentialDTO(data) };
}

// Replace an existing credential's key + config in place (ADR-001 §4). Owner
// is verified; the credential_id stays stable so consents/runs keep pointing
// at the same logical credential while the ciphertext is swapped.
//
// The API key may be left blank to keep the existing key. Because the provider
// is bound into the ciphertext AAD, keeping the key requires the provider to
// remain unchanged; a blank key with a changed provider is rejected. The
// endpoint may also be left blank to keep the existing (already-validated)
// endpoint.
export async function replaceCredential(
  admin: AdminClient,
  userId: string,
  credentialId: string,
  input: CredentialReplaceInput,
): Promise<CredentialResult<CredentialDTO>> {
  const { data: existing, error: readError } = await admin
    .from("ai_credentials")
    .select("id, user_id, provider, endpoint")
    .eq("id", credentialId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return { ok: false, error: { kind: "store_failure" } };
  if (!existing) return { ok: false, error: { kind: "not_found" } };

  const provider = normalizeProvider(input.provider);
  const keepKey = !input.apiKey || input.apiKey.trim().length === 0;

  // Keeping the existing key requires the provider to stay the same, since the
  // provider is part of the AAD used to seal the stored ciphertext.
  if (keepKey && provider !== existing.provider) {
    return { ok: false, error: { kind: "invalid_input", message: "To keep the existing key, the provider must stay the same. Enter a new key to change providers." } };
  }

  // Endpoint: blank keeps the existing value; otherwise re-validate.
  let normalizedEndpoint: string;
  if (!input.endpoint || input.endpoint.trim().length === 0) {
    normalizedEndpoint = existing.endpoint;
  } else {
    const endpointResult = await validateEndpoint(input.endpoint);
    if (!endpointResult.ok) return { ok: false, error: { kind: "endpoint", code: endpointResult.code } };
    normalizedEndpoint = endpointResult.normalized;
  }

  // Build the update payload. Ciphertext columns are only included when the
  // key is being rotated; otherwise the stored ciphertext is preserved.
  type CredentialUpdate = Database["public"]["Tables"]["ai_credentials"]["Update"];
  const update: CredentialUpdate = {
    provider,
    label: input.label?.trim() || null,
    model: input.model?.trim() || null,
    endpoint: normalizedEndpoint,
    protocol: normalizeProtocol(input.protocol),
  };

  if (!keepKey) {
    let sealed;
    try {
      sealed = sealCredentialKey({
        plaintextKey: input.apiKey!,
        userId,
        credentialId,
        provider,
      });
    } catch (err) {
      const message = err instanceof Error && err.message.includes("KEK") ? err.message : "Could not secure this API key.";
      return { ok: false, error: { kind: "crypto_unavailable", message } };
    }
    update.last_four = sealed.lastFour;
    update.ciphertext = sealed.ciphertext;
    update.nonce = sealed.nonce;
    update.wrapped_dek = sealed.wrappedDek;
    update.wrapped_dek_nonce = sealed.wrappedDekNonce;
    update.wrapped_dek_tag = sealed.wrappedDekTag;
    update.kek_version = sealed.kekVersion;
    update.rotated_at = new Date().toISOString();
  }

  // Atomic optimistic-lock on provider: the update only succeeds while the
  // provider still equals the value read at the start of this request. This
  // closes the read-modify-write race where a concurrent request swaps both
  // provider and key — writing back a stale provider while the stored
  // ciphertext (bound to the new provider in its AAD) is preserved would make
  // the credential undecryptable. If the row no longer matches, report a
  // retryable conflict instead of clobbering the concurrent change.
  const { data, error } = await admin
    .from("ai_credentials")
    .update(update)
    .eq("id", credentialId)
    .eq("user_id", userId)
    .eq("provider", existing.provider)
    .select("id, user_id, provider, label, model, endpoint, protocol, last_four, status, created_at, updated_at")
    .maybeSingle();

  if (error) return { ok: false, error: { kind: "store_failure" } };
  if (!data) return { ok: false, error: { kind: "concurrent_update" } };
  return { ok: true, data: toCredentialDTO(data) };
}

// Mark a credential deleting (ADR-001 §5). This blocks new runs by flipping
// status away from active; the hard delete is performed by the deletion saga
// (future slice). Idempotent: re-deleting an already-deleting credential
// returns the same result.
export async function deleteCredential(
  admin: AdminClient,
  userId: string,
  credentialId: string,
): Promise<CredentialResult<{ id: string; status: "active" | "deleting" }>> {
  const { data: existing, error: readError } = await admin
    .from("ai_credentials")
    .select("id, user_id, status")
    .eq("id", credentialId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return { ok: false, error: { kind: "store_failure" } };
  if (!existing) return { ok: false, error: { kind: "not_found" } };

  if (existing.status === "deleting") {
    return { ok: true, data: { id: existing.id, status: existing.status } };
  }

  const { data, error } = await admin
    .from("ai_credentials")
    .update({ status: "deleting" })
    .eq("id", credentialId)
    .eq("user_id", userId)
    .select("id, status")
    .single();
  if (error || !data) return { ok: false, error: { kind: "store_failure" } };
  return { ok: true, data: { id: data.id, status: data.status } };
}

// List the current user's credentials as metadata-only DTOs.
export async function listCredentials(
  admin: AdminClient,
  userId: string,
): Promise<CredentialResult<CredentialDTO[]>> {
  const { data, error } = await admin
    .from("ai_credentials")
    .select("id, user_id, provider, label, model, endpoint, protocol, last_four, status, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: { kind: "store_failure" } };
  return { ok: true, data: (data ?? []).map(toCredentialDTO) };
}

export function endpointErrorMessage(code: string): string {
  return endpointMessage(code);
}
