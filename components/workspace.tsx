"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createExperience,
  createTextMaterial,
  deleteExperience,
  deleteMaterial,
  renameExperience,
} from "@/app/actions";
import { AccountMenu } from "@/components/account-menu";
import { PlusIcon, ResetIcon, SparkIcon } from "@/components/icons";
import { StarPanel } from "@/components/star-panel";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import {
  getStarPosition,
  MATERIAL_META,
  type ExperienceStar,
  type ScreenOrigin,
  type StarMaterial,
} from "@/lib/star-map";
import type { MaterialDTO, WorkspaceDTO } from "@/lib/types";
import styles from "@/app/page.module.css";

const StarMap = dynamic(() => import("@/components/star-map"), {
  ssr: false,
  loading: () => <div className={styles.scenePlaceholder} aria-hidden="true" />,
});

function formatBytes(value: number | null) {
  if (!value) return "0 KB";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

function toStarMaterial(material: MaterialDTO, origin: ScreenOrigin = { x: 0, y: 0 }, animate = false): StarMaterial {
  const label = material.textContent || material.sourceUrl || material.originalFilename || "Saved material";
  const detail = material.originalFilename
    ? `${material.mimeType || "File"} · ${formatBytes(material.sizeBytes)}`
    : material.sourceUrl
      ? "Saved URL only — never fetched"
      : "Saved text in your private account";
  return {
    id: material.id,
    kind: material.type,
    label: label.length > 240 ? `${label.slice(0, 240)}…` : label,
    detail,
    status: material.processingStatus,
    sourceUrl: material.sourceUrl,
    textContent: material.textContent,
    originalFilename: material.originalFilename,
    mimeType: material.mimeType,
    sizeBytes: material.sizeBytes,
    createdAt: animate ? performance.now() : -10000,
    origin,
  };
}

export function Workspace({ initialWorkspace }: { initialWorkspace: WorkspaceDTO }) {
  const [profile, setProfile] = useState(initialWorkspace.profile);
  const [stars, setStars] = useState<ExperienceStar[]>(() => initialWorkspace.experiences.map((experience, index) => ({
    id: experience.id,
    name: experience.name,
    position: getStarPosition(index),
    hue: (index * 67 + 228) % 360,
    createdAt: -10000,
    materials: experience.materials.map((material) => toStarMaterial(material)),
  })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [creating, setCreating] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const newStarButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const selectedStar = stars.find((star) => star.id === selectedId) ?? null;

  const closePanel = useCallback(() => {
    setSelectedId(null);
    setAnnouncement("Panel closed. Your stars and fragments remain saved.");
    window.requestAnimationFrame(() => newStarButtonRef.current?.focus());
  }, []);

  function resetView() {
    if (selectedId) closePanel();
    setResetKey((key) => key + 1);
    setAnnouncement("View reset to overview.");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedId) {
        event.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePanel, selectedId]);

  async function makeNewStar() {
    setCreating(true);
    setWorkspaceError("");
    try {
      const result = await createExperience();
      if (!result.ok) throw new Error(result.error);
      const star: ExperienceStar = {
        id: result.data.id,
        name: result.data.name,
        position: getStarPosition(stars.length),
        hue: (stars.length * 67 + 228) % 360,
        createdAt: performance.now(),
        materials: [],
      };
      setStars((current) => [...current, star]);
      setSelectedId(star.id);
      setAnnouncement("New star created and saved. Give it a name and add materials.");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not create this star. Please retry.");
    } finally {
      setCreating(false);
    }
  }

  function selectStar(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setAnnouncement("Star opened. Your saved fragments are in orbit.");
  }

  async function renameStar(name: string) {
    if (!selectedId) return;
    const result = await renameExperience(selectedId, name);
    if (!result.ok) throw new Error(result.error);
    setStars((current) => current.map((star) => star.id === selectedId ? { ...star, name: result.data.name } : star));
  }

  async function addText(value: string, origin: ScreenOrigin) {
    if (!selectedId) throw new Error("Open a star before adding text.");
    const result = await createTextMaterial(selectedId, value);
    if (!result.ok) throw new Error(result.error);
    const material = toStarMaterial(result.data, origin, true);
    setStars((current) => current.map((star) => star.id === selectedId
      ? { ...star, materials: [...star.materials, material] }
      : star));
    setAnnouncement("Material saved to this star.");
    return material;
  }

  async function addFile(file: File, origin: ScreenOrigin) {
    if (!selectedId) throw new Error("Open a star before uploading a file.");
    const body = new FormData();
    body.set("experienceId", selectedId);
    body.set("file", file);
    const response = await fetch("/api/materials/upload", { method: "POST", body });
    const payload = await response.json().catch(() => null) as { material?: MaterialDTO; error?: string } | null;
    if (!response.ok || !payload?.material) {
      throw new Error(payload?.error || "Upload failed. Please retry.");
    }
    const material = toStarMaterial(payload.material, origin, true);
    setStars((current) => current.map((star) => star.id === selectedId
      ? { ...star, materials: [...star.materials, material] }
      : star));
    setAnnouncement("File uploaded to private storage and saved to this star.");
    return material;
  }

  async function removeMaterial(id: string) {
    const result = await deleteMaterial(id);
    if (!result.ok) throw new Error(result.error);
    setStars((current) => current.map((star) => ({
      ...star,
      materials: star.materials.filter((material) => material.id !== id),
    })));
    setAnnouncement("Material and any associated private file were deleted.");
  }

  async function removeStar() {
    if (!selectedId) return;
    const result = await deleteExperience(selectedId);
    if (!result.ok) throw new Error(result.error);
    setStars((current) => current.filter((star) => star.id !== selectedId));
    setSelectedId(null);
    setAnnouncement("Star, materials, and associated private files were deleted.");
    window.requestAnimationFrame(() => newStarButtonRef.current?.focus());
  }

  return (
    <main className={styles.universe}>
      <div className={styles.nebula} aria-hidden="true" />
      <StarMap
        stars={stars}
        selectedId={selectedId}
        resetKey={resetKey}
        reducedMotion={reducedMotion}
        onSelect={selectStar}
        onClose={closePanel}
      />

      <header className={styles.header}>
        <div className={styles.brand} aria-label="CVMaster, experience universe">
          <span className={styles.brandMark}><SparkIcon width={17} height={17} /></span>
          <strong>CVMaster</strong>
          <span className={styles.brandDivider} />
          <span>Experience universe</span>
        </div>
        <div className={styles.headerActions}>
          {reducedMotion && <span className={styles.motionBadge}>Reduced motion</span>}
          <button className={styles.resetButton} type="button" onClick={resetView}>
            <ResetIcon width={15} height={15} />Reset view
          </button>
          <AccountMenu profile={profile} onProfile={setProfile} />
        </div>
      </header>

      {workspaceError && (
        <div className={styles.workspaceError} role="alert">
          <span>{workspaceError}</span>
          <button type="button" onClick={() => setWorkspaceError("")}>Dismiss</button>
        </div>
      )}

      <section
        className={`${styles.emptyState} ${stars.length > 0 ? styles.emptyStateHidden : ""}`}
        aria-hidden={stars.length > 0}
      >
        <p className={styles.eyebrow}>YOUR EXPERIENCE, IN ORBIT</p>
        <h1>What happened?</h1>
        <p>Make a star for it, then drop anything inside.</p>
      </section>

      <div className={styles.legend} aria-label="Star map legend">
        <span className={styles.legendTitle}>MAP KEY</span>
        <div className={styles.legendItems}>
          <span><i className={styles.legendPlanet} /> Experience</span>
          {(Object.keys(MATERIAL_META) as Array<keyof typeof MATERIAL_META>).map((kind) => (
            <span key={kind}>
              <i className={styles.legendFragment} style={{ "--fragment-color": MATERIAL_META[kind].color } as React.CSSProperties} />
              {MATERIAL_META[kind].label}
            </span>
          ))}
        </div>
      </div>

      <div className={`${styles.creationDock} ${selectedStar ? styles.creationDockHidden : ""}`}>
        <button
          ref={newStarButtonRef}
          className={styles.newStarButton}
          type="button"
          onClick={() => void makeNewStar()}
          disabled={creating}
          tabIndex={selectedStar ? -1 : 0}
        >
          <PlusIcon width={19} height={19} />{creating ? "Creating star…" : "Make a new star"}
        </button>
        <p>Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Click a star to focus</p>
      </div>

      {selectedStar && (
        <StarPanel
          key={selectedStar.id}
          star={selectedStar}
          onRename={renameStar}
          onAddText={addText}
          onAddFile={addFile}
          onDeleteMaterial={removeMaterial}
          onDeleteStar={removeStar}
          onClose={closePanel}
        />
      )}

      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </main>
  );
}
