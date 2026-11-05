import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { HostedProvider } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

export interface HostedProvidersProps {
  /** A provider was connected or disconnected: the window asks again which providers a chat can run on. */
  onChanged?: () => void;
}

/**
 * The hosted providers (DeepSeek and the like), one row each, from the list the backend gives: nothing here is about one provider.
 * Connecting makes the provider's endpoint (in Endpoints, where it can be edited or removed) and keeps the key in the Keychain.
 */
export function HostedProviders({ onChanged }: HostedProvidersProps) {
  const [providers, setProviders] = useState<HostedProvider[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.hostedProviders().then(setProviders, (e) => setError(errText(e)));
  }, []);

  const run = (job: Promise<HostedProvider[]>, after?: () => void) => {
    setBusy(true);
    setError(null);
    job.then(
      (next) => {
        setProviders(next);
        after?.();
        setBusy(false);
        onChanged?.();
      },
      (e) => {
        setError(errText(e));
        setBusy(false);
      },
    );
  };

  if (!providers) return error ? <div className="settings-error" role="alert">{error}</div> : null;

  return (
    <>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {providers.map((p) => (
        <section key={p.id} className="settings-section">
          <h3 className="settings-subhead">{p.name}</h3>
          <p className="settings-muted">
            Runs a chat on {p.name}'s models ({p.models.join(", ")}) through Claude Code, sent to {p.url}. Your messages and the files Claude reads go to {p.name}, not to Anthropic. A chat on it has no Auto mode, advisor or effort level, and some things may not work on every model. It appears in New chat beside Claude.
          </p>
          {p.connected ? (
            <div className="endpoint-keybox">
              <span className="settings-row-sub">Connected: a key is saved in your Mac's Keychain.</span>
              <button type="button" className="link-button" disabled={busy} onClick={() => run(api.hostedProviderDisconnect(p.id))}>
                Remove key
              </button>
            </div>
          ) : (
            <div className="endpoint-keybox">
              <input type="password" autoComplete="off" spellCheck={false} aria-label={`${p.name} API key`} placeholder={p.key_hint} value={typed[p.id] ?? ""} onChange={(e) => setTyped((t) => ({ ...t, [p.id]: e.target.value }))} />
              <button type="button" disabled={busy || !(typed[p.id] ?? "").trim()} onClick={() => run(api.hostedProviderConnect(p.id, typed[p.id] ?? ""), () => setTyped((t) => ({ ...t, [p.id]: "" })))}>
                Connect
              </button>
              <button type="button" className="link-button" onClick={() => void openUrl(p.key_page).catch(() => {})}>
                Get a key
              </button>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
