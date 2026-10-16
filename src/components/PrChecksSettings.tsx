import { PR_MODES, settingFor, type PrMode, type PrSetting } from "../lib/prChecks";
import { projectLabels } from "../lib/sidebar";
import { GH_NOTE, TRIES_OPTIONS, useGhAccess } from "./PrChecksDialog";

export interface PrChecksSettingsProps {
  /** Every project Lantern knows (open now or in the recents). */
  folders: string[];
  /** Each project's saved setting. */
  saved: Record<string, Partial<PrSetting> | undefined>;
  onChange: (folder: string, setting: PrSetting) => void;
}

/** Settings → Pull requests: what happens after a pull request's checks run, for each project. */
export function PrChecksSettings({ folders, saved, onChange }: PrChecksSettingsProps) {
  const access = useGhAccess();
  const labels = projectLabels(folders);
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Pull requests</h2>
          <p className="mode-guide-summary">What happens once a pull request is open and its checks run, chosen for each project. Saved on this Mac. Lantern only reads the checks; it never merges.</p>
        </div>
      </div>
      {access !== null && access !== "ready" && (
        <div className="ship-warning" role="note">
          {GH_NOTE}
        </div>
      )}
      {folders.length === 0 ? (
        <div className="settings-muted">No projects yet.</div>
      ) : (
        <ul className="settings-list">
          {folders.map((folder, i) => {
            const s = settingFor(saved, folder);
            const hint = PR_MODES.find((m) => m.mode === s.mode)?.hint;
            return (
              <li key={folder} className="settings-row pr-setting">
                <div className="pr-setting-main">
                  <span className="settings-row-name" title={folder}>
                    {labels[i]}
                  </span>
                  <select aria-label={`After checks run in ${labels[i]}`} value={s.mode} onChange={(e) => onChange(folder, { ...s, mode: e.target.value as PrMode })}>
                    {PR_MODES.map((m) => (
                      <option key={m.mode} value={m.mode}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {s.mode === "fix" && (
                    <label className="pr-setting-tries">
                      <span>Tries</span>
                      <select aria-label={`Tries in ${labels[i]}`} value={s.tries} onChange={(e) => onChange(folder, { ...s, tries: Number(e.target.value) })}>
                        {TRIES_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <span className="settings-row-sub">{hint}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
