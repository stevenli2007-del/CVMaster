import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AAD_PROTOCOL_VERSION,
  sealCredentialKey,
  openCredentialKey,
} from "../lib/byok/crypto.ts";

// Crypto unit tests run against the pure crypto functions with an injected KEK.
// The KEK is provided via environment variables that mirror the server config.

const KEK_VERSION = "v1";
const KEK_KEY = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000001",
  "hex",
).toString("base64");

function withKek(fn: () => void | Promise<void>) {
  return async () => {
    process.env.BYOK_ACTIVE_KEK_VERSION = KEK_VERSION;
    process.env[`BYOK_KEK_${KEK_VERSION}`] = KEK_KEY;
    try {
      await fn();
    } finally {
      delete process.env.BYOK_ACTIVE_KEK_VERSION;
      delete process.env[`BYOK_KEK_${KEK_VERSION}`];
    }
  };
}

const identity = {
  userId: "user-00000000-0000-4000-8000-000000000001",
  credentialId: "cred-00000000-0000-4000-8000-000000000001",
  provider: "DeepSeek",
};

test("seal then open round-trips the plaintext", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  assert.equal(sealed.lastFour, "2345");
  assert.equal(sealed.kekVersion, KEK_VERSION);
  const opened = openCredentialKey({ ...sealed, ...identity });
  assert.equal(opened, "sk-test-12345");
}));

test("two seals of the same input produce different ciphertext", withKek(() => {
  const a = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  const b = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.wrappedDek, b.wrappedDek);
}));

test("AAD binding rejects a different user", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  assert.throws(
    () => openCredentialKey({ ...sealed, ...identity, userId: "user-other" }),
    /unable to authenticate data|auth/i,
  );
}));

test("AAD binding rejects a different credential id", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  assert.throws(
    () => openCredentialKey({ ...sealed, ...identity, credentialId: "cred-other" }),
    /unable to authenticate data|auth/i,
  );
}));

test("AAD binding rejects a different provider", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  assert.throws(
    () => openCredentialKey({ ...sealed, ...identity, provider: "Qwen" }),
    /unable to authenticate data|auth/i,
  );
}));

test("tampering with ciphertext fails to decrypt", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  const tampered = Buffer.from(sealed.ciphertext, "base64");
  tampered[0] ^= 0xff;
  assert.throws(
    () => openCredentialKey({ ...sealed, ...identity, ciphertext: tampered.toString("base64") }),
    /unable to authenticate data|auth/i,
  );
}));

test("tampering with wrapped DEK fails to decrypt", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  const tampered = Buffer.from(sealed.wrappedDek, "base64");
  tampered[0] ^= 0xff;
  assert.throws(
    () => openCredentialKey({ ...sealed, ...identity, wrappedDek: tampered.toString("base64") }),
    /unable to authenticate data|auth/i,
  );
}));

test("wrong KEK version fails to decrypt", withKek(() => {
  const sealed = sealCredentialKey({ plaintextKey: "sk-test-12345", ...identity });
  process.env[`BYOK_KEK_v2`] = Buffer.alloc(32, 0x02).toString("base64");
  try {
    assert.throws(
      () => openCredentialKey({ ...sealed, ...identity, kekVersion: "v2" }),
      /unable to authenticate data|auth/i,
    );
  } finally {
    delete process.env[`BYOK_KEK_v2`];
  }
}));

test("empty API key is rejected", withKek(() => {
  assert.throws(() => sealCredentialKey({ plaintextKey: "   ", ...identity }), /empty/i);
}));

test("AAD protocol version is exported and stable", () => {
  assert.equal(AAD_PROTOCOL_VERSION, "cvmaster.byok.envelope.v1");
});
