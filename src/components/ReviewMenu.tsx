import { useState } from "react";
import { useChatState, useNodeActions } from "../lib/canvasContext";
import { usePopover } from "../lib/usePopover";

/**
 * The team's review setting as two switches: Review and test what an agent builds, and Tidy up reviewers after they report.
 * Rows of a menu, so the canvas's overflow menu can show them too. The second only means something while the first is on.
 */
export function ReviewRows({ main }: { main: string }) {
  const lead = useChatState(main);
  const actions = useNodeActions();
  if (!lead) return null;
  const { review } = lead;
  return (
    <>
      <button role="menuitemcheckbox" aria-checked={review.on} className={review.on ? "current" : undefined} onClick={() => actions.setReview(main, { ...review, on: !review.on })}>
        <span className="team-text">
          <span className="team-name">Review and test what an agent builds</span>
          <span className="team-line">A Reviewer (and a tester) checks a Builder's committed work by itself. The Lead gets one note; nothing is merged for you.</span>
        </span>
        <span className="switch-state" aria-hidden>
          {review.on ? "On" : "Off"}
        </span>
      </button>
      <button role="menuitemcheckbox" aria-checked={review.tidy} className={review.tidy ? "current" : undefined} onClick={() => actions.setReview(main, { ...review, tidy: !review.tidy })}>
        <span className="team-text">
          <span className="team-name">Tidy up reviewers after they report</span>
          <span className="team-line">They close themselves and their copy of the code is removed. Off: they stay for you to read.</span>
        </span>
        <span className="switch-state" aria-hidden>
          {review.tidy ? "On" : "Off"}
        </span>
      </button>
    </>
  );
}

/** The team's review setting, in the canvas controls beside Subagents: "Review: On" or "Review: Off". */
export function ReviewMenu({ main }: { main: string }) {
  const [open, setOpen] = useState(false);
  const lead = useChatState(main);
  const { box, button, list, id } = usePopover(open, () => setOpen(false));
  if (!lead) return null;
  return (
    <div className="canvas-team" ref={box}>
      <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} title="Whether a Reviewer (and tester) checks what a Builder builds, by itself" onClick={() => setOpen(!open)}>
        Review: {lead.review.on ? "On" : "Off"}
      </button>
      {open && (
        <div id={id} ref={list} className="canvas-team-list subagents-list" role="menu" aria-label="Review and test">
          <ReviewRows main={main} />
        </div>
      )}
    </div>
  );
}
