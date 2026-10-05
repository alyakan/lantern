import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TestRunItem } from "../store";
import type { TestCase } from "../types";
import { caseKey, compareRuns, formatMs, previousRun, runSummary } from "../lib/testRuns";
import { FailIcon, HudCheckIcon } from "./icons";

interface Props {
  runs: TestRunItem[];
  /** The run on screen; the latest when null. */
  selected: string | null;
  onSelect: (id: string) => void;
  /** A failure's `path:line`, to open in the file preview. */
  onOpenLocation: (location: string) => void;
}

// Like Xcode's test report: the run's result up top, failures first with their message and where they happened,
// then what passed and was skipped, folded away. A dropdown picks an earlier run from this chat.
export function TestsTab({ runs, selected, onSelect, onOpenLocation }: Props) {
  const current = runs.find((r) => r.id === selected) ?? runs[runs.length - 1];
  if (!current) return <div className="empty">No test runs yet</div>;
  const { run } = current;
  const prev = previousRun(runs, current.id);
  const { newlyFailing, fixed } = compareRuns(prev?.run ?? null, run);
  const failed = run.cases.filter((c) => c.status === "failed");
  const passed = run.cases.filter((c) => c.status === "passed");
  const skipped = run.cases.filter((c) => c.status === "skipped");
  const duration = formatMs(run.duration_ms);
  const changes = [newlyFailing.size && `${newlyFailing.size} newly failing`, fixed.size && `${fixed.size} fixed`].filter(Boolean);

  return (
    <>
      <div className="review-bar">
        <RunPicker runs={runs} current={current} onSelect={onSelect} />
        <div className="spacer" />
        {duration && <span className="position">{duration}</span>}
      </div>
      <div className="tests-body">
        <div className={`tests-result ${run.outcome}`}>
          {run.outcome === "failed" ? <FailIcon /> : run.outcome === "passed" ? <HudCheckIcon /> : null}
          <span className="tests-result-text">{runSummary(run)}</span>
          {changes.length > 0 && <span className="tests-changes">{changes.join(", ")} since the previous run</span>}
        </div>

        {failed.length > 0 && (
          <section className="tests-section">
            <div className="tests-heading">Failed</div>
            {failed.map((c, i) => (
              <Failure key={`${caseKey(c)}-${i}`} test={c} isNew={newlyFailing.has(caseKey(c))} onOpenLocation={onOpenLocation} />
            ))}
          </section>
        )}
        {run.outcome === "failed" && failed.length === 0 && (
          <div className="tests-note">The run failed before any test did: a build error, or a suite that couldn't load. The output is below.</div>
        )}

        {(passed.length > 0 || run.passed > 0) && (
          <Fold title={`Passed`} count={run.passed || passed.length}>
            {passed.length ? <CaseList cases={passed} fixed={fixed} /> : <div className="tests-note">The output didn't list the tests that passed, only how many.</div>}
          </Fold>
        )}
        {(skipped.length > 0 || run.skipped > 0) && (
          <Fold title="Skipped" count={run.skipped || skipped.length}>
            {skipped.length ? <CaseList cases={skipped} fixed={fixed} /> : <div className="tests-note">The output didn't name them.</div>}
          </Fold>
        )}
        <Fold title="Output" open={run.outcome === "failed" && failed.length === 0}>
          <pre className="step-output tests-output">{run.tail}</pre>
        </Fold>
      </div>
    </>
  );
}

function Failure({ test, isNew, onOpenLocation }: { test: TestCase; isNew: boolean; onOpenLocation: (location: string) => void }) {
  return (
    <div className="test-failure">
      <div className="test-failure-head">
        <FailIcon />
        <span className="test-name">{test.name}</span>
        {test.suite && <span className="test-suite">{test.suite}</span>}
        {isNew && <span className="tag">new</span>}
      </div>
      {test.message && <pre className="step-output test-message">{test.message}</pre>}
      {test.location && (
        <button className="test-location" title="Open in the file preview" onClick={() => onOpenLocation(test.location!)}>
          {test.location}
        </button>
      )}
    </div>
  );
}

// Grouped by suite, in the order the output listed them.
function CaseList({ cases, fixed }: { cases: TestCase[]; fixed: Set<string> }) {
  const groups = new Map<string, TestCase[]>();
  for (const c of cases) groups.set(c.suite ?? "", [...(groups.get(c.suite ?? "") ?? []), c]);
  return (
    <div className="test-cases">
      {[...groups].map(([suite, list]) => (
        <div key={suite} className="test-group">
          {suite && <div className="test-group-name">{suite}</div>}
          {list.map((c, i) => (
            <div key={`${c.name}-${i}`} className={`test-case ${c.status}`}>
              <span className="test-name">{c.name}</span>
              {fixed.has(caseKey(c)) && <span className="tag">fixed</span>}
              {c.duration_ms !== null && <span className="test-duration">{formatMs(c.duration_ms)}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Fold({ title, count, open: initial = false, children }: { title: string; count?: number; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  useEffect(() => setOpen(initial), [initial]);
  return (
    <section className="tests-section">
      <button className="activity-line tests-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        <span className="activity-text">{title}</span>
        {count !== undefined && <span className="activity-count">{count}</span>}
      </button>
      {open && children}
    </section>
  );
}

// The run picker: every run in this chat, newest first, with how each went.
function RunPicker({ runs, current, onSelect }: { runs: TestRunItem[]; current: TestRunItem; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const number = (r: TestRunItem) => runs.indexOf(r) + 1;
  return (
    <div className="picker" ref={root}>
      <button className="picker-button" aria-haspopup="listbox" aria-expanded={open} title={current.command} onClick={() => setOpen(!open)}>
        <span className="run-number">Run {number(current)}</span>
        <span className="picker-path run-command">{current.command}</span>
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu file-menu run-menu">
          <ul className="menu-list" role="listbox" aria-label="Test runs">
            {[...runs].reverse().map((r) => (
              <li key={r.id} role="option" aria-selected={r.id === current.id}>
                <button
                  className={`menu-row${r.id === current.id ? " current" : ""}`}
                  title={r.command}
                  onClick={() => {
                    onSelect(r.id);
                    setOpen(false);
                  }}
                >
                  <span className={`run-dot ${r.run.outcome}`} aria-hidden />
                  <span className="menu-row-title">
                    Run {number(r)}
                    <span className="menu-row-path">{r.command}</span>
                  </span>
                  <span className="menu-row-meta">{runSummary(r.run)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
