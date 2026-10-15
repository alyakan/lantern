import { useEffect, useId, useRef, useState } from "react";
import { teamWarning, type WorkingTeam } from "../lib/usage";

interface Props {
  /** The teams that are working already. */
  teams: WorkingTeam[];
  /** Start: `dontAsk` is whether "Don't ask again" was ticked. */
  onStart: (dontAsk: boolean) => void;
  onCancel: () => void;
}

/**
 * Asked before a team (or one of its agents) starts while another team is working: every agent spends the same plan.
 * It opens on Cancel, so Enter never starts anything by accident; Escape cancels too.
 */
export function TeamWarning({ teams, onStart, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
    cancel.current?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className="revert-dialog team-warning"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="revert-body">
        <div className="revert-title" id={titleId}>
          Before you start
        </div>
        <p className="team-warning-text">{teamWarning(teams)}</p>
        <label className="team-warning-ask">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Don't ask again
        </label>
        <div className="revert-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onStart(dontAsk)}>
            Start
          </button>
        </div>
      </div>
    </dialog>
  );
}
