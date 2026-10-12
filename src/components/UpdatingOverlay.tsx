import { useEffect, useRef } from "react";
import type { UpdateState } from "../types";

/**
 * Shown over the whole window while Lantern replaces itself, in place of everything the install is about to take away:
 * every chat's claude is stopped and the app reopens, which otherwise looks like the window vanishing. A modal dialog,
 * so it sits above Settings or anything else open, and can't be dismissed.
 */
export function UpdatingOverlay({ state, version }: { state: UpdateState; version: string | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  const target = state.kind === "installing" ? state.version : version;
  const restarting = state.kind === "restarting";
  return (
    <dialog ref={ref} className="updating" aria-label="Updating Lantern" onCancel={(e) => e.preventDefault()}>
      <div className="updating-body" role="alert">
        <span className="spinner updating-spinner" aria-hidden />
        <div className="updating-title">{target ? `Updating to Lantern ${target}` : "Updating Lantern"}</div>
        <div className="updating-step">{restarting ? "Closing your chats and restarting…" : "Installing the update…"}</div>
        <div className="updating-note">Lantern reopens in a moment. Chats that were working can be resumed from History.</div>
      </div>
    </dialog>
  );
}
