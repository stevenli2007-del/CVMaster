import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const context = await getAuthenticatedContext();
  if (!context) return new Response("Sign in required", { status: 401 });
  if (!uuidSchema.safeParse(id).success) return new Response("Not found", { status: 404 });

  const { data: material, error } = await context.supabase
    .from("materials")
    .select("object_key, original_filename, mime_type, size_bytes")
    .eq("id", id)
    .eq("user_id", context.userId)
    .not("object_key", "is", null)
    .maybeSingle();
  if (error || !material?.object_key) return new Response("Not found", { status: 404 });

  const { data: file, error: downloadError } = await context.supabase.storage
    .from("materials")
    .download(material.object_key);
  if (downloadError || !file) return new Response("File unavailable", { status: 404 });

  const originalName = material.original_filename || "download";
  const fallbackName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";
  return new Response(file, {
    headers: {
      "Content-Type": material.mime_type || "application/octet-stream",
      "Content-Length": String(material.size_bytes || file.size),
      "Content-Disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
