import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import {
  endpointErrorMessage,
  listCredentials,
  saveCredential,
  type CredentialError,
} from "@/lib/byok/credentials";
import { credentialInputSchema } from "@/lib/byok/validation";

export const runtime = "nodejs";

// BYOK credential routes. The request body contains the plaintext API key only
// transiently; it is never logged, echoed, or persisted in plaintext. These
// routes intentionally do not log request bodies.

function toErrorResponse(error: CredentialError): NextResponse {
  switch (error.kind) {
    case "unauthenticated":
      return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
    case "invalid_input":
      return NextResponse.json({ error: error.message }, { status: 400 });
    case "endpoint":
      return NextResponse.json({ error: endpointErrorMessage(error.code) }, { status: 400 });
    case "not_found":
      return NextResponse.json({ error: "This credential is unavailable or no longer exists." }, { status: 404 });
    case "concurrent_update":
      return NextResponse.json({ error: "This credential was updated by another request. Please review and try again." }, { status: 409 });
    case "crypto_unavailable":
      return NextResponse.json({ error: "Credential encryption is temporarily unavailable. Please try again later." }, { status: 503 });
    case "store_failure":
      return NextResponse.json({ error: "Could not save your credential. Please try again." }, { status: 502 });
  }
}

// List credentials (metadata only).
export async function GET() {
  const context = await getAuthenticatedContext();
  if (!context) return toErrorResponse({ kind: "unauthenticated" });

  const admin = createAdminClient();
  if (!admin) return toErrorResponse({ kind: "crypto_unavailable", message: "" });

  const result = await listCredentials(admin, context.userId);
  if (!result.ok) return toErrorResponse(result.error);

  return NextResponse.json({ credentials: result.data }, { headers: { "Cache-Control": "no-store" } });
}

// Save a new credential.
export async function POST(request: Request) {
  const context = await getAuthenticatedContext();
  if (!context) return toErrorResponse({ kind: "unauthenticated" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return toErrorResponse({ kind: "invalid_input", message: "Invalid request." });
  }

  const parsed = credentialInputSchema.safeParse(body);
  if (!parsed.success) {
    return toErrorResponse({ kind: "invalid_input", message: "Enter a provider, endpoint, protocol, and API key." });
  }

  const admin = createAdminClient();
  if (!admin) return toErrorResponse({ kind: "crypto_unavailable", message: "" });

  const result = await saveCredential(admin, context.userId, parsed.data);
  if (!result.ok) return toErrorResponse(result.error);

  return NextResponse.json({ credential: result.data }, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
}
