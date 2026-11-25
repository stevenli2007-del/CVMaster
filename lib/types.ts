export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type ProfileDTO = {
  id: string;
  displayName: string;
  email: string;
};

export type ExperienceDTO = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type MaterialDTO = {
  id: string;
  experienceId: string;
  type: "web" | "github" | "note" | "voice" | "image" | "file";
  sourceUrl: string | null;
  textContent: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  processingStatus: "queued" | "processing" | "ready" | "failed";
  createdAt: string;
};

export type WorkspaceExperienceDTO = ExperienceDTO & {
  materials: MaterialDTO[];
};

export type WorkspaceDTO = {
  profile: ProfileDTO;
  experiences: WorkspaceExperienceDTO[];
};
