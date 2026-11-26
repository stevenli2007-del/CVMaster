import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// BYOK envelope encryption (ADR-001, option A).
//
// Layering, per credential:
//   1. A random 256-bit DEK is generated per credential.
//   2. The provider API key is encrypted with AES-256-GCM under that DEK,
//      using a fresh 96-bit nonce. Ciphertext + auth tag are stored together
//      with the nonce in `ciphertext`/`nonce` (tag appended to ciphertext).
//   3. The DEK itself is wrapped (encrypted) with the active KEK using another
//      fresh 96-bit nonce, producing `wrapped_dek` + `wrapped_dek_nonce` +
//      `wrapped_dek_tag`.
//   4. AAD binds the protocol version, user_id, credential_id and provider so
//      a ciphertext copied to another user/credential/provider cannot decrypt.
//
// KEKs live in server environment variables (`BYOK_KEK_v<N>`), never in the
// database and never with a NEXT_PUBLIC_ prefix. `BYOK_ACTIVE_KEK_VERSION`
// selects the current wrapping key. The KEK secret itself is expected to be a
// base64-encoded 32-byte key.

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96-bit GCM nonce
const KEY_BYTES = 32; // 256-bit AES key

// Protocol version embedded in AAD and stored nowhere else. Bumping this
// invalidates all existing AAD bindings on purpose.
export const AAD_PROTOCOL_VERSION = "cvmaster.byok.envelope.v1";

export type SealedCredential = {
  ciphertext: string; // base64(ciphertext || authTag)
  nonce: string; // base64(96-bit nonce)
  wrappedDek: string; // base64(encrypted DEK || authTag)
  wrappedDekNonce: string; // base64(96-bit nonce)
  wrappedDekTag: string; // base64(16-byte auth tag)
  kekVersion: string;
  lastFour: string;
};

type KeyMaterial = {
  key: Buffer;
  version: string;
};

function b64encode(buffer: Buffer): string {
  return buffer.toString("base64");
}

function b64decode(value: string): Buffer {
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    throw new Error("Invalid base64 encoding");
  }
  return buffer;
}

// The KEK for a given version. Never returned to or logged by any caller.
function loadKek(version: string): KeyMaterial {
  // Version must be a safe identifier so it cannot be used for env traversal.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    throw new Error("Invalid KEK version");
  }
  const encoded = process.env[`BYOK_KEK_${version}`];
  if (!encoded) throw new Error("KEK is not configured for this version");

  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("KEK must be a 32-byte key");
  }
  return { key, version };
}

function activeKek(): KeyMaterial {
  const version = process.env.BYOK_ACTIVE_KEK_VERSION;
  if (!version) throw new Error("BYOK_ACTIVE_KEK_VERSION is not configured");
  return loadKek(version);
}

function buildAad(parts: { userId: string; credentialId: string; provider: string }): Buffer {
  // Length-prefixed concatenation avoids ambiguity between the fields.
  const userId = Buffer.from(parts.userId, "utf8");
  const credentialId = Buffer.from(parts.credentialId, "utf8");
  const provider = Buffer.from(parts.provider, "utf8");
  const version = Buffer.from(AAD_PROTOCOL_VERSION, "utf8");

  const head = Buffer.alloc(4 * 4);
  head.writeUInt32BE(version.length, 0);
  head.writeUInt32BE(userId.length, 4);
  head.writeUInt32BE(credentialId.length, 8);
  head.writeUInt32BE(provider.length, 12);
  return Buffer.concat([head, version, userId, credentialId, provider]);
}

function encryptWithKey(key: Buffer, plaintext: Buffer, aad: Buffer): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

function decryptWithKey(key: Buffer, ciphertext: Buffer, nonce: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Computes the masked last-four for display only. Never used for auth.
function lastFourOf(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 4) return trimmed ? trimmed : "";
  return trimmed.slice(-4);
}

// Seals a plaintext API key for a specific credential + user + provider.
// Generates a fresh DEK and wraps it with the active KEK.
export function sealCredentialKey(input: {
  plaintextKey: string;
  userId: string;
  credentialId: string;
  provider: string;
}): SealedCredential {
  if (!input.plaintextKey.trim()) throw new Error("API key must not be empty");
  if (!input.userId || !input.credentialId) throw new Error("Credential identity is required");

  const kek = activeKek();
  const dek = randomBytes(KEY_BYTES);
  const provider = input.provider.trim();

  // A single AAD binds protocol version + user + credential + provider. The
  // same binding protects both the wrapped DEK and the ciphertext, so neither
  // can be copied to another user/credential/provider and decrypted.
  const aad = buildAad({
    userId: input.userId,
    credentialId: input.credentialId,
    provider,
  });

  // Encrypt the provider key under the per-credential DEK.
  const sealed = encryptWithKey(dek, Buffer.from(input.plaintextKey, "utf8"), aad);
  // Wrap the DEK under the active KEK.
  const wrapped = encryptWithKey(kek.key, dek, aad);

  return {
    ciphertext: b64encode(Buffer.concat([sealed.ciphertext, sealed.tag])),
    nonce: b64encode(sealed.nonce),
    wrappedDek: b64encode(Buffer.concat([wrapped.ciphertext, wrapped.tag])),
    wrappedDekNonce: b64encode(wrapped.nonce),
    wrappedDekTag: b64encode(wrapped.tag),
    kekVersion: kek.version,
    lastFour: lastFourOf(input.plaintextKey),
  };
}

// Opens a stored credential back to its plaintext provider key. This is the
// ONLY place plaintext is produced; callers must scope its lifetime to a
// single authorized request and never log, store, or return it.
export function openCredentialKey(stored: {
  ciphertext: string;
  nonce: string;
  wrappedDek: string;
  wrappedDekNonce: string;
  wrappedDekTag: string;
  kekVersion: string;
  userId: string;
  credentialId: string;
  provider: string;
}): string {
  const kek = loadKek(stored.kekVersion);
  const aad = buildAad({
    userId: stored.userId,
    credentialId: stored.credentialId,
    provider: stored.provider.trim(),
  });

  const wrappedBlob = b64decode(stored.wrappedDek);
  const wrappedCiphertext = wrappedBlob.subarray(0, wrappedBlob.length - 16);
  const wrappedTag = b64decode(stored.wrappedDekTag);
  const dek = decryptWithKey(kek.key, wrappedCiphertext, b64decode(stored.wrappedDekNonce), wrappedTag, aad);

  const cipherBlob = b64decode(stored.ciphertext);
  const ciphertext = cipherBlob.subarray(0, cipherBlob.length - 16);
  const tag = cipherBlob.subarray(cipherBlob.length - 16);
  const plaintext = decryptWithKey(dek, ciphertext, b64decode(stored.nonce), tag, aad);

  return plaintext.toString("utf8");
}
