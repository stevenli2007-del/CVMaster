import { isIP } from "node:net";
import dns from "node:dns/promises";

// BYOK custom endpoint safety (ADR-001 §3, ADR-004 §「用户自定义 endpoint 的安全约束」).
//
// This module validates a user-supplied provider endpoint BEFORE any API key is
// ever sent to it. It runs entirely server-side. It does NOT make provider
// requests and does NOT implement "test connection". It only classifies whether
// a normalized endpoint is acceptable for later (consented) use.
//
// The endpoint is normalized so that the exact string the user saw and
// consented to is the string persisted and later sent. Any userinfo, fragment,
// or secret-in-query is rejected outright rather than silently stripped.

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
];

export type EndpointValidation =
  | { ok: true; normalized: string; hostname: string }
  | { ok: false; code: string };

const SAFE_ERROR = (code: string): EndpointValidation => ({ ok: false, code });

function isLoopback(address: string): boolean {
  if (address === "::1") return true;
  if (/^127\./.test(address)) return true;
  if (/^::ffff:127\./.test(address)) return true;
  if (/^0\./.test(address)) return true; // 0.0.0.0/8
  if (address === "::") return true;
  return false;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET
  if (a === 198 && b === 18) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast 224+/reserved 240+
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith("::1")) return true; // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped addresses: ::ffff:a.b.c.d or the canonical ::ffff:xxxx:xxxx.
  // Recover the embedded IPv4 and re-run the IPv4 classifier so loopback and
  // private IPv4 cannot be smuggled through an IPv6 literal.
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (dotted) {
      const ipv4 = dotted.slice(1).join(".");
      return isPrivateV4(ipv4) || isLoopback(ipv4);
    }
    // Canonical form: two 16-bit groups, e.g. 7f00:1 -> 127.0.0.1.
    const groups = tail.split(":");
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
        return isPrivateV4(ipv4) || isLoopback(ipv4);
      }
    }
    return true; // any other IPv4-mapped form is non-routable; block it.
  }
  if (lower.startsWith("::") && lower.includes(".")) {
    return true; // IPv4-compatible embedded, non-standard — block.
  }
  if (lower.startsWith("2001:db8:")) return true; // documentation range
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix — block to be safe
  if (lower.startsWith("100:")) return true; // discard prefix 100::/64
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

async function resolveAddresses(hostname: string): Promise<{ ok: true; addresses: string[] } | { ok: false; code: string }> {
  // If it is already an IP literal, there is nothing to resolve (and no
  // rebinding vector from a fresh lookup, but the literal itself is checked).
  // URL.hostname keeps IPv6 brackets ("[::1]") which isIP does not parse, so
  // strip them first.
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const literalKind = isIP(literal);
  if (literalKind !== 0) {
    return { ok: true, addresses: [literal] };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, code: "endpoint_dns_unresolvable" };
  }
  if (!records || records.length === 0) {
    return { ok: false, code: "endpoint_dns_unresolvable" };
  }
  return { ok: true, addresses: records.map((r) => r.address) };
}

function classifyAddress(address: string): string | null {
  const kind = isIP(address);
  if (kind === 4) {
    if (isLoopback(address)) return "endpoint_loopback";
    if (isPrivateV4(address)) return "endpoint_private_address";
    return null;
  }
  if (kind === 6) {
    if (isPrivateV6(address)) return "endpoint_private_address";
    return null;
  }
  // Not an IP — treat as a hostname (should not happen post-resolve).
  return "endpoint_unresolvable";
}

// Validates and normalizes a user endpoint. Returns the normalized endpoint
// (origin + path, no fragment, no userinfo, non-secret query preserved) on
// success, or a safe error code on failure.
export async function validateEndpoint(raw: string): Promise<EndpointValidation> {
  if (typeof raw !== "string") return SAFE_ERROR("endpoint_invalid");
  const trimmed = raw.trim();
  if (!trimmed) return SAFE_ERROR("endpoint_invalid");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return SAFE_ERROR("endpoint_invalid");
  }

  // Only HTTPS. HTTP is rejected so the key is never sent in the clear.
  if (url.protocol !== "https:") return SAFE_ERROR("endpoint_requires_https");

  // Reject embedded credentials (userinfo) entirely.
  if (url.username || url.password) return SAFE_ERROR("endpoint_userinfo");

  // Reject fragments; they never reach the server and hide the real target.
  if (url.hash) return SAFE_ERROR("endpoint_fragment");

  // Reject any query parameter that could carry a secret. We keep non-secret
  // query params (per ADR-004) but block obvious credential-bearing keys.
  const secretQueryKeys = /(?:api[_-]?key|key|token|secret|auth|password|signature|sig)/i;
  for (const key of url.searchParams.keys()) {
    if (secretQueryKeys.test(key)) return SAFE_ERROR("endpoint_query_secret");
  }

  const hostname = url.hostname;
  if (!hostname) return SAFE_ERROR("endpoint_invalid");
  if (isBlockedHostname(hostname)) return SAFE_ERROR("endpoint_blocked_hostname");

  // Resolve every address and require all of them to be globally routable
  // unicast. This blocks loopback, private, link-local, multicast, reserved,
  // metadata, and IPv4-mapped IPv6 bypass (ADR-004 §2).
  const resolved = await resolveAddresses(hostname);
  if (!resolved.ok) return resolved;
  for (const address of resolved.addresses) {
    const blocked = classifyAddress(address);
    if (blocked) return SAFE_ERROR(blocked);
  }

  // Normalize: drop fragment and userinfo (already rejected), keep origin +
  // pathname + non-secret query. Remove default port for canonicalization.
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.username = "";
  normalized.password = "";
  if (normalized.port === "443") normalized.port = "";

  return { ok: true, normalized: normalized.toString(), hostname: normalized.hostname };
}

// Returns a redacted endpoint for display. It never reveals query values that
// could carry secrets — only origin + pathname, with query values masked.
export function maskEndpoint(normalizedEndpoint: string): string {
  try {
    const url = new URL(normalizedEndpoint);
    const masked = new URL(url.origin + url.pathname);
    for (const key of url.searchParams.keys()) {
      masked.searchParams.set(key, "REDACTED");
    }
    return masked.toString();
  } catch {
    return "";
  }
}
