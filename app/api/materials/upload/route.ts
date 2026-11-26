import { NextResponse } from "next/server";
import { MAX_FILE_SIZE, resolveFileMime, validateFileMetadata } from "@/lib/material-constraints";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { uuidSchema } from "@/lib/validation";
import { toMaterialDTO } from "@/lib/workspace-data";
import { snapshotMaterialRevision } from "@/lib/revisions";

export const runtime = "nodejs";

// Multipart framing, the experience UUID and a bounded filename/header budget.
// The actual file is still validated independently after parsing.
const MAX_MULTIPART_BODY_SIZE = MAX_FILE_SIZE + 64 * 1024;

export async function POST(request: Request) {
  const context = await getAuthenticatedContext();
  if (!context) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return NextResponse.json({ error: "Invalid upload size. Please try again." }, { status: 400 });
    }
    if (contentLength > MAX_MULTIPART_BODY_SIZE) {
      return NextResponse.json({ error: "The upload is larger than 4 MB. Choose a smaller file." }, { status: 413 });
    }
  }
  if (!request.body) {
    return NextResponse.json({ error: "Choose a star and one file to upload." }, { status: 400 });
  }

  let receivedBytes = 0;
  const limitedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_MULTIPART_BODY_SIZE) {
        controller.error(new Error("Multipart upload exceeded the request limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const limitedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: limitedBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  let formData: FormData;
  try {
    formData = await limitedRequest.formData();
  } catch {
    if (receivedBytes > MAX_MULTIPART_BODY_SIZE) {
      return NextResponse.json({ error: "The upload is larger than 4 MB. Choose a smaller file." }, { status: 413 });
    }
    return NextResponse.json({ error: "Could not read this upload. Please try again." }, { status: 400 });
  }

  const experienceId = formData.get("experienceId");
  const file = formData.get("file");
  if (typeof experienceId !== "string" || !uuidSchema.safeParse(experienceId).success || !(file instanceof File)) {
    return NextResponse.json({ error: "Choose a star and one file to upload." }, { status: 400 });
  }

  const validationError = validateFileMetadata(file);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  const mimeType = resolveFileMime(file.name, file.type);
  if (!mimeType) return NextResponse.json({ error: "This file type is not supported." }, { status: 400 });

  const { data: experience, error: experienceError } = await context.supabase
    .from("experiences")
    .select("id")
    .eq("id", experienceId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (experienceError || !experience) {
    return NextResponse.json({ error: "This star is unavailable or no longer exists." }, { status: 404 });
  }

  // Server-managed registration. The material row carries object_key and file
  // metadata, which are server-managed columns not writable by the authenticated
  // client (CP3 materials column permissions). Register through the service role
  // after verifying the caller's session and experience ownership above.
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Upload is temporarily unavailable. Please try again later." }, { status: 503 });
  }

  const materialId = crypto.randomUUID();
  const objectKey = `${context.userId}/${experienceId}/${materialId}`;
  const { error: uploadError } = await context.supabase.storage
    .from("materials")
    .upload(objectKey, file, { contentType: mimeType, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: "Upload failed. Your file was not saved; please retry." }, { status: 502 });
  }

  const { data, error: insertError } = await admin
    .from("materials")
    .insert({
      id: materialId,
      user_id: context.userId,
      experience_id: experienceId,
      type: mimeType.startsWith("image/") ? "image" : "file",
      object_key: objectKey,
      original_filename: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      processing_status: "ready",
    })
    .select("*")
    .single();

  if (insertError) {
    const cleanupError = (await admin.storage.from("materials").remove([objectKey])).error;
    if (cleanupError) {
      return NextResponse.json({
        error: "Upload failed, and cleanup could not be confirmed. An unused private file may remain.",
      }, { status: 502 });
    }
    return NextResponse.json({ error: "The file could not be registered. Upload was rolled back; please retry." }, { status: 502 });
  }

  // Best-effort immutable revision snapshot + first parse job enqueue. The
  // material is already saved; a snapshot failure does not fail the upload.
  await snapshotMaterialRevision(admin, data);

  return NextResponse.json({ material: toMaterialDTO(data) }, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
}
