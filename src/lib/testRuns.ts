import type { TestRunItem } from "../store";
import type { TestCase, TestRun } from "../types";

const caseKey = (c: TestCase) => `${c.suite ?? ""}::${c.name}`;

/** The run before `id` from the same framework: what "newly failing" and "fixed" compare against. */
export function previousRun(runs: TestRunItem[], id: string): TestRunItem | null {
  const at = runs.findIndex((r) => r.id === id);
  if (at <= 0) return null;
  const framework = runs[at].run.framework;
  for (let i = at - 1; i >= 0; i--) if (runs[i].run.framework === framework) return runs[i];
  return null;
}

/**
 * Against the previous run: tests failing now that passed then, and tests passing now that failed then. Only tests
 * both runs name count, so a narrower rerun doesn't mark everything else as changed.
 */
export function compareRuns(prev: TestRun | null, cur: TestRun): { newlyFailing: Set<string>; fixed: Set<string> } {
  const newlyFailing = new Set<string>();
  const fixed = new Set<string>();
  if (!prev) return { newlyFailing, fixed };
  const before = new Map(prev.cases.map((c) => [caseKey(c), c.status]));
  for (const c of cur.cases) {
    const was = before.get(caseKey(c));
    if (c.status === "failed" && was === "passed") newlyFailing.add(caseKey(c));
    if (c.status === "passed" && was === "failed") fixed.add(caseKey(c));
  }
  // A rerun that only lists failures: a test that failed before and isn't failing now, in a run that passed.
  if (cur.outcome === "passed") {
    for (const c of prev.cases) if (c.status === "failed" && !cur.cases.some((x) => caseKey(x) === caseKey(c))) fixed.add(caseKey(c));
  }
  return { newlyFailing, fixed };
}

export { caseKey };

/** "2 failed · 144 passed · 1 skipped", or how it ended when there were no counts. */
export function runSummary(run: TestRun): string {
  const parts = [run.failed && `${run.failed} failed`, run.passed && `${run.passed} passed`, run.skipped && `${run.skipped} skipped`].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return run.outcome === "failed" ? "Failed" : run.outcome === "passed" ? "Passed" : "No tests ran";
}

export function formatMs(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "src/a.test.ts:88" → an absolute path (relative ones are under `folder`) and the line. */
export function parseLocation(location: string, folder: string | null): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)$/.exec(location);
  const raw = m ? m[1] : location;
  const line = m ? Number(m[2]) : null;
  const rel = raw.replace(/^\.\//, "");
  const path = rel.startsWith("/") || !folder ? rel : `${folder.replace(/\/$/, "")}/${rel}`;
  return { path, line };
}
