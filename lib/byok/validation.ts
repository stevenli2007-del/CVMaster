import { z } from "zod";

// BYOK credential input validation. The plaintext key is validated for shape
// only (non-empty, bounded) and is never logged or persisted in any form
// beyond the server-side seal operation.
export const providerSchema = z.string().trim().min(1).max(64);
export const labelSchema = z.string().trim().max(80).optional().nullable();
export const modelSchema = z.string().trim().max(160).optional().nullable();
export const endpointSchema = z.string().trim().min(1).max(2048);
export const protocolSchema = z.string().trim().min(1).max(64);
export const apiKeySchema = z.string().min(1).max(8192);

// Create: a full credential is always required.
export const credentialInputSchema = z.object({
  provider: providerSchema,
  label: labelSchema,
  model: modelSchema,
  endpoint: endpointSchema,
  protocol: protocolSchema,
  apiKey: apiKeySchema,
});

// Replace: the API key and endpoint may be omitted to keep the existing value.
// The key is only re-sealed when a non-empty value is supplied; the endpoint is
// only re-validated when a non-empty value is supplied. An empty key with a
// changed provider is rejected server-side because the provider is bound into
// the ciphertext AAD.
export const credentialReplaceInputSchema = z.object({
  provider: providerSchema,
  label: labelSchema,
  model: modelSchema,
  endpoint: z.string().trim().max(2048).optional().nullable(),
  protocol: protocolSchema,
  apiKey: z.string().max(8192).optional().nullable(),
});
