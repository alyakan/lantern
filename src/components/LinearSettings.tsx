import { useEffect, useState } from "react";
import { api } from "../api";
import type { TeamChoice } from "../lib/linear";
import { projectLabels } from "../lib/sidebar";
import type { LinearWork } from "../types";

export interface LinearSettingsProps {
  /** Every project Lantern knows (open now or in the recents). */
  folders: string[];
  /** The Linear team chosen for each project; a project not in it follows its branches. */
  teams: TeamChoice;
  onTeams: (t: TeamChoice) => void;
  /** What Linear said, shared with the Desk (connecting and disconnecting change it). */
  work: LinearWork | null;
  onWork: (w: LinearWork | null) => void;
  /** Leave out the work of Ready issues (merged, waiting for a release) from Your work. */
  hideReady: boolean;
  onHideReady: (on: boolean) => void;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
const AUTO = "auto";

/**
 * Settings → Linear: connect a workspace with a personal API key (kept in the Keychain, never shown again), and which team each
 * project's work is in. Lantern only reads from Linear: your issues that aren't done, for the Desk's Your work.
 */
export function LinearSettings({ folders, teams, onTeams, work, onWork, hideReady, onHideReady }: LinearSettingsProps) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (work === null) api.linearWork().then(onWork, () => {});
  }, []);
  const labels = projectLabels(folders);
  const connect = () => {
    setBusy(true);
    setError(null);
    api.linearConnect(key).then(
      (w) => {
        setBusy(false);
        setKey("");
        onWork(w);
      },
      (e) => {
        setBusy(false);
        setError(errText(e));
      },
    );
  };
  const disconnect = () =>
    api.linearDisconnect().then(
      () => onWork({ connected: false, viewer: null, org: null, teams: [], issues: [], error: null }),
      (e) => setError(errText(e)),
    );
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Linear</h2>
          <p className="mode-guide-summary">
            Your issues in Linear show on the Desk's Your work until they are Done, Closed or Canceled: each pull request with its issue and project, and what you haven't started. Lantern only reads from Linear; it never changes anything there.
          </p>
        </div>
      </div>
      {work?.connected ? (
        <div className="settings-row linear-connected">
          <span className="settings-row-name">
            Connected{work.viewer ? ` as ${work.viewer}` : ""}
            {work.org ? ` in ${work.org}` : ""}
          </span>
          <button onClick={disconnect}>Disconnect</button>
          {work.error && <span className="settings-row-sub linear-error">{work.error}</span>}
        </div>
      ) : (
        <form
          className="settings-row linear-connect"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) connect();
          }}
        >
          <label className="settings-row-name" htmlFor="linear-key">
            Personal API key
          </label>
          <input id="linear-key" type="password" autoComplete="off" spellCheck={false} placeholder="lin_api_…" value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            {busy ? "Checking…" : "Connect"}
          </button>
          <span className="settings-row-sub">Make one in Linear under Settings → Security & access → Personal API keys. It is kept in your Mac's Keychain and never shown again.</span>
          {error && (
            <span className="settings-row-sub linear-error" role="alert">
              {error}
            </span>
          )}
        </form>
      )}
      {work?.connected && (
        <>
          <label className="settings-row linear-hide-ready">
            <input type="checkbox" checked={hideReady} onChange={(e) => onHideReady(e.target.checked)} />
            <span className="settings-row-name">Hide Ready issues</span>
            <span className="settings-row-sub">Ready means merged and waiting for a release. Hidden, an issue and its pull requests leave Your work on the Desk and the phone until it moves on.</span>
          </label>
          <h3 className="linear-teams-title">Teams</h3>
          {folders.length === 0 ? (
            <div className="settings-muted">No projects yet.</div>
          ) : (
            <ul className="settings-list">
              {folders.map((folder, i) => (
                <li key={folder} className="settings-row pr-setting">
                  <div className="pr-setting-main">
                    <span className="settings-row-name" title={folder}>
                      {labels[i]}
                    </span>
                    <select
                      aria-label={`Linear team for ${labels[i]}`}
                      value={teams[folder] ?? AUTO}
                      onChange={(e) => {
                        const next = { ...teams };
                        if (e.target.value === AUTO) delete next[folder];
                        else next[folder] = e.target.value;
                        onTeams(next);
                      }}
                    >
                      <option value={AUTO}>From its branches</option>
                      <option value="">None</option>
                      {work.teams.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.name} ({t.key})
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <span className="settings-row-sub">"From its branches" picks the team whose issue IDs (like ENG-142) the project's branches and pull requests carry most.</span>
        </>
      )}
    </>
  );
}
