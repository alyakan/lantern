import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { api } from "../api";
import type { StepsSummary, SummaryRow } from "../lib/stepsSummary";
import { SummaryTab } from "./SummaryTab";

vi.mock("../api", () => ({ api: { changeSummary: vi.fn() } }));
const changeSummary = vi.mocked(api.changeSummary);

const row = (over: Partial<SummaryRow>): SummaryRow => ({ id: "x", kind: "step", label: "Step 1", title: "T", built: true, current: false, gist: null, page: "x", planPage: null, range: null, changes: false, findings: null, stats: null, ...over });
const show = (summary: StepsSummary, onOpenPage = vi.fn()) => render(<SummaryTab slot="s1" summary={summary} changed={[]} running={false} onOpenPage={onOpenPage} />);

describe("SummaryTab", () => {
  beforeEach(() => {
    changeSummary.mockReset().mockResolvedValue([]);
  });

  it("lists the plan so far with its progress, and says what state each step is in", () => {
    show({
      headline: "Plan: 3 steps · 1 built",
      rows: [
        row({ id: "a", label: "Step 1", title: "Name the statuses", gist: "Added RETRYABLE.", built: true }),
        row({ id: "b", label: "Step 2", title: "Retry with backoff", built: false, current: true }),
        row({ id: "c", label: "Step 3", title: "Test it", built: false }),
      ],
    });
    expect(screen.getByText("Plan: 3 steps · 1 built")).toBeInTheDocument();
    expect(screen.getByText("Added RETRYABLE.")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.className)).toEqual(["summary-row built", "summary-row current", "summary-row planned"]);
    // Not by colour alone.
    expect(within(items[0]).getByText("(done)")).toBeInTheDocument();
    expect(within(items[1]).getByText("(now)")).toBeInTheDocument();
    expect(within(items[2]).getByText("(planned, not built yet)")).toBeInTheDocument();
    expect(within(items[1]).getByRole("button")).toHaveAttribute("aria-current", "step");
  });

  it("shows a step's code as code, and drops a backtick a cut left open", () => {
    show({ headline: null, rows: [row({ title: "Rename `fetchJson`", gist: "`src/client/retry.ts:1`: added RETRYABLE and `wait" })] });
    expect(screen.getByText("fetchJson").tagName).toBe("CODE");
    expect(screen.getByText("src/client/retry.ts:1").tagName).toBe("CODE");
    expect(screen.getByText(/added RETRYABLE and wait/)).toBeInTheDocument();
  });

  it("opens a step's page from its row, and its plan from the Plan link", () => {
    const open = vi.fn();
    show({ headline: null, rows: [row({ page: "step-page", planPage: "plan-page", title: "Name the statuses" }), row({ id: "y", page: "only-plan", title: "Later", built: false })] }, open);
    fireEvent.click(screen.getByRole("button", { name: /Name the statuses/ }));
    expect(open).toHaveBeenLastCalledWith("step-page");
    // Only a built step that has a plan page has the link.
    expect(screen.getAllByRole("button", { name: "Plan" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(open).toHaveBeenLastCalledWith("plan-page");
    fireEvent.click(screen.getByRole("button", { name: /Later/ }));
    expect(open).toHaveBeenLastCalledWith("only-plan");
  });

  it("shows the files a built step changed, asked for by its turns, and how many more there are", async () => {
    changeSummary.mockResolvedValue([
      { path: "/p/src/a.ts", created: false, added: 9, removed: 4 },
      { path: "/p/src/b.ts", created: true, added: 3, removed: 0 },
      { path: "/p/src/c.ts", created: false, added: 1, removed: 1 },
      { path: "/p/src/d.ts", created: false, added: 2, removed: 2 },
    ]);
    show({ headline: null, rows: [row({ built: true, changes: true, range: { from: 4, to: 5 } })] });
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(changeSummary).toHaveBeenCalledWith("s1", "turn", 4, 5);
    expect(screen.getByText("+9")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.queryByText("d.ts")).toBeNull();
  });

  it("says so when a step changed nothing, or its changes can't be read, instead of showing nothing", async () => {
    show({ headline: null, rows: [row({ id: "a", title: "Quiet", built: true, changes: true, range: { from: 1, to: 1 } }), row({ id: "b", title: "Old", built: true, changes: true, range: null })] });
    expect(await screen.findByText("No files changed")).toBeInTheDocument();
    expect(screen.getByText("Changes not available for this step")).toBeInTheDocument();
  });

  it("leaves a failed lookup as no files, and a step not built yet without a line about changes", async () => {
    changeSummary.mockImplementation(() => Promise.reject(new Error("nope")));
    show({ headline: null, rows: [row({ id: "a", built: true, changes: true, range: { from: 1, to: 1 } }), row({ id: "b", title: "Next up", built: false, changes: false })] });
    expect(await screen.findByText("No files changed")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Next up/ })).queryByText(/changed|available/)).toBeNull();
  });

  it("shows a reviewed file's findings and size", () => {
    show({
      headline: null,
      rows: [
        row({ id: "a", kind: "file", label: "File 1 of 2", title: "src/a.ts", findings: { count: 2, clean: false }, stats: { added: 4, removed: 1 } }),
        row({ id: "b", kind: "file", label: "File 2 of 2", title: "src/b.ts", findings: { count: 0, clean: true }, stats: null }),
        row({ id: "c", kind: "file", label: "File 3 of 3", title: "src/c.ts", findings: { count: 1, clean: false } }),
      ],
    });
    expect(screen.getByText("2 findings")).toBeInTheDocument();
    expect(screen.getByText("No findings")).toBeInTheDocument();
    expect(screen.getByText("1 finding")).toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(changeSummary).not.toHaveBeenCalled();
  });
});
