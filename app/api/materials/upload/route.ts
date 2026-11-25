import { NextResponse } from "next/server";
import { resolveFileMime, validateFileMetadata } from "@/lib/material-constraints";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { uuidSchema } from "@/lib/validation";
import { toMaterialDTO } from "@/lib/workspace-data";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = await getAuthenticatedContext();
  if (!context) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
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

  const materialId = crypto.randomUUID();
  const objectKey = `${context.userId}/${experienceId}/${materialId}`;
  const { error: uploadError } = await context.supabase.storage
    .from("materials")
    .upload(objectKey, file, { contentType: mimeType, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: "Upload failed. Your file was not saved; please retry." }, { status: 502 });
  }

  const { data, error: insertError } = await context.supabase
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
    await context.supabase.storage.from("materials").remove([objectKey]);
    return NextResponse.json({ error: "The file could not be registered. Upload was rolled back; please retry." }, { status: 502 });
  }

  return NextResponse.json({ material: toMaterialDTO(data) }, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
}
