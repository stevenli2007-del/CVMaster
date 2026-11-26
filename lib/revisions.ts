import { createHash } from "node:crypto";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

// Server-only material revision snapshot (CP3 schema/RLS design §5, ADR-003).
// This module only runs in the server runtime: it computes the immutable source
// hash for a just-created material and calls the create_material_revision RPC
// (SECURITY DEFINER) which atomically writes the revision, the current_revision_id
// pointer, and the queued processing job. No queue, worker, or provider call
// happens here.

type AdminClient = SupabaseClient<Database>;

type MaterialSnapshot = {
  id: string;
  user_id: string;
  type: string;
  source_url: string | null;
  object_key: string | null;
  text_content: string | null;
  mime_type: string | null;
  size_bytes: number | null;
};

export type RevisionSnapshotResult =
  | { ok: true; revisionId: string; revisionNo: number; jobId: string | null; created: boolean }
  | { ok: false; skipped: true }
  | { ok: false; error: "not_found" | "store_failure" };

// SHA-256 hex (64 chars), matching the content_hash CHECK constraint and the
// deterministic evidence hash used downstream.
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Immutable source hash per material type (design §5 step 2). Notes hash the
// text; web/GitHub hash the source URL only (fetch is a worker concern); files
// hash the private object key + size + mime. The hash is what binds evidence to
// this exact source version, never a mutable material field.
function contentHashFor(material: MaterialSnapshot): string | null {
  switch (material.type) {
    case "note":
      if (!material.text_content) return null;
      return sha256Hex(material.text_content);
    case "web":
    case "github":
      if (!material.source_url) return null;
      return sha256Hex(material.source_url);
    case "file":
    case "image":
      if (!material.object_key) return null;
      return sha256Hex(
        `${material.object_key}:${material.size_bytes ?? ""}:${material.mime_type ?? ""}`,
      );
    default:
      // voice and any future type are outside the first parsing matrix (ADR-003).
      return null;
  }
}

// Job kind for the first parsing matrix (ADR-003 §job classification).
function jobKindFor(type: string): string | null {
  switch (type) {
    case "note":
      return "normalize_note";
    case "web":
    case "github":
      return "fetch_web";
    case "file":
    case "image":
      return "parse_file";
    default:
      return null;
  }
}

// Snapshots a just-created material into an immutable revision and queues its
// first processing job. Idempotent: if the material already has a revision
// (the RPC reuses the current pointer), this returns created=false instead of
// fabricating a duplicate. Types outside the parsing matrix (voice) are skipped.
export async function snapshotMaterialRevision(
  admin: AdminClient,
  material: MaterialSnapshot,
): Promise<RevisionSnapshotResult> {
  const contentHash = contentHashFor(material);
  const kind = jobKindFor(material.type);
  if (!contentHash || !kind) return { ok: false, skipped: true };

  const { data, error } = await admin.rpc("create_material_revision", {
    p_user_id: material.user_id,
    p_material_id: material.id,
    p_content_hash: contentHash,
    p_kind: kind,
  });

  if (error) {
    // A missing material (deleted between create and snapshot) is benign here:
    // the snapshot is best-effort and the revision will be re-created on retry.
    return { ok: false, error: "store_failure" };
  }

  const row = data?.[0];
  if (!row) return { ok: false, error: "not_found" };

  return {
    ok: true,
    revisionId: row.revision_id,
    revisionNo: row.revision_no,
    jobId: row.job_id ?? null,
    created: row.created === true,
  };
}
