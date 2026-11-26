import type { CredentialMetadata } from "@/lib/byok/credentials";
import type { CredentialDTO } from "@/lib/types";
import { maskEndpoint } from "@/lib/byok/endpoint";

// Maps a credential row to the client-safe DTO. Only non-sensitive metadata is
// included; ciphertext, nonce, wrapped DEK, and KEK columns are never read
// here and never forwarded to the browser.
export function toCredentialDTO(row: CredentialMetadata): CredentialDTO {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    maskedEndpoint: maskEndpoint(row.endpoint),
    protocol: row.protocol,
    lastFour: row.last_four,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
