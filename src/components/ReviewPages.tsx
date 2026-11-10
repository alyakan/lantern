import { useEffect, useState } from "react";
import { useFileLinks } from "../lib/fileLinks";
import { clipLine, commentLines, linesOf, type DiffComment } from "../lib/diffComments";
import { relativeTo } from "../lib/diff";
import { diffRows, excerpt, type DiffRow } from "../lib/lineDiff";
import { useReviewDiffs } from "../lib/reviewDiffs";
import type { Finding, ReviewFile, Severity, Verdict } from "../lib/review";
import type { Flavour } from "../lib/flavour";
import { DocIcon, HudCheckIcon } from "./icons";
import { Md } from "./Md";

const SEVERITY: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", nit: "Nit" };

/**
 * "line 42" that opens the file there in the right pane, once the file is found in the folder. A group's finding names
 * its file, so it reads "retry.ts:42" and opens that one.
 */
function LineChip({ path, finding }: { path: string | null; finding: Finding }) {
  const links = useFileLinks();
  if (finding.line === null) return null;
  const own = finding.path ?? path;
  const span = `${finding.line}${finding.lineEnd ? `–${finding.lineEnd}` : ""}`;
  const label = finding.path ? `${finding.path.split("/").pop()}:${span}` : `line ${span}`;
  const file = own && links ? links.resolve(own) : null;
  if (!file || !links) return <span className="finding-line" title={finding.path}>{label}</span>;
  return (
    <button className="finding-line link" title={`Open ${own} at line ${finding.line}`} onClick={() => links.open(file, finding.line)}>
      {label}
    </button>
  );
}

/**
 * A finding with its verdict buttons (only while it can take one). `inDiff`: drawn under its line in the Changes pane's
 * diff, where the line needs no link and the card is smaller.
 */
export function FindingCard({ path, finding, verdict, onVerdict, inDiff = false }: { path: string | null; finding: Finding; verdict: Verdict | undefined; onVerdict?: (v: Verdict | null) => void; inDiff?: boolean }) {
  const sev = finding.severity;
  return (
    <div className={`finding${sev ? ` sev-${sev}` : ""}${verdict ? ` verdict-${verdict}` : ""}${inDiff ? " in-diff" : ""}`} role={inDiff ? "group" : undefined} aria-label={inDiff ? `Finding${sev ? `, ${SEVERITY[sev].toLowerCase()}` : ""}` : undefined}>
      <div className="finding-head">
        {inDiff && <span className="finding-from">Review</span>}
        {sev && <span className="finding-sev">{SEVERITY[sev]}</span>}
        {!inDiff && <LineChip path={path} finding={finding} />}
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
      {!inDiff && <FindingCode path={path} finding={finding} />}
    </div>
  );
}

type Loaded = { rows: DiffRow[] } | { error: string } | null;

/**
 * A finding's lines from the diff, in a card that stays shut until it is opened: the lines it names, a few around them,
 * and what was removed there. "Open in the diff" takes the Changes pane to them. Nothing for a finding with no line, or
 * one whose file isn't among the changed files.
 */
