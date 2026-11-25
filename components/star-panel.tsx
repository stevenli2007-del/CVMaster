"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowIcon, CloseIcon, UploadIcon } from "./icons";
import {
  MATERIAL_FILE_ACCEPT,
  MAX_FILES_PER_BATCH,
  validateFileMetadata,
} from "@/lib/material-constraints";
import {
  MATERIAL_META,
  type ExperienceStar,
  type ScreenOrigin,
} from "@/lib/star-map";
import styles from "./star-panel.module.css";

type StarPanelProps = {
  star: ExperienceStar;
  onRename: (name: string) => Promise<void>;
  onAddText: (value: string, origin: ScreenOrigin) => Promise<unknown>;
  onAddFile: (file: File, origin: ScreenOrigin) => Promise<unknown>;
  onDeleteMaterial: (id: string) => Promise<void>;
  onDeleteStar: () => Promise<void>;
  onClose: () => void;
};

type Attempt =
  | { kind: "text"; value: string; origin: ScreenOrigin }
  | { kind: "files"; files: File[]; origin: ScreenOrigin };

type PanelStatus = { message: string; error: boolean; retry: boolean };

export function StarPanel({
  star,
  onRename,
  onAddText,
  onAddFile,
  onDeleteMaterial,
  onDeleteStar,
  onClose,
}: StarPanelProps) {
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState(star.name);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmMaterialId, setConfirmMaterialId] = useState<string | null>(null);
  const [confirmStarDelete, setConfirmStarDelete] = useState(false);
  const [deletingStar, setDeletingStar] = useState(false);
  const [status, setStatus] = useState<PanelStatus>({
    message: "Saved privately. Links are stored as text and never fetched.",
    error: false,
    retry: false,
  });
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const lastAttempt = useRef<Attempt | null>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  function zoneOrigin(): ScreenOrigin {
    const rect = dropZoneRef.current?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth - 220, y: window.innerHeight / 2 };
  }

  async function saveText(value: string, origin: ScreenOrigin) {
    setSubmitting(true);
    setStatus({ message: "Saving to this star…", error: false, retry: false });
    try {
      await onAddText(value, origin);
      setDraft("");
      lastAttempt.current = null;
      setStatus({ message: "Added to this star and saved.", error: false, retry: false });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Could not save this material. Please retry.",
        error: true,
        retry: true,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function addText(value = draft, origin = zoneOrigin()) {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    lastAttempt.current = { kind: "text", value: trimmed, origin };
    void saveText(trimmed, origin);
  }

  async function saveFiles(files: File[], origin: ScreenOrigin) {
    setSubmitting(true);
    let completed = 0;
    for (let index = 0; index < files.length; index += 1) {
      setStatus({
        message: files.length > 1 ? `Uploading file ${index + 1} of ${files.length}…` : "Uploading to private storage…",
        error: false,
        retry: false,
      });
      try {
        await onAddFile(files[index], origin);
        completed += 1;
      } catch (error) {
        lastAttempt.current = { kind: "files", files: files.slice(index), origin };
        setStatus({
          message: `${completed > 0 ? `${completed} earlier ${completed === 1 ? "file" : "files"} saved. ` : ""}${error instanceof Error ? error.message : "Upload failed. Please retry."}`,
          error: true,
          retry: true,
        });
        setSubmitting(false);
        return;
      }
    }
    lastAttempt.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setStatus({
      message: `${completed} ${completed === 1 ? "file" : "files"} uploaded and saved privately.`,
      error: false,
      retry: false,
    });
    setSubmitting(false);
  }

  function addFiles(files: File[], origin: ScreenOrigin) {
    if (files.length === 0 || submitting) return;
    if (files.length > MAX_FILES_PER_BATCH) {
      setStatus({ message: `Choose up to ${MAX_FILES_PER_BATCH} files at a time.`, error: true, retry: false });
      return;
    }
    const invalid = files.map(validateFileMetadata).find(Boolean);
    if (invalid) {
      setStatus({ message: invalid, error: true, retry: false });
      return;
    }
    lastAttempt.current = { kind: "files", files, origin };
    void saveFiles(files, origin);
  }

  function retry() {
    const attempt = lastAttempt.current;
    if (!attempt || submitting) return;
    if (attempt.kind === "text") void saveText(attempt.value, attempt.origin);
    else void saveFiles(attempt.files, attempt.origin);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const origin = { x: event.clientX, y: event.clientY };
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      addFiles(files, origin);
      return;
    }
    const text = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain")).trim();
    if (text) addText(text, origin);
  }

  function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addText();
    }
  }

  async function saveName() {
    const value = nameDraft.trim();
    if (value === star.name || savingName) return;
    if (!value) {
      setNameDraft(star.name);
      setStatus({ message: "A star name cannot be empty.", error: true, retry: false });
      return;
    }
    setSavingName(true);
    try {
      await onRename(value);
      setNameDraft(value);
      setStatus({ message: "Star name saved.", error: false, retry: false });
    } catch (error) {
      setNameDraft(star.name);
      setStatus({ message: error instanceof Error ? error.message : "Could not rename this star.", error: true, retry: false });
    } finally {
      setSavingName(false);
    }
  }

  async function removeMaterial(id: string) {
    setDeletingId(id);
    setStatus({ message: "Deleting material and any associated file…", error: false, retry: false });
    try {
      await onDeleteMaterial(id);
      setConfirmMaterialId(null);
      setStatus({ message: "Material deleted.", error: false, retry: false });
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : "Could not delete this material. Please retry.", error: true, retry: false });
    } finally {
      setDeletingId(null);
    }
  }

  async function removeStar() {
    setDeletingStar(true);
    try {
      await onDeleteStar();
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : "Could not delete this star. Please retry.", error: true, retry: false });
      setDeletingStar(false);
      setConfirmStarDelete(false);
    }
  }

  return (
    <aside className={styles.panel} aria-label="Star details" aria-busy={submitting || deletingStar}>
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>EXPERIENCE STAR</p>
          <input
            ref={nameInputRef}
            className={styles.starName}
            value={nameDraft}
            maxLength={80}
            disabled={savingName || deletingStar}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") {
                event.stopPropagation();
                setNameDraft(star.name);
                event.currentTarget.blur();
              }
            }}
            aria-label="Star name"
          />
        </div>
        <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close star details">
          <CloseIcon width={19} height={19} />
        </button>
      </div>

      <div className={styles.storageNotice} role="note">
        <span className={styles.storageBadge}><i /> Saved to your private account</span>
        <p>Refresh anytime. Your stars and fragments stay here.</p>
      </div>

      <div className={styles.panelBody}>
        <div
          ref={dropZoneRef}
          className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className={styles.dropHeading}>
            <span className={styles.dropIcon}><UploadIcon width={20} height={20} /></span>
            <div>
              <h2>Drop notes, links, and files</h2>
              <p>Private by default · No AI or link fetching in CP2</p>
            </div>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onTextKeyDown}
            placeholder="Paste a link or type a note…"
            aria-label="Text note or link"
            rows={4}
            maxLength={20000}
            disabled={submitting || deletingStar}
          />
          <div className={styles.dropActions}>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              accept={MATERIAL_FILE_ACCEPT}
              tabIndex={-1}
              aria-label="Choose files to upload privately"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []), zoneOrigin());
              }}
            />
            <button type="button" className={styles.fileButton} disabled={submitting || deletingStar} onClick={() => fileInputRef.current?.click()}>
              Choose files
            </button>
            <span>Enter to save · Shift + Enter for a new line · Up to 5 files, 4 MB each</span>
            <button type="button" className={styles.addButton} onClick={() => addText()} disabled={!draft.trim() || submitting || deletingStar}>
              {submitting ? "Saving…" : "Save material"}<ArrowIcon width={15} height={15} />
            </button>
          </div>
          {dragging && <div className={styles.dragOverlay}>Drop to save privately</div>}
        </div>

        <div className={styles.statusRow}>
          <p className={`${styles.status} ${status.error ? styles.statusError : ""}`} role={status.error ? "alert" : "status"} aria-live="polite">{status.message}</p>
          {status.retry && <button className={styles.retryButton} type="button" disabled={submitting} onClick={retry}>Retry</button>}
        </div>

        <section className={styles.materialsSection} aria-labelledby="materials-heading">
          <div className={styles.materialsHeading}>
            <h3 id="materials-heading">Orbiting fragments</h3>
            <span>{star.materials.length.toString().padStart(2, "0")}</span>
          </div>
          {star.materials.length === 0 ? (
            <div className={styles.materialsEmpty}>
              <span className={styles.emptyOrbit} aria-hidden="true"><i /></span>
              <p>Your saved notes, links, and files will appear here and in orbit.</p>
            </div>
          ) : (
            <ul className={styles.materialList}>
              {star.materials.map((material) => {
                const meta = MATERIAL_META[material.kind];
                const isFile = Boolean(material.originalFilename);
                return (
                  <li key={material.id} className={styles.materialItem}>
                    <span
                      className={styles.materialGlyph}
                      style={{ "--material-color": meta.color } as React.CSSProperties}
                      aria-hidden="true"
                    >{meta.shortLabel}</span>
                    <div>
                      <div className={styles.materialMeta}>{meta.label}<span>{material.status === "ready" ? "Ready · saved" : material.status}</span></div>
                      <p>{material.label}</p>
                      <small>{material.detail}</small>
                      <div className={styles.materialActions}>
                        {isFile && material.status === "ready" && (
                          <a href={`/api/materials/${material.id}/download`} download>Download</a>
                        )}
                        {confirmMaterialId === material.id ? (
                          <>
                            <button type="button" className={styles.confirmDelete} disabled={deletingId === material.id} onClick={() => void removeMaterial(material.id)}>
                              {deletingId === material.id ? "Deleting…" : "Confirm delete"}
                            </button>
                            <button type="button" disabled={deletingId === material.id} onClick={() => setConfirmMaterialId(null)}>Cancel</button>
                          </>
                        ) : (
                          <button type="button" disabled={Boolean(deletingId)} onClick={() => setConfirmMaterialId(material.id)}>Delete</button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={styles.dangerZone} aria-label="Delete this star">
          {confirmStarDelete ? (
            <>
              <p>Delete this star, all materials, and private files?</p>
              <div>
                <button type="button" className={styles.confirmDelete} disabled={deletingStar} onClick={() => void removeStar()}>
                  {deletingStar ? "Deleting…" : "Delete permanently"}
                </button>
                <button type="button" disabled={deletingStar} onClick={() => setConfirmStarDelete(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmStarDelete(true)}>Delete this star</button>
          )}
        </section>
      </div>
      <p className={styles.panelFootnote}>Private Storage · Links are never fetched · PNG, JPG, WebP, GIF, PDF, TXT, MD, CSV, DOC, DOCX</p>
    </aside>
  );
}
