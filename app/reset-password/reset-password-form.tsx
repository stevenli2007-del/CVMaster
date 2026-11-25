"use client";

import { useActionState } from "react";
import { updatePassword, type AuthFormState } from "@/app/auth/actions";
import { ArrowIcon, SparkIcon } from "@/components/icons";
import styles from "@/app/auth.module.css";

const initialState: AuthFormState = { status: "idle", message: "" };

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, initialState);
  return (
    <main className={styles.authUniverse}>
      <div className={styles.authNebula} aria-hidden="true" />
      <section className={styles.authCard} aria-labelledby="reset-title">
        <div className={styles.authBrand}><span><SparkIcon width={18} height={18} /></span><strong>CVMaster</strong></div>
        <p className={styles.eyebrow}>PASSWORD RESET</p>
        <h1 id="reset-title">Choose a new password.</h1>
        <p className={styles.authIntro}>Use 8–72 characters. Your existing stars stay private.</p>
        <form action={action} className={styles.authForm}>
          <label>New password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} /></label>
          <button className={styles.primaryButton} type="submit" disabled={pending}>
            {pending ? "Updating…" : "Update password"}<ArrowIcon width={16} height={16} />
          </button>
        </form>
        <p className={`${styles.formMessage} ${state.status === "error" ? styles.formError : ""}`} role="alert">{state.message}</p>
      </section>
    </main>
  );
}
