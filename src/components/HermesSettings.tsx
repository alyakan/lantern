import { useEffect, useState } from "react";
import { api } from "../api";
import type { HermesStatus } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/**
 * Hermes Agent on your Claude subscription: one switch that does what `hermes plugins install claude-subscription-directsdk
 * --enable` and picking it in `hermes model` do by hand. Shown only when Hermes is installed; Lantern's own chats don't change.
 */
export function HermesSettings() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.hermesStatus().then(setStatus, (e) => setError(errText(e)));
  }, []);

  if (!status?.installed) return null;

  const flip = (on: boolean) => {
    setBusy(true);
    setError(null);
    api.hermesSet(on).then(
      (next) => {
        setStatus(next);
        setBusy(false);
      },
      (e) => {
        setError(errText(e));
        setBusy(false);
      },
    );
  };

  return (
    <section className="settings-section">
      <h3 className="settings-subhead">Hermes Agent</h3>
      <label className="general-option">
        <input type="checkbox" checked={status.on} disabled={busy} onChange={(e) => flip(e.target.checked)} /> Run Hermes on my Claude subscription
        {busy && <span className="settings-row-sub"> (setting up Hermes…)</span>}
      </label>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      <p className="settings-muted">
        Not an API key: this sets up Hermes, Nous Research's own agent, to use your Claude subscription. It installs and turns on Hermes's claude-subscription-directsdk plugin and makes it Hermes's provider, so
        Hermes runs its turns through your claude CLI. The plugin says each turn is billed against your subscription's Agent SDK allowance. Off turns the plugin off and leaves Hermes with no provider until you
        pick one with hermes model. Lantern's own chats don't change.
      </p>
      <p className="settings-muted">The plugin is experimental, and its repository was archived in October 2026, so it may not get fixes.</p>
    </section>
  );
}
