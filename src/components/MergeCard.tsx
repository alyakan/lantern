import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNodeActions } from "../lib/canvasContext";
import { testsHeadline } from "../lib/mergeTests";
import { SlotContext } from "../lib/slot";
import { useMergeTests } from "../lib/useMergeTests";
import type { MergeProposal } from "../store";
import { MergeTestsBar } from "./MergeTestsBar";

const FullDiff = lazy(() => import("./FullDiff"));

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
  // The files whose changes are opened under their names.
  const [opened, setOpened] = useState<string[]>([]);
  // Asked once more before merging over tests that failed (or are still going).
  const [confirming, setConfirming] = useState<"failed" | "running" | null>(null);
  const open = proposal.status === "open";
  const tests = useMergeTests(proposal.worker, open, [proposal.commits, proposal.files.length, proposal.uncommitted, proposal.attempts, proposal.problem]);
  const [removal, setRemoval] = useState<"idle" | "removing" | "done" | string>("idle");
  // Whatever came of an approval (merged, conflicts, a checkout with changes), the buttons come back to answer again.
  useEffect(() => {
    setBusy(false);
    setConfirming(null);
  }, [proposal.status, proposal.problem, proposal.attempts]);

  if (proposal.status === "declined") {
    // The user's own "not yet" stays until the lead proposes again; a proposal that changed under them says why it went.
    return (
      <div className="merge-card quiet" role="status">
        {proposal.problem ? `Not merged: ${proposal.branch}. ${proposal.problem} The Lead can ask again.` : "You said not yet; the lead was told."}
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

  const approve = () => {
    setBusy(true);
    actions.approveMerge(proposal.worker);
  };
  // Tests that passed, never ran, or are out of date (the branch changed since) don't stand in the way. Ones still going
  // or that failed on this very branch ask once more first.
  const onApprove = () => {
    const last = tests.info?.last;
    if (tests.going) return setConfirming("running");
    if (!last || last.stale || last.result === "passed") return approve();
    // Looked at again first: a worker may have fixed the branch since the user last looked at the card.
    void tests.refresh().then((fresh) => {
      const now = fresh ?? tests.info;
      if (now?.running) setConfirming("running");
      else if (now?.last && !now.last.stale && now.last.result !== "passed") setConfirming("failed");
      else approve();
    });
  };
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
          {proposal.files.slice(0, FILES_SHOWN).map((f) => {
            const shown = opened.includes(f.path);
            return (
              <li key={f.path} className="merge-file-item">
                <button
                  className="merge-fold"
                  aria-expanded={shown}
                  aria-label={`${shown ? "Hide" : "Show"} the changes in ${f.path}`}
                  onClick={() => setOpened(shown ? opened.filter((p) => p !== f.path) : [...opened, f.path])}
                >
                  <span className="chev" aria-hidden />
                </button>
                <button className="merge-file" title={`Open the diff of ${f.path} in the side panel`} onClick={() => actions.reviewMerge(proposal.worker, f.path)}>
                  {f.path}
                </button>
                <span className="merge-add">+{f.added}</span>
                <span className="merge-del">−{f.removed}</span>
                {shown && (
                  <div className="merge-diff">
                    {/* The worker's own chat is the one whose folder is the worktree the branch is in. */}
                    <SlotContext.Provider value={proposal.worker}>
                      <Suspense fallback={<div className="empty">Loading…</div>}>
                        <FullDiff path={f.path} refreshKey={proposal.commits + proposal.files.length} layout="inline" scope="branch" base={proposal.into} />
                      </Suspense>
                    </SlotContext.Provider>
                  </div>
                )}
              </li>
            );
          })}
          {proposal.files.length > FILES_SHOWN && <li className="merge-more">and {proposal.files.length - FILES_SHOWN} more</li>}
        </ul>
      )}
      {proposal.summary && (
        <p className="merge-summary">
          <span className="merge-from">The Lead says:</span> {proposal.summary}
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
      <MergeTestsBar tests={tests} />
      {proposal.problem && <p className="merge-problem" role="alert">{proposal.problem}</p>}
      {confirming ? (
        <div
          className="merge-confirm"
          role="alertdialog"
          aria-label={confirming === "failed" ? "Tests failed: merge anyway?" : "Tests are still running: merge anyway?"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setConfirming(null);
            }
          }}
        >
          <p className="merge-problem">
            {confirming === "failed" ? "Tests failed: merge anyway?" : "The tests are still running: merge anyway?"}
          </p>
          <p className="merge-note">
            {confirming === "failed" && tests.info?.last ? `${testsHeadline(tests.info.last)}. ` : ""}
            {confirming === "running" ? "Merging stops them. " : ""}Only merge over this if you know why.
          </p>
          <div className="merge-actions">
            <button autoFocus onClick={() => setConfirming(null)}>
              Go back
            </button>
            <button
              className="merge-approve"
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                approve();
              }}
            >
              Merge anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="merge-actions">
          <button className="merge-review" onClick={() => actions.reviewMerge(proposal.worker)}>
            Review diff
          </button>
          <button className="merge-approve" disabled={busy || declining} onClick={onApprove}>
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
      )}
    </div>
  );
}
