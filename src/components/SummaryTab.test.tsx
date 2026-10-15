import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { StepsSummary, SummaryRow } from "../lib/stepsSummary";
import type { RevertControls } from "../lib/revert";
import { SummaryTab } from "./SummaryTab";

vi.mock("../api", () => ({ api: { changeSummary: vi.fn() } }));
const changeSummary = vi.mocked(api.changeSummary);

const row = (over: Partial<SummaryRow>): SummaryRow => ({ id: "x", kind: "step", label: "Step 1", title: "T", built: true, current: false, gist: null, page: "x", planPage: null, range: null, changes: false, findings: null, stats: null, ...over });
const show = (summary: StepsSummary, onOpenPage = vi.fn()) => render(<SummaryTab slot="s1" summary={summary} changed={[]} running={false} onOpenPage={onOpenPage} />);

describe("SummaryTab step reverts", () => {
  const controls = (over: Partial<RevertControls> = {}): RevertControls => ({ slot: "s1", blocked: null, latestTurn: 2, undo: null, onUndo: vi.fn(), onReverted: vi.fn(), ...over });
  const step = (over: Partial<SummaryRow>) => row({ id: "s1", kind: "step", label: "Step 1", title: "Add slugify", built: true, changes: true, page: "s1", range: { from: 0, to: 0 }, ...over });
  const summary = (...rows: SummaryRow[]): StepsSummary => ({ headline: null, rows });
  const fileAt = { path: "/p/src/slug.ts", created: true, deleted: false, added: 5, removed: 0 };

  it("a built step's Revert puts back its files, as the turns it spans", async () => {
    changeSummary.mockResolvedValue([fileAt]);
    render(<SummaryTab slot="s1" summary={summary(step({ range: { from: 3, to: 4 } }))} changed={[]} running={false} onOpenPage={vi.fn()} revert={controls()} />);
    const button = await screen.findByRole("button", { name: "Revert" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(changeSummary).toHaveBeenCalledWith("s1", "turn", 3, 4);
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Revert Step 1?" })).toHaveTextContent("This file goes back to how it was before this step.");
  });

  it("is unavailable, with the reason, for a built step whose turns aren't known", () => {
    render(<SummaryTab slot="s1" summary={summary(step({ range: null }))} changed={[]} running={false} onOpenPage={vi.fn()} revert={controls()} />);
    const button = screen.getByRole("button", { name: "Revert" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "This step's changes aren't known: the chat was reopened after it.");
  });

  it("is off while Claude works, and absent without the controls", async () => {
    changeSummary.mockResolvedValue([fileAt]);
    const { unmount } = render(<SummaryTab slot="s1" summary={summary(step({}))} changed={[]} running={true} onOpenPage={vi.fn()} revert={controls({ blocked: "Wait for Claude to finish before reverting." })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled());
    unmount();
    render(<SummaryTab slot="s1" summary={summary(step({}))} changed={[]} running={false} onOpenPage={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });
});

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

  it("offers Export only when it has the pages to export from, and exports the plan with the files each step changed", async () => {
    const rows = [row({ id: "a", label: "Step 1", title: "Name the statuses", built: true, range: { from: 4, to: 4 }, changes: true, page: "p1" })];
    const view = show({ headline: "Plan: 1 step · all built", rows });
    expect(screen.queryByRole("button", { name: /Export/ })).not.toBeInTheDocument();
    view.unmount();

    changeSummary.mockResolvedValue([{ path: "/work/acme/src/a.ts", created: false, added: 3, removed: 1 }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SummaryTab slot="s1" summary={{ headline: "Plan: 1 step · all built", rows }} changed={[]} running={false} onOpenPage={vi.fn()} doc={{ pages: [], title: "My chat", folder: "/work/acme" }} />);
    await screen.findByText("a.ts");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    await screen.findByText("Copied");
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("# My chat");
    expect(text).toContain("**Plan: 1 step · all built**");
    expect(text).toContain("| Step 1 | Name the statuses |");
    expect(text).toContain("**Files:** `src/a.ts` +3 −1");
  });

  it("shows a step's code as code, and drops a backtick a cut left open", () => {
    show({ headline: null, rows: [row({ title: "Rename `fetchJson`", gist: "`src/client/retry.ts:1`: added RETRYABLE and `wait" })] });
    expect(screen.getByText("fetchJson").tagName).toBe("CODE");
    expect(screen.getByText("src/client/retry.ts:1").tagName).toBe("CODE");
    expect(screen.getByText(/added RETRYABLE and wait/)).toBeInTheDocument();
  });

  it("shows steps that have no page as a plain line with nothing to open", () => {
    const open = vi.fn();
    show({ headline: "Plan: 5 steps · 0 built", rows: [row({ id: "g", kind: "gap", label: "Steps 2–4", title: "No pages for these steps", gist: "Not written as a page in this chat, so there's nothing to open.", built: false, page: "" }), row({ id: "s5", label: "Step 5", title: "Five", built: false })] }, open);
    const gap = screen.getAllByRole("listitem")[0];
    expect(gap).toHaveClass("gap");
    expect(gap).toHaveTextContent("Steps 2–4");
    expect(gap).toHaveTextContent("No pages for these steps");
    expect(within(gap).queryByRole("button")).toBeNull();
    fireEvent.click(gap);
    expect(open).not.toHaveBeenCalled();
    // The real step next to it still opens.
    fireEvent.click(screen.getByRole("button", { name: /Five/ }));
    expect(open).toHaveBeenCalledWith("x");
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

  it("says a failed lookup failed, not that nothing changed, and offers to try again", async () => {
    changeSummary.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce([{ path: "/p/src/a.ts", created: false, added: 2, removed: 0 }]);
    show({ headline: null, rows: [row({ id: "a", title: "Built", built: true, changes: true, range: { from: 1, to: 1 } }), row({ id: "b", title: "Next up", built: false, changes: false })] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the files some steps changed.");
    expect(screen.getByText("Couldn't read this step's changes")).toBeInTheDocument();
    expect(screen.queryByText("No files changed")).toBeNull();
    expect(within(screen.getByRole("button", { name: /Next up/ })).queryByText(/changed|available/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
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
