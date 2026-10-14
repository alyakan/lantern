import { downloadPercent } from "../lib/updates";
import type { UpdateState } from "../types";
import { UpdateButton } from "./UpdateButton";

export interface UpdatesPageProps {
  /** The version that's running. */
  version: string | null;
  state: UpdateState;
  /** Looks for an update now. */
  onCheck: () => void;
  /** A downloaded update that's waiting, and how to take it: the same as the button under the chat box. */
  ready: { version: string; busy: number; onRestart: () => void; onLater: () => void } | null;
  /** Versions whose "What's new" can be shown: the running one (just updated to) or the waiting one. */
  whatsNew?: string[];
  onWhatsNew?: (version: string) => void;
}

/** Settings ▸ Updates: the running version, a button to look for a newer one, and how that's going. */
export function UpdatesPage({ version, state, onCheck, ready, whatsNew = [], onWhatsNew }: UpdatesPageProps) {
  const checking = state.kind === "checking";
  const downloading = state.kind === "downloading";
  const percent = downloadPercent(state);
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Updates</h2>
          <p className="mode-guide-summary">Lantern looks for a newer version a little after it opens and every few hours, and downloads it in the background. You can also look now.</p>
        </div>
        <button className="primary" onClick={onCheck} disabled={checking || downloading}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>
      <div className="updates-body">
        <div className="updates-version">
          Lantern <strong>{version ?? "…"}</strong>
        </div>
        <div className="updates-status" role="status" aria-live="polite">
          {state.kind === "checking" && (
            <span className="updates-line">
              <span className="spinner" aria-hidden /> Looking for a newer version…
            </span>
          )}
          {state.kind === "up_to_date" && <span className="updates-line">You're up to date.</span>}
          {state.kind === "downloading" && (
            <div className="updates-download">
              <span className="updates-line">
                <span className="spinner" aria-hidden /> Downloading Lantern {state.version}
                {percent !== null ? ` · ${percent}%` : "…"}
              </span>
              <div className="updates-bar" role="progressbar" aria-label={`Downloading Lantern ${state.version}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
                <div className={`updates-bar-fill${percent === null ? " unknown" : ""}`} style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
            </div>
          )}
          {state.kind === "ready" && ready && (
            <div className="updates-ready">
              <span className="updates-line">Lantern {ready.version} is downloaded and ready.</span>
              <UpdateButton {...ready} />
            </div>
          )}
          {state.kind === "ready" && !ready && <span className="updates-line">Lantern {state.version} is downloaded. It installs when you quit.</span>}
          {state.kind === "failed" && (
            <div className="settings-error" role="alert">
              {state.error}
            </div>
          )}
        </div>
        {onWhatsNew && whatsNew.length > 0 && (
          <div className="updates-whats-new">
            {whatsNew.map((v) => (
              <button key={v} className="link-button" onClick={() => onWhatsNew(v)}>
                What's new in {v}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
