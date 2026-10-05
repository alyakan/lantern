import { useState } from "react";
import { Md } from "./Md";
import { describeStep, editsIn, failedCount, runningStep, stepTarget, summarize, type Entry, type Step } from "../lib/activity";
import { ChatStream, type StreamHandlers } from "./ChatStream";
import type { EditInfo } from "../store";
import { countChanges } from "../lib/diff";
import { runSummary } from "../lib/testRuns";
import { Counts, EditLine } from "./EditLine";
import { FailIcon, HudCheckIcon } from "./icons";
import { PermissionCard } from "./PermissionCard";

interface Props extends StreamHandlers {
  steps: Step[];
  /** The full timeline shown when expanded; defaults to just the steps. */
  entries?: Entry[];
  /** The turn is still going: one line that updates in place with what is happening now. */
  live?: boolean;
  /** What the line says between steps when there's nothing to tally yet. The turn's word ("Pondering…") shows on
   * the line at the bottom of the chat, so between steps this line shows the work so far instead. */
  verb?: string;
  folder: string | null;
}

// A turn's work in one line, like Warp: while the agent works, the line shows the current step in place of a
// growing list; afterwards it becomes a summary ("Used 2 skills, ran 5 commands") that expands to the timeline.
export function ActivityGroup({ steps, entries = steps, live = false, verb = "Working…", folder, ...handlers }: Props) {
  const [open, setOpen] = useState(false);
  const current = runningStep(steps);
  const failed = failedCount(steps);
  const edits = editsIn(steps);
  const narrated = entries.length > steps.length;
  const summary = summarize(steps) || (narrated ? summarize(steps, true) : "");
  const working = live || current !== null;
  return (
    <div className={`activity${working ? " live" : ""}`}>
      {(summary || working) && (
        <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden />
          {working && <span className="spinner" aria-hidden />}
          <span className="activity-text">{working ? (current ? describeStep(current, folder) : summary || verb) : summary}</span>
          {working && steps.length > 1 && <span className="activity-count">{`${steps.length} steps`}</span>}
          {failed > 0 && <span className="failed">{failed} failed</span>}
        </button>
      )}
      {open && (
        <div className="steps">
          {entries.map((e) =>
            e.type === "tool" ? (
              <StepRow key={e.id} step={e} folder={folder} {...handlers} />
            ) : e.type === "assistant" ? (
              <div key={e.id} className="step-note">
                <Md>
                  {e.text}
                </Md>
              </div>
            ) : (
              <PermissionCard key={e.id} item={e} onDecide={handlers.onDecide} />
            ),
          )}
        </div>
      )}
      {edits.length > 0 && <FileChanges edits={edits.map((e) => e.edit)} folder={folder} onOpen={handlers.onOpenFile} />}
      {handlers.testRunFor &&
        steps.map((s) => {
          const t = handlers.testRunFor?.(s.id);
          return (
            t && (
              <button key={`test-${s.id}`} className={`activity-line test-chip ${t.run.outcome}`} title={`${t.command}\nShow in the Tests tab`} onClick={() => handlers.onOpenTestRun?.(t.id)}>
                {t.run.outcome === "failed" ? <FailIcon /> : t.run.outcome === "passed" ? <HudCheckIcon /> : null}
                <span className="activity-text">{`Tests: ${runSummary(t.run)}`}</span>
              </button>
            )
          );
        })}
    </div>
  );
}

/** One line per file, with every edit to it added up. */
function byFile(edits: EditInfo[]): { edit: EditInfo; added: number; removed: number }[] {
  const files = new Map<string, { edit: EditInfo; added: number; removed: number }>();
  for (const e of edits) {
    const { added, removed } = countChanges(e.hunks);
    const f = files.get(e.path);
    if (f) files.set(e.path, { edit: { ...f.edit, created: f.edit.created || e.created }, added: f.added + added, removed: f.removed + removed });
    else files.set(e.path, { edit: e, added, removed });
  }
  return [...files.values()];
}

// The turn's changed files as one collapsed line ("2 files changed +18 −6") that expands to a line per file.
function FileChanges({ edits, folder, onOpen }: { edits: EditInfo[]; folder: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const files = byFile(edits);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <>
      <button className="activity-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        <span className="activity-text">{`${files.length} file${files.length === 1 ? "" : "s"} changed`}</span>
        <Counts added={added} removed={removed} />
      </button>
      {open && (
        <div className="file-changes">
          {files.map((f) => (
            <EditLine key={f.edit.path} edit={f.edit} counts={f} folder={folder} onOpen={onOpen} />
          ))}
        </div>
      )}
    </>
  );
}

function StepRow({ step, folder, ...handlers }: { step: Step; folder: string | null } & StreamHandlers) {
  const [open, setOpen] = useState(false);
  const hasChildren = step.children.length > 0;
  const expandable = hasChildren || !!step.output;
  return (
    <div className={`step step-${step.status}`}>
      <button className="step-line" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(!open)}>
        <span className="step-name">{step.name}</span>
        <span className="step-target">{stepTarget(step, folder)}</span>
        {step.status === "running" && <span className="spinner" aria-hidden />}
      </button>
      {open && hasChildren && (
        <div className="step-children">
          <ChatStream items={step.children} folder={folder} live={step.status === "running"} {...handlers} />
        </div>
      )}
      {open && !hasChildren && step.output && <pre className="step-output">{step.output}</pre>}
    </div>
  );
}
