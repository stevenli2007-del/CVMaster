"use client";

import { ResetIcon } from "@/components/icons";
import styles from "./page.module.css";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className={styles.universe}>
      <div className={styles.nebula} aria-hidden="true" />
      <div className={styles.routeState} role="alert">
        <p className={styles.eyebrow}>CONNECTION INTERRUPTED</p>
        <h1>Your universe couldn’t load.</h1>
        <p>Nothing was deleted. Check your connection and try again.</p>
        <button className={styles.newStarButton} type="button" onClick={reset}>
          <ResetIcon width={16} height={16} />Try again
        </button>
      </div>
    </main>
  );
}
