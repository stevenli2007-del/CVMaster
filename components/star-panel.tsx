"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowIcon, CloseIcon, UploadIcon } from "./icons";
import {
  classifyText,
  createId,
  kindForFile,
  MATERIAL_META,
  type ExperienceStar,
  type PreviewMaterial,
  type ScreenOrigin,
} from "@/lib/star-map";
import styles from "./star-panel.module.css";

type StarPanelProps = {
  star: ExperienceStar;
  onRename: (name: string) => void;
  onAdd: (materials: PreviewMaterial[]) => void;
  onClose: () => void;
};

export function StarPanel({ star, onRename, onAdd, onClose }: StarPanelProps) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("No AI is running. Nothing leaves this browser tab.");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [star.id]);

  function zoneOrigin(): ScreenOrigin {
    const rect = dropZoneRef.current?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth - 220, y: window.innerHeight / 2 };
  }

  function addText() {
    const value = draft.trim();
    if (!value) return;
    const kind = classifyText(value);
    onAdd([{
      id: createId(),
      kind,
      label: value.length > 240 ? `${value.slice(0, 240)}…` : value,
      detail: kind === "note" ? "Temporary text preview" : "URL text only — never fetched",
      createdAt: performance.now(),
      origin: zoneOrigin(),
    }]);
    setDraft("");
    setStatus("Preview fragment added in memory. Nothing was analyzed, uploaded, or saved.");
  }

  function addFiles(files: File[], origin: ScreenOrigin) {
    if (files.length === 0) return;
    const materials = files.map((file) => ({
      id: createId(),
      kind: kindForFile(file.type),
      label: file.name,
      detail: file.type || "MIME type not provided",
      createdAt: performance.now(),
      origin,
    }));
    onAdd(materials);
    setStatus(`${files.length} file ${files.length === 1 ? "name" : "names"} added as preview metadata. File contents were not read.`);
    setDraft("");
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
    if (text) {
      setDraft("");
      const kind = classifyText(text);
      onAdd([{
        id: createId(),
        kind,
        label: text,
        detail: kind === "note" ? "Temporary text preview" : "URL text only — never fetched",
        createdAt: performance.now(),
        origin,
      }]);
      setStatus("Dropped text is a memory-only preview. No URL was fetched.");
    }
  }

  function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addText();
    }
  }

  return (
    <aside className={styles.panel} aria-label="Star details">
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>EXPERIENCE STAR</p>
          <input
            ref={nameInputRef}
            className={styles.starName}
            value={star.name}
            maxLength={80}
            onChange={(event) => onRename(event.target.value)}
            aria-label="Star name"
          />
        </div>
        <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close star details">
          <CloseIcon width={19} height={19} />
        </button>
      </div>

      <div className={styles.previewNotice} role="note">
        <span className={styles.previewBadge}><i /> Preview only — not saved</span>
        <p>Closing this panel clears its fragments. Star names last only until refresh.</p>
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
              <h2>Drop anything, AI sorts it</h2>
              <p>Interaction demo only — no AI, upload, or link fetching.</p>
            </div>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onTextKeyDown}
            placeholder="Paste a link or type a temporary note…"
            aria-label="Temporary text or link preview"
            rows={4}
          />
          <div className={styles.dropActions}>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              tabIndex={-1}
              aria-label="Choose files for filename-only preview"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []), zoneOrigin());
                event.target.value = "";
              }}
            />
            <button type="button" className={styles.fileButton} onClick={() => fileInputRef.current?.click()}>
              Choose files
            </button>
            <span>Enter to add · Shift + Enter for a new line</span>
            <button type="button" className={styles.addButton} onClick={addText} disabled={!draft.trim()}>
              Add preview <ArrowIcon width={15} height={15} />
            </button>
          </div>
          {dragging && <div className={styles.dragOverlay}>Drop for a filename-only preview</div>}
        </div>

        <p className={styles.status} role="status" aria-live="polite">{status}</p>

        <section className={styles.materialsSection} aria-labelledby="materials-heading">
          <div className={styles.materialsHeading}>
            <h3 id="materials-heading">Orbiting fragments</h3>
            <span>{star.materials.length.toString().padStart(2, "0")}</span>
          </div>
          {star.materials.length === 0 ? (
            <div className={styles.materialsEmpty}>
              <span className={styles.emptyOrbit} aria-hidden="true"><i /></span>
              <p>Your temporary fragments will appear here and in orbit.</p>
            </div>
          ) : (
            <ul className={styles.materialList}>
              {star.materials.map((material) => {
                const meta = MATERIAL_META[material.kind];
                return (
                  <li key={material.id} className={styles.materialItem}>
                    <span
                      className={styles.materialGlyph}
                      style={{ "--material-color": meta.color } as React.CSSProperties}
                      aria-hidden="true"
                    >{meta.shortLabel}</span>
                    <div>
                      <div className={styles.materialMeta}>{meta.label}<span>Memory preview</span></div>
                      <p>{material.label}</p>
                      <small>{material.detail}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <p className={styles.panelFootnote}>No accounts, storage, network imports, or generated results in CP1.</p>
    </aside>
  );
}
