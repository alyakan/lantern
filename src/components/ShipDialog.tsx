import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ChangedFile } from "../store";
import type { ShipInfo } from "../types";
import { usePersistentState } from "../lib/layout";
import { buildShipPrompt, draftCommitMessage, draftPrBody, initialTicks, rememberTicks, shipAvailability, shipProblem, type SavedTicks, type ShipDraft, type ShipSteps } from "../lib/ship";

interface Props {
  folder: string;
  /** The chat's title: the commit message starts from it when it reads like a change. */
  title: string | null;
  /** What this chat changed. */
  files: ChangedFile[];
  /** Claude is in the middle of a turn: the message would only queue, so Ship waits. */
  running: boolean;
  /** Sends the message to Claude. */
  onSend: (text: string) => void;
  onClose: () => void;
}

/** Nothing is known about a folder whose look failed: no branch, no remote, no gh. */
const UNKNOWN: ShipInfo = { branch: null, remote: null, remote_url: null, github: false, gh: false, base: null };

/**
 * Ship it: commit, push and open a pull request with one confirmation. Each step has a checkbox and the text Claude will
 * use, which can be edited; Ship sends Claude one message (shown under "What will be sent"), and Claude asks to allow each
 * command as it always does. Lantern itself runs nothing but a read-only look at the repository.
 */
export function ShipDialog({ folder, title, files, running, onSend, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [info, setInfo] = useState<ShipInfo | null>(null);
  const [lookError, setLookError] = useState<string | null>(null);
  const [saved, setSaved] = usePersistentState<Record<string, SavedTicks>>("ship.ticksByFolder", {});
  // What the user changed; everything else follows what the repository says.
  const [edits, setEdits] = useState<Partial<ShipSteps>>({});
  const first = useMemo(() => draftCommitMessage(title, files, folder), [title, files, folder]);
  const [commitMessage, setCommitMessage] = useState(first);
  const [prTitle, setPrTitle] = useState(first);
  const [prBody, setPrBody] = useState(() => draftPrBody(files, folder));
  const [baseEdit, setBaseEdit] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  useEffect(() => {
    let live = true;
    api.shipInfo(folder).then(
      (found) => live && setInfo(found),
      (e) => {
        if (!live) return;
        setLookError(String(e instanceof Error ? e.message : e));
        setInfo(UNKNOWN);
      },
    );
    return () => {
      live = false;
    };
  }, [folder]);

  const avail = shipAvailability(info);
  const looked = info !== null;
  const start = initialTicks(avail, saved[folder]);
  const ticks: ShipSteps = { commit: edits.commit ?? start.commit, push: avail.push.ok && (edits.push ?? start.push), pr: avail.pr.ok && (edits.pr ?? start.pr) };
  const draft: ShipDraft = { commitMessage, prTitle, prBody, base: baseEdit ?? info?.base ?? "" };
  const target = { branch: info?.branch ?? null, remote: info?.remote ?? null };
  const problem = shipProblem(ticks, draft);
  const prompt = buildShipPrompt(ticks, draft, target);
  const blocked = running ? "Wait for Claude to finish." : !looked ? "Looking at the repository…" : problem;

  const tick = (key: keyof ShipSteps, on: boolean) => setEdits((e) => ({ ...e, [key]: on }));
  const ship = () => {
    if (blocked) return;
    setSaved({ ...saved, [folder]: rememberTicks(saved[folder], ticks, avail) });
    onClose();
    onSend(prompt);
  };

  return (
    <dialog
      ref={ref}
      className="revert-dialog ship-dialog"
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
          ship();
        }}
      >
        <div className="revert-title" id={titleId}>
          Ship it
        </div>
        <p className="revert-text">Tick the steps you want. Claude does them in this order, one after another. Claude will ask you to allow each command.</p>
        {lookError && (
          <div className="revert-error" role="alert">
            Couldn't look at the repository: {lookError}
          </div>
        )}

        <div className="ship-scroll">
        <div className="ship-steps">
          <section className="ship-step" aria-label="Commit the changes">
            <label className="ship-step-head">
              <input type="checkbox" checked={ticks.commit} onChange={(e) => tick("commit", e.target.checked)} />
              <span className="ship-step-name">Commit the changes</span>
            </label>
            {ticks.commit && (
              <label className="ship-field">
                <span className="ship-field-label">Commit message</span>
                <textarea rows={3} value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} aria-label="Commit message" spellCheck />
              </label>
            )}
          </section>

          <section className="ship-step" aria-label="Push the branch">
            <label className="ship-step-head">
              <input type="checkbox" checked={ticks.push} disabled={!avail.push.ok} onChange={(e) => tick("push", e.target.checked)} />
              <span className="ship-step-name">Push the branch</span>
            </label>
            {avail.push.ok && info?.branch && (
              <div className="ship-detail">
                Sends <code>{info.branch}</code> to <code>{info.remote}</code>
                {info.remote_url && <span className="ship-url"> ({info.remote_url})</span>}
              </div>
            )}
            {avail.push.ok && avail.onMain && (
              <div className="ship-warning" role="note">
                You're on {info?.branch}. Pushing from here goes straight to the project's main line, so this is off unless you tick it.
              </div>
            )}
            {!avail.push.ok && <div className="ship-why">{avail.push.reason}</div>}
          </section>

          <section className="ship-step" aria-label="Open a pull request">
            <label className="ship-step-head">
              <input type="checkbox" checked={ticks.pr} disabled={!avail.pr.ok} onChange={(e) => tick("pr", e.target.checked)} />
              <span className="ship-step-name">Open a pull request</span>
            </label>
            {!avail.pr.ok && <div className="ship-why">{avail.pr.reason}</div>}
            {ticks.pr && (
              <>
                <label className="ship-field">
                  <span className="ship-field-label">Title</span>
                  <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} aria-label="Pull request title" spellCheck />
                </label>
                <label className="ship-field">
                  <span className="ship-field-label">Description</span>
                  <textarea rows={5} value={prBody} onChange={(e) => setPrBody(e.target.value)} aria-label="Pull request description" spellCheck />
                </label>
                <label className="ship-field ship-base">
                  <span className="ship-field-label">Goes into the branch</span>
                  <input value={draft.base} onChange={(e) => setBaseEdit(e.target.value)} aria-label="Branch the pull request goes into" spellCheck={false} />
                </label>
                {!ticks.push && <div className="ship-why">The branch has to be on the remote already: Claude won't push it for this step.</div>}
              </>
            )}
          </section>
        </div>

        <details className="ship-sent">
          <summary>What will be sent</summary>
          <pre className="ship-prompt" aria-label="The message Claude gets">
            {prompt}
          </pre>
        </details>
        </div>

        {blocked && looked && (
          <div className="ship-problem" role="status">
            {blocked}
          </div>
        )}
        <div className="revert-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!!blocked} title={blocked ?? "Send Claude one message with these steps"}>
            Ship
          </button>
        </div>
      </form>
    </dialog>
  );
}
