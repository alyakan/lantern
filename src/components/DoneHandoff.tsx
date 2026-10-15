import { useState } from "react";
import type { ChangedFile } from "../store";
import type { StepsSummary } from "../lib/stepsSummary";
import { exportFileName } from "../lib/planExport";
import { SummaryExport } from "./SummaryExport";
import { useStepFiles, type ExportDoc } from "./SummaryTab";

/** What Commit… and Open a pull request… ask Claude, once the user has confirmed. Lantern runs no git itself. */
export const COMMIT_PROMPT = "Commit these changes with a clear message. Look at git status and the diff first, stage only what this work changed, and don't push.";
export const PR_PROMPT = "Open a pull request for this work. Push the branch if it isn't pushed yet, then create the pull request with a short title and a description of what changed and why, and tell me its link.";

const ASKS = {
  commit: { label: "Commit…", prompt: COMMIT_PROMPT, send: "Ask Claude to commit" },
  pr: { label: "Open a pull request…", prompt: PR_PROMPT, send: "Ask Claude to open it" },
};

/** What the Done page hands off to: the side panel, the plan's export, and a fresh chat. */
export interface Handoff {
  slot: string;
  /** The plan so far (null: nothing to export). */
  summary: StepsSummary | null;
  changed: ChangedFile[];
  doc: ExportDoc;
  running: boolean;
  /** Opens the side panel on Changes, with everything this chat changed. */
  onReviewChanges: () => void;
  /** A new chat in this project. */
  onStartNew: () => void;
}

/**
 * The end of a Build: what to do with the work. Commit and pull request are messages to Claude, which only go after a
 * click that confirms them (the prompt is shown); `onSend` is missing while Claude is busy or the page isn't the newest.
 */
export function DoneHandoff({ handoff, onSend }: { handoff: Handoff; onSend?: (text: string) => void }) {
  const [asking, setAsking] = useState<keyof typeof ASKS | null>(null);
  const ask = asking ? ASKS[asking] : null;
  const count = handoff.changed.length;
  return (
    <section className="handoff" aria-label="What next">
      <div className="handoff-heading">What next?</div>
      <div className="handoff-actions">
        <button className="primary" onClick={handoff.onReviewChanges} title="Open the side panel on everything this chat changed">
          Review the changes{count > 0 ? ` (${count})` : ""}
        </button>
        {(Object.keys(ASKS) as (keyof typeof ASKS)[]).map((key) => (
          <button key={key} aria-expanded={asking === key} disabled={!onSend} title={onSend ? "Asks Claude, after you confirm" : "Wait for Claude to finish"} onClick={() => setAsking(asking === key ? null : key)}>
            {ASKS[key].label}
          </button>
        ))}
        {handoff.summary && <PlanExport handoff={handoff} summary={handoff.summary} />}
        <button onClick={handoff.onStartNew} title="Start a new chat in this project">
          Start something new
        </button>
      </div>
      {ask && onSend && (
        <div className="handoff-confirm" role="group" aria-label={`Confirm: ${ask.label}`}>
          <div className="handoff-confirm-label">Lantern will send Claude:</div>
          <blockquote className="handoff-prompt">{ask.prompt}</blockquote>
          <div className="handoff-confirm-actions">
            <button
              className="primary"
              onClick={() => {
                setAsking(null);
                onSend(ask.prompt);
              }}
            >
              {ask.send}
            </button>
            <button className="ghost" onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The Summary tab's Export, on the page: it reads the files each step changed the same way. */
function PlanExport({ handoff, summary }: { handoff: Handoff; summary: StepsSummary }) {
  const { markdown } = useStepFiles(handoff.slot, summary, handoff.changed, handoff.running, handoff.doc);
  return <SummaryExport markdown={markdown} fileName={exportFileName(handoff.doc.folder, new Date())} label="Export the plan" className="handoff-export" />;
}
