import { useEffect, useRef, useState } from "react";
import { useNodeActions } from "../lib/canvasContext";
import type { MergeProposal } from "../store";

const FILES_SHOWN = 6;
/** A card drawn within this long of arriving is a new one: it rings, and is scrolled to. */
const NEW_MS = 2000;

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

/**
 * A worker's branch the main agent asks the user to merge: what it adds, and the two answers. Only the user can approve
 * it; the main agent can ask. Once merged it offers to clear the worker's worktree away.
 */
export function MergeCard({ proposal }: { proposal: MergeProposal }) {
  const actions = useNodeActions();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  // Not an old one drawn again (the canvas swapping a card for a chat and back).
  const card = useRef<HTMLDivElement>(null);
  const [arrived] = useState(() => proposal.status === "open" && proposal.at !== undefined && Date.now() - proposal.at < NEW_MS);
  useEffect(() => {
    if (arrived) card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [arrived]);
  const [showFiles, setShowFiles] = useState(false);
  const [removal, setRemoval] = useState<"idle" | "removing" | "done" | string>("idle");
  // Whatever came of an approval (merged, conflicts, a checkout with changes), the buttons come back to answer again.
  useEffect(() => setBusy(false), [proposal.status, proposal.problem, proposal.attempts]);

  if (proposal.status === "declined") {
    // The user's own "not yet" stays until the lead proposes again; a proposal that changed under them says why it went.
    return (
      <div className="merge-card quiet" role="status">
        {proposal.problem ? `Not merged: ${proposal.branch}. ${proposal.problem} The main agent can ask again.` : "You said not yet; the lead was told."}
      </div>
    );
  }
  if (proposal.status === "merged") {
    return (
      <div className="merge-card quiet" role="status">
        <span>
          <span className="merge-check" aria-hidden>
            ✓
          </span>{" "}
          Merged {proposal.branch} into {proposal.into}.
        </span>
        {removal === "done" ? (
          <span>Worktree removed.</span>
        ) : (
          <button
            disabled={removal === "removing"}
            onClick={() => {
              setRemoval("removing");
              actions.removeWorktree(proposal.worker).then(
                () => setRemoval("done"),
                (e) => setRemoval(errText(e)),
              );
            }}
          >
            {removal === "removing" ? "Removing…" : "Remove worktree"}
          </button>
        )}
        {removal !== "idle" && removal !== "removing" && removal !== "done" && <span className="merge-problem">{removal}</span>}
      </div>
    );
  }

  const added = proposal.files.reduce((n, f) => n + f.added, 0);
  const removed = proposal.files.reduce((n, f) => n + f.removed, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div ref={card} className={`merge-card${arrived ? " arrive" : ""}`} role="group" aria-label={`Merge ${proposal.branch}`}>
      <div className="merge-title">
        Merge <code>{proposal.branch}</code> into <code>{proposal.into}</code>?
      </div>
      <div className="merge-facts">
        {plural(proposal.commits, "commit")} · {plural(proposal.files.length, "file")}
        <span className="merge-add"> +{added}</span>
        <span className="merge-del"> −{removed}</span>
        {proposal.files.length > 0 && (
          <button className="merge-link" aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}>
            {showFiles ? "Hide files" : "Show files"}
          </button>
        )}
      </div>
      {showFiles && (
        <ul className="merge-files">
          {proposal.files.slice(0, FILES_SHOWN).map((f) => (
            <li key={f.path}>
              <button className="merge-file" title={`Open the diff of ${f.path}`} onClick={() => actions.reviewMerge(proposal.worker, f.path)}>
                {f.path}
              </button>
              <span className="merge-add">+{f.added}</span>
              <span className="merge-del">−{f.removed}</span>
            </li>
          ))}
          {proposal.files.length > FILES_SHOWN && <li className="merge-more">and {proposal.files.length - FILES_SHOWN} more</li>}
        </ul>
      )}
      {proposal.summary && (
        <p className="merge-summary">
          <span className="merge-from">The main agent says:</span> {proposal.summary}
        </p>
      )}
      {proposal.loose.length > 0 && (
        <div className="merge-note">
          {plural(proposal.loose.length, "file")} of loose work in its worktree will be committed first, so nothing is lost:
          <ul className="merge-files merge-loose">
            {proposal.loose.slice(0, FILES_SHOWN).map((name) => (
              <li key={name}>
                <span title={name}>{name}</span>
              </li>
            ))}
            {proposal.loose.length > FILES_SHOWN && <li className="merge-more">and {proposal.loose.length - FILES_SHOWN} more</li>}
          </ul>
        </div>
      )}
      {proposal.problem && <p className="merge-problem" role="alert">{proposal.problem}</p>}
      <div className="merge-actions">
        <button className="merge-review" onClick={() => actions.reviewMerge(proposal.worker)}>
          Review diff
        </button>
        <button
          className="merge-approve"
          disabled={busy || declining}
          onClick={() => {
            setBusy(true);
            actions.approveMerge(proposal.worker);
          }}
        >
          {busy ? "Merging…" : proposal.problem ? "Try again" : "Approve merge"}
        </button>
        <button
          disabled={busy || declining}
          onClick={() => {
            setDeclining(true);
            Promise.resolve(actions.declineMerge(proposal.worker)).finally(() => setDeclining(false));
          }}
        >
          {declining ? "Sending…" : "Not yet"}
        </button>
      </div>
    </div>
  );
}
