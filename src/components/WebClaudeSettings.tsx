import { useEffect, useState } from "react";
import { api } from "../api";
import { lastSeen } from "../lib/remoteControl";
import { folderName, type WebClaudeView } from "../lib/webClaude";
import { SettingsHint } from "./SettingsRow";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/**
 * Settings › Web Claude: a connector claude.ai adds, so web Claude (where the designs are) can send work to Lantern's chats
 * and read what they did. Off until the user turns it on; nothing it sends runs until they tap Run.
 */
export function WebClaudeSettings({ now = Date.now }: { now?: () => number }) {
  const [view, setView] = useState<WebClaudeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const refresh = () => api.webclaudeView().then(setView, (e) => setError(errText(e)));
    refresh();
    const unlisten = api.onWebclaudeChanged(refresh).catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);

  const setEnabled = (on: boolean) => {
    setBusy(true);
    setError(null);
    api.webclaudeSetEnabled(on).then(
      (v) => {
        setView(v);
        setBusy(false);
      },
      (e) => {
        setError(errText(e));
        setBusy(false);
        void api.webclaudeView().then(setView, () => {});
      },
    );
  };
  const copy = () => {
    if (!view?.address) return;
    navigator.clipboard.writeText(view.address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e) => setError(`Couldn't copy the address: ${errText(e)}`),
    );
  };
  const revoke = (id: string) =>
    api.webclaudeRevoke(id).then(
      () => api.webclaudeView().then(setView),
      (e) => setError(errText(e)),
    );
  const at = now();

  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Web Claude</h2>
          <p className="mode-guide-summary">Let Claude on claude.ai, where you design, send work to Lantern's chats and read what they built. A chat here can leave web Claude questions and notes.</p>
          <SettingsHint>Everything web Claude sends waits for you to tap Run, on this Mac or your phone. Signing in from claude.ai waits for your Allow.</SettingsHint>
        </div>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {view && (
        <>
          <section className="general-section" aria-labelledby="web-on">
            <h3 id="web-on" className="general-title">
              Connector
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />
              <span>{busy ? (view.enabled ? "Turning off…" : "Turning on…") : "Let web Claude reach Lantern"}</span>
            </label>
            <SettingsHint>On puts Lantern's connector on the internet with Tailscale Funnel, at this Mac's Tailscale name on port 443. Your other Tailscale serve and Funnel settings are left alone. Off takes it down again. It works only while this Mac is awake and Lantern is open.</SettingsHint>
            {view.enabled && !view.listening && !busy && (
              <p className="settings-error" role="status">
                It's on, but the connector isn't running right now. Turn it off and on again.
              </p>
            )}
          </section>
          {view.address && (
            <section className="general-section" aria-labelledby="web-add">
              <h3 id="web-add" className="general-title">
                Add it in claude.ai
              </h3>
              <div className="remote-pair-actions">
                <code className="web-address">{view.address}</code>
                <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <SettingsHint>In claude.ai, open Settings › Connectors, choose Add custom connector, and paste this address. claude.ai then opens a sign-in page with a six-character code, and Lantern shows a card: type the code on it, then Allow.</SettingsHint>
            </section>
          )}
          <section className="general-section" aria-labelledby="web-auto">
            <h3 id="web-auto" className="general-title">
              New chats
            </h3>
            <label className="general-option">
              <input type="checkbox" checked={view.new_chats_auto} onChange={(e) => api.webclaudeSetAuto(e.target.checked).then(setView, (err) => setError(errText(err)))} />
              <span>Start web Claude's chats on Auto</span>
            </label>
            <SettingsHint>When you Run work for a canvas with no chat yet, Lantern starts one in its project. On Auto, a classifier approves most of what it does; off, it starts on Ask and asks you for each change. A chat already working on the canvas keeps its own setting.</SettingsHint>
          </section>
          <section className="general-section" aria-labelledby="web-connections">
            <h3 id="web-connections" className="general-title">
              Connected
            </h3>
            {view.connections.length === 0 ? (
              <span className="settings-muted">Nothing is connected.</span>
            ) : (
              <ul className="remote-devices">
                {view.connections.map((c) => (
                  <li key={c.id}>
                    <span>
                      {c.client}
                      <span className="settings-muted"> {lastSeen(c.last_used, at)}</span>
                    </span>
                    <button aria-label={`Disconnect ${c.client}`} onClick={() => revoke(c.id)}>
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="settings-muted">A connection ends after 30 days without use. Disconnect ends it at once: claude.ai has to sign in again.</span>
          </section>
          {view.links.length > 0 && (
            <section className="general-section" aria-labelledby="web-links">
              <h3 id="web-links" className="general-title">
                Canvases and their projects
              </h3>
              <ul className="remote-devices">
                {view.links.map((l) => (
                  <li key={l.canvas}>
                    <span title={l.canvas}>
                      {l.title}
                      <span className="settings-muted"> → {folderName(l.folder)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <SettingsHint>Remembered from the first Run of each canvas. A card can pick another project, which then takes its place.</SettingsHint>
            </section>
          )}
        </>
      )}
    </>
  );
}
