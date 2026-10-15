import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChangedFile } from "../store";
import type { StepsSummary, SummaryRow } from "../lib/stepsSummary";
import { exportFileName, planMarkdown } from "../lib/planExport";
import type { StepPage } from "../lib/steps";
import { SummaryExport } from "./SummaryExport";
import { RevertDialog } from "./RevertDialog";
import type { RevertControls, RevertRequest } from "../lib/revert";

const FILES_SHOWN = 3;
const rangeKey = (r: { from: number; to: number }) => `${r.from}-${r.to}`;
/** What a step's range came to: its files, or that they couldn't be read. */
type Lookup = { files: ChangedFile[] } | { error: true };
const baseName = (path: string) => path.split("/").pop() ?? path;

/** A line of a step's text with its `code` shown as code. A backtick left open by a cut is dropped. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part.replace(/`/g, "")))}
    </>
  );
}

/** What the plan is exported from, besides the summary: the pages in full, the chat's title and its folder. */
export interface ExportDoc {
  pages: StepPage[];
  title: string;
  folder: string | null;
}

/**
 * The right pane's Summary tab, in Step by step: the plan so far, a row per step (or reviewed file, evidence round,
 * fix), each with what its page says and the files it changed. A row opens its page in the chat. With `doc`, the plan
 * can be exported as markdown.
 */
export function SummaryTab({ slot, summary, changed, running, onOpenPage, doc, revert }: { slot: string; summary: StepsSummary; changed: ChangedFile[]; running: boolean; onOpenPage: (page: string) => void; doc?: ExportDoc; revert?: RevertControls }) {
  // The files each row changed, from the backend's per-turn changes: asked again as edits land or a turn ends, and
  // again when the user tries again after a failure.
  const [files, setFiles] = useState<Record<string, Lookup>>({});
  const [attempt, setAttempt] = useState(0);
  // A step's revert waiting on its dialog.
  const [reverting, setReverting] = useState<{ title: string; files: ChangedFile[]; request: RevertRequest } | null>(null);
  const ranges = summary.rows.flatMap((r) => (r.range ? [r.range] : []));
  const wanted = ranges.map(rangeKey).join(",");
  useEffect(() => {
    let live = true;
    // A range that can't be read is marked as such, rather than failing the rest or passing for no changes.
    Promise.all(ranges.map((r) => api.changeSummary(slot, "turn", r.from, r.to).then((found): Lookup => ({ files: found }), (): Lookup => ({ error: true })))).then((results) => {
      if (live) setFiles(Object.fromEntries(ranges.map((r, i) => [rangeKey(r), results[i]])));
    });
    return () => {
      live = false;
    };
  }, [slot, wanted, changed, running, attempt]);
  const failed = Object.values(files).some((l) => "error" in l);
  // The files a row changed, once read: undefined while they're being read, or when they couldn't be.
  const filesOf = (row: SummaryRow): ChangedFile[] | undefined => {
    const lookup = row.range ? files[rangeKey(row.range)] : undefined;
    return lookup && "files" in lookup ? lookup.files : undefined;
  };

  // A row's revert: the files its turns changed, put back to how they were before them. Off when its turns aren't known.
  const revertOf = (row: SummaryRow) => {
    if (!revert || !row.changes) return undefined;
    const range = row.range;
    if (!range) return { off: "This step's changes aren't known: the chat was reopened after it.", onRevert: () => {} };
    const found = filesOf(row);
    if (!found || found.length === 0) return undefined;
    return { off: revert.blocked, onRevert: () => setReverting({ title: `Revert ${row.label}?`, files: found, request: { scope: "turn", turn: range.from, toTurn: range.to } }) };
  };

  // The document is made when it's asked for, from what the tab knows then.
  const markdown = (results: boolean) =>
    planMarkdown({
      pages: doc!.pages,
      summary,
      files: Object.fromEntries(
        summary.rows.flatMap((r) => {
          const f = filesOf(r);
          return f ? [[r.id, f] as const] : [];
        }),
      ),
      title: doc!.title,
      folder: doc!.folder,
      date: new Date(),
      results,
    });

  return (
    <div className="summary">
      <div className="summary-head">
        {summary.headline && <div className="summary-headline">{summary.headline}</div>}
        {doc && <SummaryExport markdown={markdown} fileName={exportFileName(doc.folder, new Date())} />}
      </div>
      {failed && (
        <div className="summary-retry" role="alert">
          Couldn't read the files some steps changed.{" "}
          <button className="link-button" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      )}
      <ol className="summary-rows">
        {summary.rows.map((row) => (
          <Row key={row.id} row={row} lookup={row.range ? files[rangeKey(row.range)] : undefined} onOpenPage={onOpenPage} revert={revertOf(row)} />
        ))}
      </ol>
      {reverting && revert && (
        <RevertDialog
          slot={slot}
          folder={doc?.folder ?? null}
          title={reverting.title}
          files={reverting.files}
          request={reverting.request}
          latestTurn={revert.latestTurn}
          onCancel={() => setReverting(null)}
          onDone={(outcomes) => {
            const request = reverting.request;
            setReverting(null);
            revert.onReverted(request, outcomes);
          }}
        />
      )}
    </div>
  );
}

function Row({ row, lookup, onOpenPage, revert }: { row: SummaryRow; lookup: Lookup | undefined; onOpenPage: (page: string) => void; revert?: { off: string | null; onRevert: () => void } }) {
  // Steps the plan has no page for: shown so the numbers add up, but with nothing to open.
  if (row.kind === "gap") {
    return (
      <li className="summary-row gap" data-kind="gap">
        <div className="summary-main">
          <span className="summary-mark" aria-hidden />
          <span className="summary-text">
            <span className="summary-label">{row.label}</span>
            <span className="summary-title">{row.title}</span>
            {row.gist && <span className="summary-gist">{row.gist}</span>}
          </span>
        </div>
      </li>
    );
  }
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
          {row.title && (
            <span className="summary-title">
              <Inline text={row.title} />
            </span>
          )}
          {row.gist && (
            <span className="summary-gist">
              <Inline text={row.gist} />
            </span>
          )}
          <Meta row={row} lookup={lookup} />
        </span>
      </button>
      {row.planPage && (
        <button className="summary-plan-link" onClick={() => onOpenPage(row.planPage!)} title={`Open ${row.label}'s plan in the chat`}>
          Plan
        </button>
      )}
      {revert && (
        <button className="summary-plan-link summary-revert" disabled={!!revert.off} title={revert.off ?? `Put the files ${row.label} changed back to how they were before it`} onClick={revert.onRevert}>
          Revert
        </button>
      )}
    </li>
  );
}

/** What a row adds under its text: a reviewed file's findings and size, or the files a step changed. */
function Meta({ row, lookup }: { row: SummaryRow; lookup: Lookup | undefined }) {
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
  if (!lookup) return null;
  if ("error" in lookup) return <span className="summary-meta muted">Couldn't read this step's changes</span>;
  const { files } = lookup;
  if (files.length === 0) return <span className="summary-meta muted">No files changed</span>;
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
