import { describe, expect, it } from "vitest";
import type { TestRunItem } from "../store";
import type { TestCase, TestRun } from "../types";
import { compareRuns, parseLocation, previousRun, runSummary } from "./testRuns";

const tc = (name: string, status: TestCase["status"]): TestCase => ({ name, suite: "s", status, duration_ms: null, message: null, location: null });
const run = (cases: TestCase[], extra: Partial<TestRun> = {}): TestRun => ({
  framework: "vitest",
  outcome: cases.some((c) => c.status === "failed") ? "failed" : "passed",
  passed: cases.filter((c) => c.status === "passed").length,
  failed: cases.filter((c) => c.status === "failed").length,
  skipped: 0,
  duration_ms: null,
  cases,
  tail: "",
  ...extra,
});
const item = (id: string, r: TestRun): TestRunItem => ({ id, command: "npm test", run: r });

describe("test runs", () => {
  it("finds the previous run of the same framework", () => {
    const runs = [item("a", run([])), item("b", run([], { framework: "cargo" })), item("c", run([]))];
    expect(previousRun(runs, "c")?.id).toBe("a");
    expect(previousRun(runs, "a")).toBeNull();
  });

  it("marks tests that newly fail and tests that got fixed, among those both runs name", () => {
    const before = run([tc("a", "passed"), tc("b", "failed"), tc("c", "passed")]);
    const after = run([tc("a", "failed"), tc("b", "passed")]);
    const { newlyFailing, fixed } = compareRuns(before, after);
    expect([...newlyFailing]).toEqual(["s::a"]);
    expect([...fixed]).toEqual(["s::b"]);
  });

  it("counts a failure as fixed when a passing rerun lists only failures", () => {
    const { fixed } = compareRuns(run([tc("b", "failed")]), run([], { outcome: "passed", passed: 10 }));
    expect([...fixed]).toEqual(["s::b"]);
  });

  it("summarises counts, or how it ended", () => {
    expect(runSummary(run([tc("a", "failed"), tc("b", "passed")]))).toBe("1 failed · 1 passed");
    expect(runSummary(run([], { outcome: "failed" }))).toBe("Failed");
    expect(runSummary(run([], { outcome: "unknown" }))).toBe("No tests ran");
  });

  it("resolves a location against the folder", () => {
    expect(parseLocation("src/a.test.ts:88", "/p")).toEqual({ path: "/p/src/a.test.ts", line: 88 });
    expect(parseLocation("./x.py:3", "/p/")).toEqual({ path: "/p/x.py", line: 3 });
    expect(parseLocation("/abs/Foo.swift:12", "/p")).toEqual({ path: "/abs/Foo.swift", line: 12 });
  });
});
