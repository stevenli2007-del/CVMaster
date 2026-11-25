"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, ResetIcon, SparkIcon } from "@/components/icons";
import { StarPanel } from "@/components/star-panel";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import {
  createId,
  getStarPosition,
  MATERIAL_META,
  type ExperienceStar,
  type PreviewMaterial,
} from "@/lib/star-map";
import styles from "./page.module.css";

const StarMap = dynamic(() => import("@/components/star-map"), {
  ssr: false,
  loading: () => <div className={styles.scenePlaceholder} aria-hidden="true" />,
});

export default function Home() {
  const [stars, setStars] = useState<ExperienceStar[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const newStarButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const selectedStar = stars.find((star) => star.id === selectedId) ?? null;

  const closePanel = useCallback(() => {
    setStars((current) =>
      current.map((star) =>
        star.id === selectedId ? { ...star, materials: [] } : star,
      ),
    );
    setSelectedId(null);
    setAnnouncement("Panel closed. Preview fragments cleared.");
    window.requestAnimationFrame(() => newStarButtonRef.current?.focus());
  }, [selectedId]);

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

  function makeNewStar() {
    const star: ExperienceStar = {
      id: createId(),
      name: "Untitled star",
      position: getStarPosition(stars.length),
      hue: (stars.length * 67 + 228) % 360,
      createdAt: performance.now(),
      materials: [],
    };
    setStars((current) => [...current, star]);
    setSelectedId(star.id);
    setAnnouncement("New star created. Give it a name and add temporary preview fragments.");
  }

  function selectStar(id: string) {
    if (id === selectedId) return;
    setStars((current) =>
      current.map((star) => ({ ...star, materials: star.id === id ? star.materials : [] })),
    );
    setSelectedId(id);
    setAnnouncement("Star opened. Preview fragments on other stars were cleared.");
  }

  function renameStar(name: string) {
    if (!selectedId) return;
    setStars((current) =>
      current.map((star) => (star.id === selectedId ? { ...star, name } : star)),
    );
  }

  function addMaterials(materials: PreviewMaterial[]) {
    if (!selectedId || materials.length === 0) return;
    setStars((current) =>
      current.map((star) =>
        star.id === selectedId
          ? { ...star, materials: [...star.materials, ...materials] }
          : star,
      ),
    );
    setAnnouncement(
      `${materials.length} preview ${materials.length === 1 ? "fragment" : "fragments"} added. Nothing was uploaded or saved.`,
    );
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
          <button
            className={styles.resetButton}
            type="button"
            onClick={() => setResetKey((key) => key + 1)}
          >
            <ResetIcon width={15} height={15} />
            Reset view
          </button>
        </div>
      </header>

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
              <i
                className={styles.legendFragment}
                style={{ "--fragment-color": MATERIAL_META[kind].color } as React.CSSProperties}
              />
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
          onClick={makeNewStar}
          tabIndex={selectedStar ? -1 : 0}
        >
          <PlusIcon width={19} height={19} />
          Make a new star
        </button>
        <p>Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Click a star to focus</p>
      </div>

      {selectedStar && (
        <StarPanel
          star={selectedStar}
          onRename={renameStar}
          onAdd={addMaterials}
          onClose={closePanel}
        />
      )}

      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </main>
  );
}
