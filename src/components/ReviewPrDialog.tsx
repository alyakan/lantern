import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import type { OpenPr } from "../types";

interface Props {
  folder: string;
  /** A pull request was chosen: Step by step Review starts on it. */
  onPick: (pr: OpenPr) => void;
  onClose: () => void;
}

/**
 * The open pull requests of the chat's folder (from gh), to start a review on one. When gh can't list them (missing,
 * not logged in, not a GitHub repository) it says so in words, and a number can still be typed.
 */
export function ReviewPrDialog({ folder, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [prs, setPrs] = useState<OpenPr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  useEffect(() => {
    let live = true;
    api.openPrs(folder).then(
      (list) => live && setPrs(list),
      (e) => live && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      live = false;
    };
  }, [folder]);

  const typed = /^#?(\d{1,7})$/.exec(number.trim());
  return (
    <dialog
      ref={ref}
      className="revert-dialog bring-dialog"
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
          if (typed) onPick({ number: Number(typed[1]), title: "", author: "", branch: "", draft: false });
        }}
      >
        <div className="revert-title" id={titleId}>
          Review a PR
        </div>
        {error && (
          <div className="revert-error" role="alert">
            {error}
          </div>
        )}
        {!error && prs === null && <div className="menu-empty">Looking for open pull requests…</div>}
        {prs && prs.length === 0 && <div className="menu-empty">No open pull requests in this repository.</div>}
        {prs && prs.length > 0 && (
          <ul className="menu-list pr-list" aria-label="Open pull requests">
            {prs.map((pr) => (
              <li key={pr.number}>
                <button type="button" className="menu-row pr-row" onClick={() => onPick(pr)}>
                  <span className="pr-number">#{pr.number}</span>
                  <span className="mode-text">
                    <span className="menu-row-title">{pr.title}</span>
                    <span className="mode-hint">
                      {pr.author}
                      {pr.branch && ` · ${pr.branch}`}
                      {pr.draft && " · draft"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="pr-number-field">
          <span className="mode-hint">Or a PR number</span>
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="#128" inputMode="numeric" aria-label="PR number" />
        </label>
        <div className="revert-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!typed}>
            Review
          </button>
        </div>
      </form>
    </dialog>
  );
}
