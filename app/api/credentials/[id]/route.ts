import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import {
  deleteCredential,
  endpointErrorMessage,
  replaceCredential,
  type CredentialError,
} from "@/lib/byok/credentials";
import { credentialReplaceInputSchema } from "@/lib/byok/validation";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

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

// Replace an existing credential's key and configuration.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const context = await getAuthenticatedContext();
  if (!context) return toErrorResponse({ kind: "unauthenticated" });
  if (!uuidSchema.safeParse(id).success) return toErrorResponse({ kind: "not_found" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return toErrorResponse({ kind: "invalid_input", message: "Invalid request." });
  }

  const parsed = credentialReplaceInputSchema.safeParse(body);
  if (!parsed.success) {
    return toErrorResponse({ kind: "invalid_input", message: "Enter a provider and protocol. Leave the key blank to keep the existing key, and the endpoint blank to keep the existing endpoint." });
  }

  const admin = createAdminClient();
  if (!admin) return toErrorResponse({ kind: "crypto_unavailable", message: "" });

  const result = await replaceCredential(admin, context.userId, id, parsed.data);
  if (!result.ok) return toErrorResponse(result.error);

  return NextResponse.json({ credential: result.data }, { headers: { "Cache-Control": "no-store" } });
}

// Mark a credential deleting (blocks new runs; does not revoke provider-side).
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const context = await getAuthenticatedContext();
  if (!context) return toErrorResponse({ kind: "unauthenticated" });
  if (!uuidSchema.safeParse(id).success) return toErrorResponse({ kind: "not_found" });

  const admin = createAdminClient();
  if (!admin) return toErrorResponse({ kind: "crypto_unavailable", message: "" });

  const result = await deleteCredential(admin, context.userId, id);
  if (!result.ok) return toErrorResponse(result.error);

  return NextResponse.json({ credential: result.data }, { headers: { "Cache-Control": "no-store" } });
}
