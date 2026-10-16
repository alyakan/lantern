import { useLayoutEffect, useRef } from "react";
import type { RunTask } from "../store";
import { cleanOutput, lastLines } from "../lib/shell";
import { ExternalLink } from "./ExternalLink";

/** How many lines of what the command printed the panel shows. */
export const RUN_LINES = 40;

const STATUS: Record<RunTask["status"], string> = { running: "Running", stopped: "Stopped", failed: "Failed" };

/**
 * The project's Run command, started from an agent's Run button: its state, the end of what it printed, Stop and Restart,
 * and the address it printed when that is on this computer (opened in the browser). Only the user starts it; closing the panel
 * stops it.
 */
export function RunPanel({ run, onStop, onRestart, onClose }: { run: RunTask; onStop: () => void; onRestart: () => void; onClose: () => void }) {
  const shown = lastLines(cleanOutput(run.output), RUN_LINES).text;
  // Follows the output as it comes, unless the user scrolled up in it.
  const pre = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    if (atEnd.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown]);
  const running = run.status === "running";
  return (
    <div className={`run-panel ${run.status}`} role="group" aria-label="Run">
      <div className="run-head">
        <span className={`run-status ${run.status}`} role="status">
          {STATUS[run.status]}
          {run.status === "failed" && run.code !== null ? ` (exit ${run.code})` : ""}
        </span>
        <code className="run-command" title={run.command}>
          {run.command}
        </code>
        {run.url && (
          <ExternalLink className="run-url" href={run.url} title="Open in your browser">
            {run.url}
          </ExternalLink>
        )}
        <span className="run-actions">
          {running && <button onClick={onStop}>Stop</button>}
          <button onClick={onRestart}>Restart</button>
          <button className="icon" aria-label="Close the Run panel" title={running ? "Stops it and closes this" : "Close"} onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      {shown ? (
        <pre
          className="run-output"
          ref={pre}
          role="region"
          aria-label="What it printed"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {shown}
        </pre>
      ) : (
        running && <div className="run-wait">Waiting for it to print something…</div>
      )}
    </div>
  );
}
