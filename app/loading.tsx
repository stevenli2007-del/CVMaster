import styles from "./page.module.css";

export default function Loading() {
  return (
    <main className={styles.universe}>
      <div className={styles.nebula} aria-hidden="true" />
      <div className={styles.routeState} role="status">
        <span className={styles.loadingOrbit} aria-hidden="true"><i /></span>
        <h1>Opening your universe…</h1>
        <p>Loading your private stars and fragments.</p>
      </div>
    </main>
  );
}
