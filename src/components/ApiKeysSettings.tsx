import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuthState } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/**
 * Settings → API keys: sign an agent's CLI in with an API key instead of its own login, so it bills the user's API account. Claude
 * Code today (a key for an endpoint is set on the endpoint, in Endpoints); Codex says why it can't yet. The key goes to the Mac's
 * Keychain and is never shown again: the page only knows that one is saved.
 */
export function ApiKeysSettings() {
  const [state, setState] = useState<AuthState | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.providerAuthState().then(setState, (e) => setError(errText(e)));
  }, []);

  if (!state) return <div className="settings-loading">{error ?? "Loading…"}</div>;

  const run = (job: Promise<AuthState>, after?: () => void) => {
    setBusy(true);
    setError(null);
    job.then(
      (next) => {
        setState(next);
        after?.();
        setBusy(false);
      },
      (e) => {
        setError(errText(e));
        setBusy(false);
      },
    );
  };
  const { use_key: useKey, has_key: hasKey } = state.claude;

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">API keys</h2>
          <p className="mode-guide-summary">
            Sign an agent in with an API key instead of its own login, so it bills your API account and not a subscription. New chats follow the choice; a chat that is already running keeps what it started with until it is restarted.
          </p>
        </div>
      </div>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <h3 className="settings-subhead">Claude Code</h3>
        <div role="radiogroup" aria-label="How Claude Code signs in" className="settings-choices">
          <label>
            <input type="radio" name="claude-auth" checked={!useKey} disabled={busy} onChange={() => run(api.providerClaudeUseKey(false))} /> Its own sign-in (your Claude subscription)
          </label>
          <label>
            <input type="radio" name="claude-auth" checked={useKey} disabled={busy || !hasKey} onChange={() => run(api.providerClaudeUseKey(true))} /> My API key
            {!hasKey && <span className="settings-row-sub"> (save a key first)</span>}
          </label>
        </div>
        {hasKey ? (
          <div className="endpoint-keybox">
            <span className="settings-row-sub">A key is saved in your Mac's Keychain.</span>
            <button type="button" className="link-button" disabled={busy} onClick={() => run(api.providerClaudeKeyClear())}>
              Remove key
            </button>
          </div>
        ) : (
          <div className="endpoint-keybox">
            <input type="password" autoComplete="off" spellCheck={false} aria-label="Anthropic API key" placeholder="sk-ant-…" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button type="button" disabled={busy || !typed.trim()} onClick={() => run(api.providerClaudeKeySet(typed), () => setTyped(""))}>
              Save key
            </button>
          </div>
        )}
        <p className="settings-muted">
          With the key on, every Claude Code chat uses it, and so do the side question, chat titles and the phone's suggestions. If the key can't be read (the Keychain is locked, say), a chat does not start, and never falls back to your sign-in instead.
        </p>
        <p className="settings-muted">
          The key is passed to Claude Code, so commands Claude runs in a chat can read it, just as they could a key you exported in your shell. Use a key with a spending limit. On a key, Claude Code doesn't load your claude.ai connectors (such as Linear or Slack).
        </p>
      </section>
      <section className="settings-section">
        <h3 className="settings-subhead">Codex</h3>
        <p className="settings-muted">{state.not_yet}</p>
      </section>
      <section className="settings-section">
        <h3 className="settings-subhead">Endpoints</h3>
        <p className="settings-muted">An endpoint's key (OpenRouter, LiteLLM and the like) is set on the endpoint itself, in Endpoints.</p>
      </section>
    </>
  );
}
