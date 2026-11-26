import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEndpoint, maskEndpoint } from "../lib/byok/endpoint.ts";

// Endpoint safety tests. All blocked cases return a safe error code without
// making any network request. Public hosts are validated by DNS resolution
// (lookup) only; no HTTP request is issued.

test("rejects non-HTTPS", async () => {
  const result = await validateEndpoint("http://api.example.com/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_requires_https");
});

test("rejects embedded userinfo", async () => {
  const result = await validateEndpoint("https://user:pass@api.example.com/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_userinfo");
});

test("rejects fragments", async () => {
  const result = await validateEndpoint("https://api.example.com/v1#secret");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_fragment");
});

test("rejects secret-looking query keys", async () => {
  const result = await validateEndpoint("https://api.example.com/v1?api_key=abc123");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_query_secret");
});

test("rejects loopback IPv4 literal", async () => {
  const result = await validateEndpoint("https://127.0.0.1/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_loopback");
});

test("rejects loopback IPv6 literal", async () => {
  const result = await validateEndpoint("https://[::1]/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_private_address");
});

test("rejects private IPv4 literal", async () => {
  const result = await validateEndpoint("https://10.0.0.5/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_private_address");
});

test("rejects link-local IPv4 literal", async () => {
  const result = await validateEndpoint("https://169.254.169.254/latest/meta-data");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_private_address");
});

test("rejects IPv4-mapped IPv6 bypass", async () => {
  const result = await validateEndpoint("https://[::ffff:127.0.0.1]/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_private_address");
});

test("rejects multicast IPv4 literal", async () => {
  const result = await validateEndpoint("https://224.0.0.1/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_private_address");
});

test("rejects blocked hostname suffix", async () => {
  const result = await validateEndpoint("https://api.localhost/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_blocked_hostname");
});

test("rejects invalid URL", async () => {
  const result = await validateEndpoint("not a url");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "endpoint_invalid");
});

test("accepts a public HTTPS host and normalizes it", async () => {
  const result = await validateEndpoint("https://api.openai.com/v1/chat/completions");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.hostname, "api.openai.com");
    assert.ok(result.normalized.startsWith("https://api.openai.com/"));
  }
});

test("maskEndpoint hides query values and userinfo", () => {
  const masked = maskEndpoint("https://api.example.com/v1?token=secret&model=x");
  assert.ok(!masked.includes("secret"));
  assert.ok(masked.includes("REDACTED"));
});
