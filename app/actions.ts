"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import type { Database } from "@/lib/database.types";
import type { ActionResult, ExperienceDTO, MaterialDTO, ProfileDTO } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { displayNameSchema, experienceNameSchema, linkSchema, noteSchema, uuidSchema } from "@/lib/validation";
import { toMaterialDTO } from "@/lib/workspace-data";
import { snapshotMaterialRevision } from "@/lib/revisions";

function failure(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

// Deletes a just-created material row (service role) when a post-insert step
// fails, so a failed create never leaves an orphaned material without a
// revision. Used only for note/link materials (no private storage object).
// Returns true only when the delete succeeded (or the row is already gone),
// so the caller can distinguish a clean rollback from a leftover row.
async function rollbackMaterial(
  admin: SupabaseClient<Database>,
  userId: string,
  materialId: string,
): Promise<boolean> {
  const { error } = await admin.from("materials").delete().eq("id", materialId).eq("user_id", userId);
  return !error;
}

export async function updateProfile(displayName: string): Promise<ActionResult<ProfileDTO>> {
  const parsed = displayNameSchema.safeParse(displayName);
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!parsed.success) return failure("Use a display name of 80 characters or fewer.");

  const { data, error } = await context.supabase
    .from("profiles")
    .update({ display_name: parsed.data })
    .eq("id", context.userId)
    .select("id, display_name")
    .single();
  if (error) return failure("Could not save your profile. Please try again.");
  revalidatePath("/");
  return { ok: true, data: { id: data.id, displayName: data.display_name, email: context.email } };
}

export async function createExperience(name = "Untitled star"): Promise<ActionResult<ExperienceDTO>> {
  const parsed = experienceNameSchema.safeParse(name);
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!parsed.success) return failure("Use a star name of 1–80 characters.");

  const { data, error } = await context.supabase
    .from("experiences")
    .insert({ user_id: context.userId, name: parsed.data })
    .select("id, name, created_at, updated_at")
    .single();
  if (error) return failure("Could not create this star. Please try again.");
  revalidatePath("/");
  return {
    ok: true,
    data: { id: data.id, name: data.name, createdAt: data.created_at, updatedAt: data.updated_at },
  };
}

export async function renameExperience(id: string, name: string): Promise<ActionResult<ExperienceDTO>> {
  const validId = uuidSchema.safeParse(id);
  const parsed = experienceNameSchema.safeParse(name);
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!validId.success || !parsed.success) return failure("Use a star name of 1–80 characters.");

  const { data, error } = await context.supabase
    .from("experiences")
    .update({ name: parsed.data })
    .eq("id", id)
    .eq("user_id", context.userId)
    .select("id, name, created_at, updated_at")
    .maybeSingle();
  if (error) return failure("Could not rename this star. Please try again.");
  if (!data) return failure("This star is unavailable or no longer exists.");
  revalidatePath("/");
  return {
    ok: true,
    data: { id: data.id, name: data.name, createdAt: data.created_at, updatedAt: data.updated_at },
  };
}

export async function deleteExperience(id: string): Promise<ActionResult> {
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!uuidSchema.safeParse(id).success) return failure("This star is unavailable.");
  const admin = createAdminClient();
  if (!admin) return failure("Deletion is temporarily unavailable. Please try again later.");

  const { data: files, error: filesError } = await context.supabase
    .from("materials")
    .select("object_key")
    .eq("experience_id", id)
    .eq("user_id", context.userId)
    .not("object_key", "is", null);
  if (filesError) return failure("Could not prepare this star for deletion. Please try again.");

  const objectKeys = files.flatMap((file) => file.object_key ? [file.object_key] : []);
  if (objectKeys.length > 0) {
    const { error } = await admin.storage.from("materials").remove(objectKeys);
    if (error) return failure("Could not confirm private file cleanup. The star was not deleted; retry to finish cleanup.");
  }

  const { data, error } = await admin
    .from("experiences")
    .delete()
    .eq("id", id)
    .eq("user_id", context.userId)
    .select("id")
    .maybeSingle();
  if (error) return failure("Files were removed, but the star record could not be deleted. Retry to finish cleanup.");
  if (!data) return failure("This star is unavailable or no longer exists.");
  revalidatePath("/");
  return { ok: true, data: undefined };
}