function FindingCode({ path, finding }: { path: string | null; finding: Finding }) {
  const links = useFileLinks();
  const diffs = useReviewDiffs();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>(null);
  const own = finding.path ?? path;
  const file = own && links ? links.resolve(own) : null;
  const from = finding.line;
  const to = finding.lineEnd ?? finding.line;
  useEffect(() => {
    if (!open || !file || !diffs || from === null || to === null) return;
    let live = true;
    setLoaded(null);
    diffs.load(file).then(
      (d) => {
        if (!live) return;
        const rows = diffRows(d.original, d.current) ?? linesOf(d.current).map((text, i): DiffRow => ({ kind: "ctx", oldNo: i + 1, newNo: i + 1, text }));
        setLoaded({ rows: excerpt(rows, from, to) });
      },
      (e) => live && setLoaded({ error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [open, file, diffs, from, to]);
  if (from === null || to === null || !diffs || !file || !links) return null;
  const span = from === to ? `line ${from}` : `lines ${from}–${to}`;
  return (
    <div className={`finding-code${open ? " open" : ""}`}>
      <button className="finding-code-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="finding-code-chevron" aria-hidden>
          ›
        </span>
        {open ? "Hide the code" : "Show the code"}
        <span className="finding-code-span">{span}</span>
      </button>
      {open && (
        <div className="finding-code-body">
          {loaded === null ? (
            <div className="finding-code-note">Loading…</div>
          ) : "error" in loaded ? (
            <div className="finding-code-note">Couldn't read the diff: {loaded.error}</div>
          ) : loaded.rows.length === 0 ? (
            <div className="finding-code-note">This version of the file doesn't have {span}.</div>
          ) : (
            <div className="finding-code-rows" role="table" aria-label={`${own} around ${span}`}>
              {loaded.rows.map((r, i) => {
                const no = r.kind === "del" ? r.oldNo : r.newNo;
                const named = r.kind !== "del" && r.newNo >= from && r.newNo <= to;
                return (
                  <div key={i} role="row" className={`finding-code-row ${r.kind}${named ? " named" : ""}`}>
                    <span role="cell" className="finding-code-no">
                      {no}
                    </span>
                    <span role="cell" className="finding-code-mark" aria-label={r.kind === "add" ? "added" : r.kind === "del" ? "removed" : undefined}>
                      {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                    </span>
                    <code role="cell">{r.text || " "}</code>
                  </div>
                );
              })}
            </div>
          )}
          <button className="ghost finding-code-open" onClick={() => links.open(file, from)}>
            Open in the diff
          </button>
        </div>
      )}
    </div>
  );
}

/** A reviewed file: what changed, its findings as cards (or a clean result), and the notes. */
export function ReviewFileView({ file, verdicts, onVerdict }: { file: ReviewFile; verdicts: Record<number, Verdict> | undefined; onVerdict?: (index: number, v: Verdict | null) => void }) {
  return (
    <div className="review-file">
      {file.files.length > 0 && <GroupFiles files={file.files} />}
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

/** A group page's files, each a link to the file (once it is found in the folder; a name that matches no changed file stays plain). */
function GroupFiles({ files }: { files: string[] }) {
  const links = useFileLinks();
  return (
    <ul className="review-group-files" aria-label="Files on this page">
      {files.map((path) => {
        const file = links?.resolve(path) ?? null;
        return (
          <li key={path}>
            {file && links ? (
              <button className="file-link" title={`Open ${path}`} onClick={() => links.open(file, null)}>
                <code>{path}</code>
              </button>
            ) : (
              <code>{path}</code>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The page header for a group of reviewed files: its title (the pull request and what the group is) and counts. */
export function ReviewGroupHeader({ title, added, removed }: { title: string; added: number | null; removed: number | null }) {
  return (
    <div className="review-file-header">
      <DocIcon />
      <span className="review-file-name">{title}</span>
      {added !== null && (
        <span className="counts">
          <span className="added">+{added}</span>
          <span className="removed">−{removed}</span>
        </span>
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
  /** The file reviewed, or the architecture part the concern is about. */
  path: string | null;
  finding: Finding;
  verdict: Verdict | undefined;
  /** Go back to the page the finding is on. */
  onRevisit?: () => void;
}

/** A Review's notes on the diff's lines, kept for its end: listed on the summary, and sent with Fix them or Write it up. */
export interface SummaryNotes {
  items: DiffComment[];
  folder: string | null;
  /** Take notes away: one deleted, or all of them once an action has sent them. */
  remove: (ids: string[]) => void;
}

/** The notes kept from the diff, on the summary: where each is (opening the diff there) and what it says, each deletable. */
function NotesLedger({ notes }: { notes: SummaryNotes }) {
  const links = useFileLinks();
  return (
    <section className="review-section review-notes-ledger" aria-label="Your notes">
      <div className="review-section-title">
        Your notes<span className="tab-count">{notes.items.length}</span>
      </div>
      <ul>
        {notes.items.map((c) => {
          const where = `${relativeTo(c.path, notes.folder)}:${c.line}${c.side === "old" ? " (before)" : ""}`;
          return (
            <li key={c.id} className="review-note">
              <div className="review-note-head">
                {links ? (
                  <button className="finding-line link" title={`Open ${where} in the diff`} onClick={() => links.open(c.path, c.side === "old" || c.outdated ? null : c.line)}>
                    {where}
                  </button>
                ) : (
                  <span className="finding-line">{where}</span>
                )}
                {c.outdated && <span className="diff-comment-tag">Outdated</span>}
                <span className="spacer" />
                <button className="ghost" aria-label={`Delete your note on ${where}`} onClick={() => notes.remove([c.id])}>
                  Delete
                </button>
              </div>
              {c.lineText.trim() !== "" && <code className="diff-comment-quote">{clipLine(c.lineText)}</code>}
              <div className="review-note-text">{c.text}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The summary page's table: every finding across the files, with its severity and your verdict. */
// The actions send a message, so they wait while Claude works: a message sent then would skip the composer's queue.
// Start Build and Fix them switch the chat to Build with the message they send.
export function ReviewSummaryTable({ rows, onAction, busy = false, architecture = false, notes }: { rows: ReviewedFinding[]; onAction: (text: string, switchTo?: Flavour) => void; busy?: boolean; architecture?: boolean; notes?: SummaryNotes }) {
  const counts = (s: Severity) => rows.filter((r) => r.finding.severity === s).length;
  const agreed = rows.filter((r) => r.verdict === "agree").length;
  const kept = notes?.items ?? [];
  // An action takes the notes along, and they are done with once it is sent.
  const withNotes = (text: string, intro: string) => (kept.length ? `${text}\n\n${intro}\n\n${commentLines(kept, notes!.folder)}` : text);
  const act = (text: string, switchTo?: Flavour) => {
    if (switchTo) onAction(text, switchTo);
    else onAction(text);
    if (kept.length) notes!.remove(kept.map((c) => c.id));
  };
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
              <th>{architecture ? "Part" : "File"}</th>
              {!architecture && <th>Line</th>}
              <th>{architecture ? "Concern" : "Finding"}</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.verdict === "reject" ? "rejected" : ""}>
                <td className="review-table-file">
                  {r.onRevisit ? (
                    <button className="review-revisit" title={`Back to the page of ${r.path ?? "this finding"}`} onClick={r.onRevisit}>
                      {architecture ? r.path : r.path?.split("/").pop()}
                    </button>
                  ) : architecture ? (
                    r.path
                  ) : (
                    r.path?.split("/").pop()
                  )}
                </td>
                {!architecture && <td>{r.finding.line ?? "–"}</td>}
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
          {architecture ? "No concerns in any part" : "No findings in any file"}
        </div>
      )}
      {kept.length > 0 && <NotesLedger notes={notes!} />}
      <div className="review-actions">
        {architecture ? (
          <>
            <button className="primary" disabled={busy} onClick={() => onAction("Start Build.", "build")}>
              Start Build
            </button>
            <button disabled={busy} onClick={() => onAction("Write it up: put the architecture, the decisions and the accepted concerns in a local markdown file.")}>
              Write it up
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} title={kept.length ? "Your notes on the diff go in it too" : undefined} onClick={() => act(withNotes("Write it up: put the accepted findings in a local file, grouped by file.", "Put my own notes from the diff in it too:"))}>
              Write it up
            </button>
            <button disabled={busy} title={kept.length ? "Your notes on the diff go into the plan too" : undefined} onClick={() => act(withNotes("Fix them: hand the accepted findings to incremental-dev as the plan.", "Add my own notes from the diff to the plan:"), "build")}>
              Fix them
            </button>
          </>
        )}
      </div>
    </div>
  );
}
