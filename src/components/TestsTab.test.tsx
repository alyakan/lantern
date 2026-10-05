import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TestRunItem } from "../store";
import type { TestCase, TestRun } from "../types";
import { TestsTab } from "./TestsTab";

const tc = (name: string, status: TestCase["status"], extra: Partial<TestCase> = {}): TestCase => ({ name, suite: "fetchJson", status, duration_ms: 2, message: null, location: null, ...extra });
const run = (cases: TestCase[], extra: Partial<TestRun> = {}): TestRun => ({
  framework: "vitest",
  outcome: cases.some((c) => c.status === "failed") ? "failed" : "passed",
  passed: cases.filter((c) => c.status === "passed").length,
  failed: cases.filter((c) => c.status === "failed").length,
  skipped: 0,
  duration_ms: 1240,
  cases,
  tail: "raw output",
  ...extra,
});
const runs: TestRunItem[] = [
  { id: "a", command: "npx vitest run", run: run([tc("retries", "failed", { message: "ReferenceError: mockFetch", location: "src/retry.test.ts:4" }), tc("404", "passed")]) },
  { id: "b", command: "npm test", run: run([tc("retries", "passed"), tc("404", "passed")]) },
];

describe("TestsTab", () => {
  it("shows the latest run, with what got fixed since the previous one", () => {
    render(<TestsTab runs={runs} selected={null} onSelect={() => {}} onOpenLocation={() => {}} />);
    expect(screen.getByText("2 passed")).toBeInTheDocument();
    expect(screen.getByText("1 fixed since the previous run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Passed/ }));
    expect(screen.getByText("fixed")).toBeInTheDocument();
  });

  it("puts failures first with their message, and opens their location", () => {
    const onOpenLocation = vi.fn();
    render(<TestsTab runs={runs} selected="a" onSelect={() => {}} onOpenLocation={onOpenLocation} />);
    expect(screen.getByText("ReferenceError: mockFetch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "src/retry.test.ts:4" }));
    expect(onOpenLocation).toHaveBeenCalledWith("src/retry.test.ts:4");
  });

  it("picks an earlier run from the dropdown", () => {
    const onSelect = vi.fn();
    render(<TestsTab runs={runs} selected={null} onSelect={onSelect} onOpenLocation={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Run 2/ }));
    fireEvent.click(screen.getByRole("option", { name: /Run 1/ }).querySelector("button")!);
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("explains a run that failed before any test did, with the output open", () => {
    const broken: TestRunItem[] = [{ id: "c", command: "jest", run: run([], { outcome: "failed", passed: 0, tail: "Cannot find module" }) }];
    render(<TestsTab runs={broken} selected={null} onSelect={() => {}} onOpenLocation={() => {}} />);
    expect(screen.getByText(/failed before any test did/)).toBeInTheDocument();
    expect(screen.getByText("Cannot find module")).toBeInTheDocument();
  });
});
