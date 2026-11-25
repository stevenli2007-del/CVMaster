import Link from "next/link";
import { getAuthenticatedContext } from "@/lib/supabase/auth";
import { ResetPasswordForm } from "./reset-password-form";
import styles from "@/app/auth.module.css";

export default async function ResetPasswordPage() {
  const context = await getAuthenticatedContext();

  if (!context) {
    return (
      <main className={styles.authUniverse}>
        <div className={styles.authNebula} aria-hidden="true" />
        <section className={styles.authCard}>
          <p className={styles.eyebrow}>PASSWORD RESET</p>
          <h1>This link has expired.</h1>
          <p className={styles.authIntro}>Request a new reset link to continue.</p>
          <Link className={styles.primaryButton} href="/login">Back to sign in</Link>
        </section>
      </main>
    );
  }

  return <ResetPasswordForm />;
}
