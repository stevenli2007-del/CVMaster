import type { Database } from "@/lib/database.types";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import type { MaterialDTO, WorkspaceDTO } from "@/lib/types";

type MaterialRow = Database["public"]["Tables"]["materials"]["Row"];

export function toMaterialDTO(row: MaterialRow): MaterialDTO {
  return {
    id: row.id,
    experienceId: row.experience_id,
    type: row.type,
    sourceUrl: row.source_url,
    textContent: row.text_content,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    processingStatus: row.processing_status,
    createdAt: row.created_at,
  };
}

export async function getWorkspaceData(): Promise<WorkspaceDTO | null> {
  const context = await getAuthenticatedContext();
  if (!context) return null;

  const [profileResult, experiencesResult, materialsResult] = await Promise.all([
    context.supabase.from("profiles").select("*").eq("id", context.userId).single(),
    context.supabase.from("experiences").select("*").eq("user_id", context.userId).order("created_at", { ascending: true }),
    context.supabase.from("materials").select("*").eq("user_id", context.userId).order("created_at", { ascending: true }),
  ]);

  if (profileResult.error || experiencesResult.error || materialsResult.error) {
    throw new Error("Workspace data could not be loaded");
  }

  const materialsByExperience = new Map<string, MaterialDTO[]>();
  materialsResult.data.forEach((row) => {
    const materials = materialsByExperience.get(row.experience_id) || [];
    materials.push(toMaterialDTO(row));
    materialsByExperience.set(row.experience_id, materials);
  });

  return {
    profile: {
      id: profileResult.data.id,
      displayName: profileResult.data.display_name,
      email: context.email,
    },
    experiences: experiencesResult.data.map((experience) => ({
      id: experience.id,
      name: experience.name,
      createdAt: experience.created_at,
      updatedAt: experience.updated_at,
      materials: materialsByExperience.get(experience.id) || [],
    })),
  };
}
