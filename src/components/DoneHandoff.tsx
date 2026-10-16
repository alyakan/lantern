import type { ChangedFile } from "../store";
import type { StepsSummary } from "../lib/stepsSummary";
import { exportFileName } from "../lib/planExport";
import { SummaryExport } from "./SummaryExport";
import { useStepFiles, type ExportDoc } from "./SummaryTab";

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
  /** Opens Ship it: commit, push and a pull request, each ticked and edited first. */
  onShip: () => void;
}

/**
 * The end of a Build: what to do with the work. Ship it opens a dialog that sends Claude one message once the user has
 * confirmed it; `onSend` is missing while Claude is busy or the page isn't the newest, which leaves Ship it off.
 */
export function DoneHandoff({ handoff, onSend }: { handoff: Handoff; onSend?: (text: string) => void }) {
  const count = handoff.changed.length;
  return (
    <section className="handoff" aria-label="What next">
      <div className="handoff-heading">What next?</div>
      <div className="handoff-actions">
        <button className="primary" onClick={handoff.onReviewChanges} title="Open the side panel on everything this chat changed">
          Review the changes{count > 0 ? ` (${count})` : ""}
        </button>
        <button disabled={!onSend} title={onSend ? "Commit, push and open a pull request: you check each step first" : "Wait for Claude to finish"} onClick={handoff.onShip}>
          Ship it…
        </button>
        {handoff.summary && <PlanExport handoff={handoff} summary={handoff.summary} />}
        <button onClick={handoff.onStartNew} title="Start a new chat in this project">
          Start something new
        </button>
      </div>
    </section>
  );
}

/** The Summary tab's Export, on the page: it reads the files each step changed the same way. */
function PlanExport({ handoff, summary }: { handoff: Handoff; summary: StepsSummary }) {
  const { markdown } = useStepFiles(handoff.slot, summary, handoff.changed, handoff.running, handoff.doc);
  return <SummaryExport markdown={markdown} fileName={exportFileName(handoff.doc.folder, new Date())} label="Export the plan" className="handoff-export" />;
}
