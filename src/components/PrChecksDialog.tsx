import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import type { GhAccess } from "../types";
import { PR_MODES, TRIES_MAX, TRIES_MIN, type PrMode, type PrSetting } from "../lib/prChecks";

/** What to tell the user when the GitHub CLI can't be used (the choice is still theirs to make). */
/** Under Fix it myself: what the chat's Permissions mean for the fixes it makes. */
export const FIX_NOTE = "With Auto permissions Claude will push fixes without asking you. With Ask it asks you on each command.";
export const GH_NOTE = "Install and log in to the GitHub CLI to watch checks.";

/** The GitHub CLI's state, once (null while it is being looked at). */
export function useGhAccess(): GhAccess | null {
  const [access, setAccess] = useState<GhAccess | null>(null);
  useEffect(() => {
    let live = true;
    api.ghAccess().then(
      (a) => live && setAccess(a),
      () => live && setAccess("missing"),
    );
    return () => {
      live = false;
    };
  }, []);
  return access;
}

export const TRIES_OPTIONS = Array.from({ length: TRIES_MAX - TRIES_MIN + 1 }, (_, i) => TRIES_MIN + i);

interface Props {
  /** The project's name, as the sidebar shows it. */
  label: string;
  setting: PrSetting;
  onSave: (setting: PrSetting) => void;
  onClose: () => void;
}

/**
 * "Pull request checks…": what happens after a pull request is open and its checks run, for one project. Three choices
 * with a line each; Fix it myself also says how many times Lantern may ask Claude to fix a failure.
 */
export function PrChecksDialog({ label, setting, onSave, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const name = useId();
  const [mode, setMode] = useState<PrMode>(setting.mode);
  const [tries, setTries] = useState(setting.tries);
  const access = useGhAccess();

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  return (
    <dialog
      ref={ref}
      className="revert-dialog pr-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        className="revert-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ mode, tries });
          onClose();
        }}
      >
        <div className="revert-title" id={titleId}>
          Pull request checks
        </div>
        <p className="revert-text">What should happen in {label} once a pull request is open and its checks run?</p>
        <fieldset className="pr-modes">
          <legend className="sr-only">After a pull request's checks run</legend>
          {PR_MODES.map((m) => (
            <label key={m.mode} className="pr-mode">
              <input type="radio" name={name} checked={mode === m.mode} onChange={() => setMode(m.mode)} />
              <span className="pr-mode-text">
                <span className="pr-mode-name">{m.label}</span>
                <span className="pr-mode-hint">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "fix" && (
          <p className="pr-mode-hint pr-fix-note">
            {FIX_NOTE}
          </p>
        )}
        <label className={`pr-tries${mode === "fix" ? "" : " off"}`}>
          <span>Tries for Fix it myself</span>
          <select aria-label="Tries" value={tries} disabled={mode !== "fix"} onChange={(e) => setTries(Number(e.target.value))}>
            {TRIES_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="pr-tries-hint">Per pull request. After the last try, or if you stop it, it goes back to Tell me.</span>
        </label>
        {mode !== "off" && access !== null && access !== "ready" && (
          <div className="ship-warning" role="note">
            {GH_NOTE}
          </div>
        )}
        <div className="revert-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
