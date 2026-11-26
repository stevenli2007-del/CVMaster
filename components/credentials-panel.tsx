"use client";

import { useEffect, useRef, useState } from "react";
import type { CredentialDTO } from "@/lib/types";
import styles from "./credentials-panel.module.css";

type FormState = {
  provider: string;
  label: string;
  model: string;
  endpoint: string;
  protocol: string;
  apiKey: string;
};

const EMPTY_FORM: FormState = {
  provider: "",
  label: "",
  model: "",
  endpoint: "",
  protocol: "openai-compatible",
  apiKey: "",
};

export function CredentialsPanel({ onClose }: { onClose: () => void }) {
  const [credentials, setCredentials] = useState<CredentialDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/credentials", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as { credentials?: CredentialDTO[]; error?: string } | null;
        if (!response.ok || !payload?.credentials) throw new Error(payload?.error || "Could not load your provider keys.");
        if (!cancelled) setCredentials(payload.credentials);
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
          setMessage(error instanceof Error ? error.message : "Could not load your provider keys.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  async function save() {
    setPending(true);
    setMessage("");
    setFailed(false);
    const endpoint = editingId ? `/api/credentials/${editingId}` : "/api/credentials";
    const method = editingId ? "PUT" : "POST";
    // Snapshot the form values, then clear the API key immediately so it does
    // not linger in React state or the password input regardless of whether the
    // request succeeds or fails.
    const snapshot = {
      provider: form.provider,
      label: form.label,
      model: form.model,
      endpoint: form.endpoint,
      protocol: form.protocol,
      apiKey: form.apiKey,
    };
    setForm((current) => ({ ...current, apiKey: "" }));
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: snapshot.provider,
          label: snapshot.label || null,
          model: snapshot.model || null,
          endpoint: snapshot.endpoint || null,
          protocol: snapshot.protocol,
          apiKey: snapshot.apiKey || null,
        }),
      });
      const payload = await response.json().catch(() => null) as { credential?: CredentialDTO; error?: string } | null;
      if (!response.ok || !payload?.credential) {
        throw new Error(payload?.error || "Could not save this provider key.");
      }
      setCredentials((current) => {
        const exists = current.some((credential) => credential.id === payload.credential!.id);
        return exists
          ? current.map((credential) => credential.id === payload.credential!.id ? payload.credential! : credential)
          : [...current, payload.credential!];
      });
      resetForm();
      setMessage(editingId ? "Provider key updated." : "Provider key saved.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save this provider key.");
    } finally {
      setPending(false);
    }
  }

  function startEdit(credential: CredentialDTO) {
    setEditingId(credential.id);
    setConfirmDeleteId(null);
    setMessage("");
    setFailed(false);
    // The endpoint is pre-filled empty on purpose: the client only holds the
    // masked endpoint, never the full value. Leaving it blank keeps the stored
    // endpoint; the user may enter a new one to change it. The key starts blank
    // and stays blank to keep the existing key.
    setForm({
      provider: credential.provider,
      label: credential.label ?? "",
      model: credential.model ?? "",
      endpoint: "",
      protocol: credential.protocol,
      apiKey: "",
    });
  }

  async function remove(id: string) {
    setPending(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(`/api/credentials/${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as { credential?: { id: string; status: string }; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "Could not delete this provider key.");
      setCredentials((current) => current.filter((credential) => credential.id !== id));
      setConfirmDeleteId(null);
      if (editingId === id) resetForm();
      setMessage("Provider key marked for deletion.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not delete this provider key.");
    } finally {
      setPending(false);
    }
  }

  function updateField(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className={styles.backdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.panel} role="dialog" aria-label="Provider keys" ref={rootRef}>
        <header className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>BRING YOUR OWN KEY</p>
            <h2>Provider keys</h2>
          </div>
          <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className={styles.intro}>
          Your API key is encrypted on our servers and used only to call the provider
          you choose. It is never shown back to you, stored in your browser, or written
          to logs. Deleting a key here does not revoke it at the provider — do that in
          the provider&apos;s console if you suspect it leaked.
        </p>

        <form
          className={styles.form}
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <div className={styles.grid}>
            <label>
              Provider
              <input
                value={form.provider}
                maxLength={64}
                autoComplete="off"
                placeholder="e.g. DeepSeek, Qwen, OpenAI-compatible"
                onChange={(event) => updateField("provider", event.target.value)}
              />
            </label>
            <label>
              Label <span className={styles.optional}>(optional)</span>
              <input
                value={form.label}
                maxLength={80}
                autoComplete="off"
                placeholder="e.g. Work DeepSeek"
                onChange={(event) => updateField("label", event.target.value)}
              />
            </label>
            <label>
              Model
              <input
                value={form.model}
                maxLength={160}
                autoComplete="off"
                placeholder="e.g. deepseek-chat"
                onChange={(event) => updateField("model", event.target.value)}
              />
            </label>
            <label>
              Protocol
              <input
                value={form.protocol}
                maxLength={64}
                autoComplete="off"
                placeholder="openai-compatible"
                onChange={(event) => updateField("protocol", event.target.value)}
              />
            </label>
          </div>
          <label>
            Endpoint (HTTPS only) {editingId && <span className={styles.optional}>(leave blank to keep your existing endpoint)</span>}
            <input
              value={form.endpoint}
              maxLength={2048}
              autoComplete="off"
              placeholder="https://api.example.com/v1"
              onChange={(event) => updateField("endpoint", event.target.value)}
            />
          </label>
          <label>
            API key {editingId && <span className={styles.optional}>(leave blank to keep your existing key)</span>}
            <input
              type="password"
              value={form.apiKey}
              maxLength={8192}
              autoComplete="new-password"
              required={!editingId}
              onChange={(event) => updateField("apiKey", event.target.value)}
            />
          </label>

          <p className={`${styles.message} ${failed ? styles.error : ""}`} role={failed ? "alert" : "status"}>
            {message}
          </p>

          <div className={styles.formActions}>
            {editingId && (
              <button className={styles.cancelButton} type="button" onClick={resetForm} disabled={pending}>
                Cancel
              </button>
            )}
            <button className={styles.saveButton} type="submit" disabled={pending}>
              {pending ? "Saving…" : editingId ? "Update key" : "Save key"}
            </button>
          </div>
        </form>

        <div className={styles.list}>
          <p className={styles.eyebrow}>SAVED KEYS</p>
          {loading ? (
            <p className={styles.empty}>Loading…</p>
          ) : credentials.length === 0 ? (
            <p className={styles.empty}>No provider keys saved yet.</p>
          ) : (
            <ul>
              {credentials.map((credential) => (
                <li key={credential.id} className={styles.credentialRow}>
                  <div className={styles.credentialInfo}>
                    <strong>{credential.label || credential.provider}</strong>
                    <span>
                      {credential.provider}
                      {credential.model ? ` · ${credential.model}` : ""}
                      {credential.lastFour ? ` · ••••${credential.lastFour}` : ""}
                    </span>
                    <code title={credential.maskedEndpoint}>{credential.maskedEndpoint}</code>
                    {credential.status === "deleting" && <em className={styles.deleting}>Marked for deletion</em>}
                  </div>
                  <div className={styles.rowActions}>
                    {confirmDeleteId === credential.id ? (
                      <>
                        <span className={styles.confirmText}>Delete?</span>
                        <button type="button" className={styles.dangerButton} disabled={pending} onClick={() => void remove(credential.id)}>
                          Confirm
                        </button>
                        <button type="button" className={styles.cancelButton} onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={styles.editButton} disabled={pending} onClick={() => startEdit(credential)}>
                          Replace
                        </button>
                        <button type="button" className={styles.dangerButton} disabled={pending} onClick={() => setConfirmDeleteId(credential.id)}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