export async function createTextMaterial(experienceId: string, value: string): Promise<ActionResult<MaterialDTO>> {
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!uuidSchema.safeParse(experienceId).success) return failure("This star is unavailable.");

  const trimmed = value.trim();
  const looksLikeLink = /^https?:\/\//i.test(trimmed);
  const link = looksLikeLink ? linkSchema.safeParse(trimmed) : null;
  const note = noteSchema.safeParse(trimmed);
  if (looksLikeLink && !link?.success) return failure("Enter a valid http(s) URL without embedded credentials.");
  if (!looksLikeLink && !note.success) return failure("Use a note of 1–20,000 characters.");

  const isLink = link?.success === true;
  const hostname = isLink ? new URL(link.data).hostname.toLowerCase() : "";
  const type = isLink ? (hostname === "github.com" || hostname === "www.github.com" ? "github" : "web") : "note";

  // The revision snapshot runs on the service role. Fail before inserting if the
  // admin client is unavailable, so we never leave a material without a
  // revision/job that the authenticated client (no DELETE grant) cannot clean.
  const admin = createAdminClient();
  if (!admin) return failure("This material could not be prepared. Please try again later.");

  // Only the note/link source-capture allowlist columns are written here.
  // processing_status falls back to its DB default ('ready'); object_key, file
  // metadata, content_hash, and current_revision_id are server-managed and are
  // not writable by the authenticated client.
  const { data, error } = await context.supabase
    .from("materials")
    .insert({
      user_id: context.userId,
      experience_id: experienceId,
      type,
      source_url: isLink ? link.data : null,
      text_content: isLink ? null : note.data,
    })
    .select("*")
    .single();
  if (error) return failure("Could not save this material. Check that the star still exists and retry.");

  // Immutable revision snapshot + first parse/fetch job enqueue. A failed
  // snapshot would leave a material with no revision or processing job, so it
  // is treated as a failed create and the just-inserted row is rolled back.
  // When the rollback delete fails, we surface that the row may remain rather
  // than pretend the create failed cleanly.
  const snapshot = await snapshotMaterialRevision(admin, data);
  if (snapshot.ok === false && "error" in snapshot && snapshot.error === "store_failure") {
    const rolledBack = await rollbackMaterial(admin, context.userId, data.id);
    if (!rolledBack) {
      return failure(
        "This material was saved, but its processing could not be prepared and cleanup failed. Please delete it and try again.",
      );
    }
    return failure("This material could not be fully prepared. Please try again.");
  }

  revalidatePath("/");
  return { ok: true, data: toMaterialDTO(data) };
}

export async function deleteMaterial(id: string): Promise<ActionResult> {
  const context = await getAuthenticatedContext();
  if (!context) return failure("Your session has expired. Sign in again.");
  if (!uuidSchema.safeParse(id).success) return failure("This material is unavailable.");
  const admin = createAdminClient();
  if (!admin) return failure("Deletion is temporarily unavailable. Please try again later.");

  const { data: material, error: readError } = await context.supabase
    .from("materials")
    .select("id, object_key")
    .eq("id", id)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (readError) return failure("Could not prepare this material for deletion. Please retry.");
  if (!material) return failure("This material is unavailable or no longer exists.");

  if (material.object_key) {
    const { error } = await admin.storage.from("materials").remove([material.object_key]);
    if (error) return failure("Could not confirm private file cleanup. The material record was kept; retry to finish cleanup.");
  }

  const { error } = await admin
    .from("materials")
    .delete()
    .eq("id", id)
    .eq("user_id", context.userId);
  if (error) return failure("The file was removed, but its record could not be deleted. Retry to finish cleanup.");
  revalidatePath("/");
  return { ok: true, data: undefined };
}
