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

export type CredentialError =
  | { kind: "unauthenticated" }
  | { kind: "invalid_input"; message: string }
  | { kind: "endpoint"; code: string }
  | { kind: "not_found" }
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
export async function replaceCredential(
  admin: AdminClient,
  userId: string,
  credentialId: string,
  input: CredentialInput,
): Promise<CredentialResult<CredentialDTO>> {
  const endpointResult = await validateEndpoint(input.endpoint);
  if (!endpointResult.ok) return { ok: false, error: { kind: "endpoint", code: endpointResult.code } };

  const { data: existing, error: readError } = await admin
    .from("ai_credentials")
    .select("id, user_id")
    .eq("id", credentialId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return { ok: false, error: { kind: "store_failure" } };
  if (!existing) return { ok: false, error: { kind: "not_found" } };

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
    const message = err instanceof Error && err.message.includes("KEK") ? err.message : "Could not secure this API key.";
    return { ok: false, error: { kind: "crypto_unavailable", message } };
  }

  const { data, error } = await admin
    .from("ai_credentials")
    .update({
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
      rotated_at: new Date().toISOString(),
    })
    .eq("id", credentialId)
    .eq("user_id", userId)
    .select("id, user_id, provider, label, model, endpoint, protocol, last_four, status, created_at, updated_at")
    .single();

  if (error || !data) return { ok: false, error: { kind: "store_failure" } };
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
