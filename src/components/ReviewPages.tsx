import { useFileLinks } from "../lib/fileLinks";
import type { Finding, ReviewFile, Severity, Verdict } from "../lib/review";
import { DocIcon, HudCheckIcon } from "./icons";
import { Md } from "./Md";

const SEVERITY: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", nit: "Nit" };

/** "line 42" that opens the file there in the right pane, once the file is found in the folder. */
function LineChip({ path, finding }: { path: string | null; finding: Finding }) {
  const links = useFileLinks();
  if (finding.line === null) return null;
  const label = `line ${finding.line}${finding.lineEnd ? `–${finding.lineEnd}` : ""}`;
  const file = path && links ? links.resolve(path) : null;
  if (!file || !links) return <span className="finding-line">{label}</span>;
  return (
    <button className="finding-line link" title={`Open ${path} at line ${finding.line}`} onClick={() => links.open(file, finding.line)}>
      {label}
    </button>
  );
}

function FindingCard({ path, finding, verdict, onVerdict }: { path: string | null; finding: Finding; verdict: Verdict | undefined; onVerdict?: (v: Verdict | null) => void }) {
  const sev = finding.severity;
  return (
    <div className={`finding${sev ? ` sev-${sev}` : ""}${verdict ? ` verdict-${verdict}` : ""}`}>
      <div className="finding-head">
        {sev && <span className="finding-sev">{SEVERITY[sev]}</span>}
        <LineChip path={path} finding={finding} />
        <span className="spacer" />
        {onVerdict ? (
          <span className="finding-verdict" role="group" aria-label="Your verdict">
            <button className={verdict === "agree" ? "on" : ""} aria-pressed={verdict === "agree"} onClick={() => onVerdict(verdict === "agree" ? null : "agree")}>
              Agree
            </button>
            <button className={verdict === "reject" ? "on" : ""} aria-pressed={verdict === "reject"} onClick={() => onVerdict(verdict === "reject" ? null : "reject")}>
              Reject
            </button>
          </span>
        ) : (
          verdict && <span className="finding-verdict-done">{verdict === "agree" ? "Agreed" : "Rejected"}</span>
        )}
      </div>
      <div className="finding-text">
        <Md>{finding.text}</Md>
      </div>
    </div>
  );
}

/** A reviewed file: what changed, its findings as cards (or a clean result), and the notes. */
export function ReviewFileView({ file, verdicts, onVerdict }: { file: ReviewFile; verdicts: Record<number, Verdict> | undefined; onVerdict?: (index: number, v: Verdict | null) => void }) {
  return (
    <div className="review-file">
      {file.preface && (
        <div className="review-preface">
          <Md>{file.preface}</Md>
        </div>
      )}
      {file.changed && (
        <section className="review-section">
          <div className="review-section-title">What changed</div>
          <div className="review-changed">
            <Md>{file.changed}</Md>
          </div>
        </section>
      )}
      <section className="review-section">
        <div className="review-section-title">
          Findings{file.findings.length > 0 && <span className="tab-count">{file.findings.length}</span>}
        </div>
        {file.clean || file.findings.length === 0 ? (
          <div className="review-clean">
            <HudCheckIcon />
            No findings
          </div>
        ) : (
          file.findings.map((f) => <FindingCard key={f.index} path={file.path} finding={f} verdict={verdicts?.[f.index]} onVerdict={onVerdict && ((v) => onVerdict(f.index, v))} />)
        )}
      </section>
      {file.notes && (
        <section className="review-section">
          <div className="review-section-title">{file.clean ? "What I checked" : "Notes"}</div>
          <div className="review-notes">
            <Md>{file.clean ? file.notes.replace(/^\*\*What I checked:?\*\*:?\s*/i, "") : file.notes}</Md>
          </div>
        </section>
      )}
    </div>
  );
}

/** The page header for a reviewed file: its name, folder and counts. */
export function ReviewFileHeader({ path, added, removed }: { path: string; added: number | null; removed: number | null }) {
  const links = useFileLinks();
  const slash = path.lastIndexOf("/");
  const file = links?.resolve(path) ?? null;
  const name = <span className="review-file-name">{path.slice(slash + 1)}</span>;
  return (
    <div className="review-file-header">
      <DocIcon />
      {file && links ? (
        <button className="review-file-open" title={`Open ${path}`} onClick={() => links.open(file, null)}>
          {name}
        </button>
      ) : (
        name
      )}
      {slash > 0 && <span className="review-file-dir">{path.slice(0, slash)}</span>}
      {added !== null && (
        <span className="counts">
          <span className="added">+{added}</span>
          <span className="removed">−{removed}</span>
        </span>
      )}
    </div>
  );
}

export interface ReviewedFinding {
  path: string | null;
  finding: Finding;
  verdict: Verdict | undefined;
}

/** The summary page's table: every finding across the files, with its severity and your verdict. */
export function ReviewSummaryTable({ rows, onAction }: { rows: ReviewedFinding[]; onAction: (text: string) => void }) {
  const counts = (s: Severity) => rows.filter((r) => r.finding.severity === s).length;
  const agreed = rows.filter((r) => r.verdict === "agree").length;
  return (
    <div className="review-summary">
      <div className="review-summary-counts">
        {(["blocker", "should-fix", "nit"] as const).map((s) => (
          <span key={s} className={`finding-sev sev-${s}`}>
            {counts(s)} {SEVERITY[s].toLowerCase()}
          </span>
        ))}
        <span className="review-summary-agreed">{agreed} agreed</span>
      </div>
      {rows.length > 0 ? (
        <table className="review-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Line</th>
              <th>Finding</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.verdict === "reject" ? "rejected" : ""}>
                <td className="review-table-file">{r.path?.split("/").pop()}</td>
                <td>{r.finding.line ?? "–"}</td>
                <td>
                  {r.finding.severity && <span className={`finding-sev sev-${r.finding.severity}`}>{SEVERITY[r.finding.severity]}</span>} <Md inline>{r.finding.text.split("\n")[0]}</Md>
                </td>
                <td>{r.verdict === "agree" ? "Agreed" : r.verdict === "reject" ? "Rejected" : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="review-clean">
          <HudCheckIcon />
          No findings in any file
        </div>
      )}
      <div className="review-actions">
        <button className="primary" onClick={() => onAction("Write it up: put the accepted findings in a local file, grouped by file.")}>
          Write it up
        </button>
        <button onClick={() => onAction("Fix them: hand the accepted findings to incremental-dev as the plan.")}>Fix them</button>
      </div>
    </div>
  );
}
