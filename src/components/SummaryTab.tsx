import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChangedFile } from "../store";
import type { StepsSummary, SummaryRow } from "../lib/stepsSummary";

const FILES_SHOWN = 3;
const rangeKey = (r: { from: number; to: number }) => `${r.from}-${r.to}`;
const baseName = (path: string) => path.split("/").pop() ?? path;

/**
 * The right pane's Summary tab, in Step by step: the plan so far, a row per step (or reviewed file, evidence round,
 * fix), each with what its page says and the files it changed. A row opens its page in the chat.
 */
export function SummaryTab({ slot, summary, changed, running, onOpenPage }: { slot: string; summary: StepsSummary; changed: ChangedFile[]; running: boolean; onOpenPage: (page: string) => void }) {
  // The files each row changed, from the backend's per-turn changes: asked again as edits land or a turn ends.
  const [files, setFiles] = useState<Record<string, ChangedFile[]>>({});
  const ranges = summary.rows.flatMap((r) => (r.range ? [r.range] : []));
  const wanted = ranges.map(rangeKey).join(",");
  useEffect(() => {
    let live = true;
    // A range that can't be read has no files, rather than failing the rest.
    Promise.all(ranges.map((r) => api.changeSummary(slot, "turn", r.from, r.to).catch((): ChangedFile[] => []))).then((results) => {
      if (live) setFiles(Object.fromEntries(ranges.map((r, i) => [rangeKey(r), results[i]])));
    });
    return () => {
      live = false;
    };
  }, [slot, wanted, changed, running]);

  return (
    <div className="summary">
      {summary.headline && <div className="summary-headline">{summary.headline}</div>}
      <ol className="summary-rows">
        {summary.rows.map((row) => (
          <Row key={row.id} row={row} files={row.range ? (files[rangeKey(row.range)] ?? null) : null} onOpenPage={onOpenPage} />
        ))}
      </ol>
    </div>
  );
}

function Row({ row, files, onOpenPage }: { row: SummaryRow; files: ChangedFile[] | null; onOpenPage: (page: string) => void }) {
  const state = row.current ? "current" : row.built ? "built" : "planned";
  return (
    <li className={`summary-row ${state}`} data-kind={row.kind}>
      <button className="summary-main" aria-current={row.current ? "step" : undefined} onClick={() => onOpenPage(row.page)} title={`Open ${row.label} in the chat`}>
        <span className="summary-mark" aria-hidden />
        <span className="summary-text">
          <span className="summary-label">
            {row.label}
            <span className="sr-only"> ({row.current ? "now" : row.built ? "done" : "planned, not built yet"})</span>
          </span>
          {row.title && <span className="summary-title">{row.title}</span>}
          {row.gist && <span className="summary-gist">{row.gist}</span>}
          <Meta row={row} files={files} />
        </span>
      </button>
      {row.planPage && (
        <button className="summary-plan-link" onClick={() => onOpenPage(row.planPage!)} title={`Open ${row.label}'s plan in the chat`}>
          Plan
        </button>
      )}
    </li>
  );
}

/** What a row adds under its text: a reviewed file's findings and size, or the files a step changed. */
function Meta({ row, files }: { row: SummaryRow; files: ChangedFile[] | null }) {
  if (row.kind === "file") {
    return (
      <span className="summary-meta">
        {row.findings && <span className={`summary-findings${row.findings.count ? " some" : ""}`}>{row.findings.count ? `${row.findings.count} finding${row.findings.count === 1 ? "" : "s"}` : "No findings"}</span>}
        {row.stats && (
          <span className="summary-stats">
            <span className="add">+{row.stats.added}</span> <span className="del">−{row.stats.removed}</span>
          </span>
        )}
      </span>
    );
  }
  if (!row.changes) return null;
  // Earlier turns of a reopened chat have no per-turn changes to read, and a step still being built has none yet.
  if (!row.range) return row.built ? <span className="summary-meta muted">Changes not available for this step</span> : null;
  if (files === null || files.length === 0) return files ? <span className="summary-meta muted">No files changed</span> : null;
  return (
    <span className="summary-meta">
      {files.slice(0, FILES_SHOWN).map((f) => (
        <span key={f.path} className="summary-file" title={f.path}>
          {baseName(f.path)} <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
        </span>
      ))}
      {files.length > FILES_SHOWN && <span className="summary-file muted">+{files.length - FILES_SHOWN} more</span>}
    </span>
  );
}
