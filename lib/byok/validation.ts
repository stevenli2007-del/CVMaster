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

export const credentialInputSchema = z.object({
  provider: providerSchema,
  label: labelSchema,
  model: modelSchema,
  endpoint: endpointSchema,
  protocol: protocolSchema,
  apiKey: apiKeySchema,
});

export const credentialReplaceInputSchema = credentialInputSchema;
