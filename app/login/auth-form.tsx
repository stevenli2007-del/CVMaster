"use client";

import { useActionState, useState } from "react";
import {
  requestPasswordReset,
  signIn,
  signUp,
  type AuthFormState,
} from "@/app/auth/actions";
import { ArrowIcon, SparkIcon } from "@/components/icons";
import styles from "@/app/auth.module.css";

const initialState: AuthFormState = { status: "idle", message: "" };

type Mode = "sign-in" | "sign-up" | "reset";

export function AuthForm() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [signInState, signInAction, signingIn] = useActionState(signIn, initialState);
  const [signUpState, signUpAction, signingUp] = useActionState(signUp, initialState);
  const [resetState, resetAction, resetting] = useActionState(requestPasswordReset, initialState);

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
  }

  const state = mode === "sign-in" ? signInState : mode === "sign-up" ? signUpState : resetState;

  return (
    <main className={styles.authUniverse}>
      <div className={styles.authNebula} aria-hidden="true" />
      <section className={styles.authCard} aria-labelledby="auth-title">
        <div className={styles.authBrand}>
          <span><SparkIcon width={18} height={18} /></span>
          <strong>CVMaster</strong>
        </div>
        <p className={styles.eyebrow}>YOUR EXPERIENCE, IN ORBIT</p>
        <h1 id="auth-title">
          {mode === "sign-in" ? "Welcome back." : mode === "sign-up" ? "Start your universe." : "Reset your password."}
        </h1>
        <p className={styles.authIntro}>
          {mode === "reset"
            ? "We’ll email you a secure link to choose a new password."
            : "Keep every project, note, link, and file in one private place."}
        </p>

        {mode !== "reset" && (
          <div className={styles.tabs} role="tablist" aria-label="Account access">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-in"}
              onClick={() => changeMode("sign-in")}
            >Sign in</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-up"}
              onClick={() => changeMode("sign-up")}
            >Create account</button>
          </div>
        )}

        {mode === "sign-in" && (
          <form action={signInAction} className={styles.authForm}>
            <label>Email<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
            <label>Password<input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={72} /></label>
            <button className={styles.primaryButton} type="submit" disabled={signingIn}>
              {signingIn ? "Signing in…" : "Sign in"}<ArrowIcon width={16} height={16} />
            </button>
            <button className={styles.textButton} type="button" onClick={() => changeMode("reset")}>Forgot password?</button>
          </form>
        )}

        {mode === "sign-up" && (
          <form action={signUpAction} className={styles.authForm}>
            <label>Name <span>(optional)</span><input name="displayName" type="text" autoComplete="name" maxLength={80} /></label>
            <label>Email<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
            <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} /></label>
            <p className={styles.passwordHint}>Use 8–72 characters.</p>
            <button className={styles.primaryButton} type="submit" disabled={signingUp}>
              {signingUp ? "Creating account…" : "Create account"}<ArrowIcon width={16} height={16} />
            </button>
          </form>
        )}

        {mode === "reset" && (
          <form action={resetAction} className={styles.authForm}>
            <label>Email<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
            <button className={styles.primaryButton} type="submit" disabled={resetting}>
              {resetting ? "Sending link…" : "Send reset link"}<ArrowIcon width={16} height={16} />
            </button>
            <button className={styles.textButton} type="button" onClick={() => changeMode("sign-in")}>Back to sign in</button>
          </form>
        )}

        <p
          className={`${styles.formMessage} ${state.status === "error" ? styles.formError : ""}`}
          role={state.status === "error" ? "alert" : "status"}
          aria-live="polite"
        >{state.message}</p>
        <p className={styles.privacyNote}>Private by default. Your materials are visible only to your account.</p>
      </section>
    </main>
  );
}
