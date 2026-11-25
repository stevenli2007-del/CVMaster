import Link from "next/link";
import styles from "@/app/auth.module.css";

export default function AuthErrorPage() {
  return (
    <main className={styles.authUniverse}>
      <div className={styles.authNebula} aria-hidden="true" />
      <section className={styles.authCard}>
        <p className={styles.eyebrow}>ACCOUNT LINK</p>
        <h1>This link could not be verified.</h1>
        <p className={styles.authIntro}>It may have expired or already been used. Request a new link and try again.</p>
        <Link className={styles.primaryButton} href="/login">Back to sign in</Link>
      </section>
    </main>
  );
}
