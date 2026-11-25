"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "@/app/auth/actions";
import { updateProfile } from "@/app/actions";
import type { ProfileDTO } from "@/lib/types";
import styles from "./account-menu.module.css";

export function AccountMenu({ profile, onProfile }: { profile: ProfileDTO; onProfile: (profile: ProfileDTO) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(profile.displayName);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function saveProfile() {
    setPending(true);
    setMessage("");
    setFailed(false);
    try {
      const result = await updateProfile(name);
      if (result.ok) {
        onProfile(result.data);
        setName(result.data.displayName);
        setMessage("Profile saved.");
      } else {
        setFailed(true);
        setMessage(result.error);
      }
    } catch {
      setFailed(true);
      setMessage("Could not save your profile. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const label = profile.displayName || profile.email || "Account";
  const initial = (profile.displayName || profile.email || "C").trim().charAt(0).toUpperCase();

  return (
    <div className={styles.account} ref={rootRef}>
      <button
        className={styles.accountButton}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => { setOpen((value) => !value); setMessage(""); setFailed(false); }}
      >
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
        <span>{label}</span>
      </button>
      {open && (
        <section className={styles.popover} role="dialog" aria-label="Your profile">
          <p className={styles.eyebrow}>YOUR PROFILE</p>
          <label>Display name
            <input
              value={name}
              maxLength={80}
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); void saveProfile(); }
              }}
            />
          </label>
          <label>Email<input value={profile.email} readOnly aria-readonly="true" /></label>
          <p className={`${styles.message} ${failed ? styles.error : ""}`} role={failed ? "alert" : "status"}>{message}</p>
          <button className={styles.saveButton} type="button" disabled={pending} onClick={() => void saveProfile()}>
            {pending ? "Saving…" : "Save profile"}
          </button>
          <form action={signOut}>
            <button className={styles.signOutButton} type="submit">Sign out</button>
          </form>
        </section>
      )}
    </div>
  );
}
