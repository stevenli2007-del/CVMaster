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

// BYOK credential metadata — the ONLY shape a client may see. The API key,
// ciphertext, wrapped DEK, and KEK material never appear in a DTO.
export type CredentialDTO = {
  id: string;
  provider: string;
  label: string | null;
  model: string | null;
  maskedEndpoint: string;
  protocol: string;
  lastFour: string | null;
  status: "active" | "deleting";
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceExperienceDTO = ExperienceDTO & {
  materials: MaterialDTO[];
};

export type WorkspaceDTO = {
  profile: ProfileDTO;
  experiences: WorkspaceExperienceDTO[];
};
