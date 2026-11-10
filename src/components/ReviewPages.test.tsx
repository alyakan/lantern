import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FindingCard, ReviewFileView, ReviewSummaryTable, type ReviewedFinding } from "./ReviewPages";
import type { ReviewFile } from "../lib/review";
import type { DiffComment } from "../lib/diffComments";
import { FileLinksProvider } from "../lib/fileLinks";
import { ReviewDiffsProvider } from "../lib/reviewDiffs";

// The folder's files, as the backend would resolve a page's mentions: every one is under /p.
vi.mock("../api", () => ({ api: { resolveFiles: (_slot: string, mentions: string[]) => Promise.resolve(mentions.map((m) => `/p/${m}`)) } }));
const TestLinks = ({ open, children }: { open: (path: string, line: number | null) => void; children: ReactNode }) => (
  <FileLinksProvider slot="s" folder="/p" epoch={0} onOpen={open}>
    {children}
  </FileLinksProvider>
);

const rows: ReviewedFinding[] = [{ path: "src/a.ts", finding: { index: 0, line: 3, lineEnd: null, severity: "nit", text: "Rename it" }, verdict: "agree" }];

describe("ReviewSummaryTable", () => {
  it("sends the actions as messages", () => {
    const onAction = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.stringMatching(/^Fix them:/), "build");
    fireEvent.click(screen.getByRole("button", { name: "Write it up" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.stringMatching(/^Write it up:/));
  });

  it("doesn't send them while Claude works, which would skip the queue", () => {
    const onAction = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} busy />);
    expect(screen.getByRole("button", { name: "Fix them" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Write it up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("the summary's notes from the diff", () => {
  const note: DiffComment = { id: "n1", path: "/p/src/a.ts", side: "new", line: 7, lineText: "  const x = 1;", kind: "added", text: "Why one?" };
  const gone: DiffComment = { id: "n2", path: "/p/src/b.ts", side: "old", line: 2, lineText: "old()", kind: "removed", text: "Keep old()" };

  it("lists each note with where it is, and deletes one", () => {
    const remove = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={vi.fn()} notes={{ items: [note, gone], folder: "/p", remove }} />);
    const ledger = screen.getByRole("region", { name: "Your notes" });
    expect(ledger).toHaveTextContent("src/a.ts:7");
    expect(ledger).toHaveTextContent("src/b.ts:2 (before)");
    expect(ledger).toHaveTextContent("Why one?");
    fireEvent.click(screen.getByRole("button", { name: "Delete your note on src/a.ts:7" }));
    expect(remove).toHaveBeenCalledWith(["n1"]);
  });

  it("go with Fix them and Write it up, and are done with once sent", () => {
    const onAction = vi.fn();
    const remove = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} notes={{ items: [note], folder: "/p", remove }} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.stringMatching(/^Fix them: [^\n]+\n\nAdd my own notes from the diff to the plan:\n\n1\. src\/a\.ts line 7 \(added line: `const x = 1;`\): Why one\?$/), "build");
    expect(remove).toHaveBeenCalledWith(["n1"]);
  });

  it("has no notes section when there are none, and the actions say only what they did", () => {
    const onAction = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} notes={{ items: [], folder: "/p", remove: vi.fn() }} />);
    expect(screen.queryByRole("region", { name: "Your notes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Write it up" }));
    expect(onAction).toHaveBeenLastCalledWith("Write it up: put the accepted findings in a local file, grouped by file.");
  });

  it("takes a finding back to its page", () => {
    const onRevisit = vi.fn();
    render(<ReviewSummaryTable rows={[{ ...rows[0], onRevisit }]} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(onRevisit).toHaveBeenCalled();
  });
});

describe("a finding's code", () => {
  const original = ["a", "b", "c", "old", "e", "f", "g"].join("\n");
  const current = ["a", "b", "c", "new", "e", "f", "g"].join("\n");
  const finding = { index: 0, line: 4, lineEnd: null, severity: "blocker" as const, text: "Wrong", path: "src/a.ts" };

  it("stays shut until opened, then shows the lines around it from the review's diff, and opens the diff there", async () => {
    const load = vi.fn().mockResolvedValue({ path: "/p/src/a.ts", original, current, deleted: false });
    const open = vi.fn();
    render(
      <TestLinks open={open}>
        <ReviewDiffsProvider value={{ load }}>
          <FindingCard path="src/a.ts" finding={finding} verdict={undefined} />
        </ReviewDiffsProvider>
      </TestLinks>,
    );
    const toggle = await screen.findByRole("button", { name: /Show the code/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(load).toHaveBeenCalledWith("/p/src/a.ts");
    const table = await screen.findByRole("table", { name: "src/a.ts around line 4" });
    const rowsShown = [...table.querySelectorAll(".finding-code-row")].map((r) => `${r.classList.contains("add") ? "+" : r.classList.contains("del") ? "-" : " "}${r.querySelector("code")!.textContent}`);
    expect(rowsShown).toEqual([" a", " b", " c", "-old", "+new", " e", " f", " g"]);
    expect(table.querySelector(".named code")).toHaveTextContent("new");
    fireEvent.click(screen.getByRole("button", { name: "Open in the diff" }));
    expect(open).toHaveBeenCalledWith("/p/src/a.ts", 4);
  });

  it("isn't offered for a finding with no line, nor in the diff itself", () => {
    const load = vi.fn();
    render(
      <TestLinks open={vi.fn()}>
        <ReviewDiffsProvider value={{ load }}>
          <FindingCard path="src/a.ts" finding={{ ...finding, line: null }} verdict={undefined} />
          <FindingCard path="src/a.ts" finding={finding} verdict={undefined} inDiff />
        </ReviewDiffsProvider>
      </TestLinks>,
    );
    expect(screen.queryByRole("button", { name: /Show the code/ })).toBeNull();
  });
});

describe("a page's diff", () => {
  const lines = (n: number, at: number, text: string) => Array.from({ length: n }, (_, i) => (i === at ? text : `line ${i + 1}`)).join("\n");
  const page = (over: Partial<ReviewFile>): ReviewFile => ({ path: null, group: null, files: [], added: 1, removed: 1, preface: "", changed: "It changed.", findings: [], clean: true, notes: "", ...over });

  it("is a shut card per file, even with no findings, and opens on its changes with the unchanged lines between folded", async () => {
    const load = vi.fn().mockImplementation(async (path: string) => ({ path, original: lines(30, 4, "old five"), current: lines(30, 4, "new five").replace("line 25", "line twenty-five"), deleted: false }));
    const open = vi.fn();
    render(
      <TestLinks open={open}>
        <ReviewDiffsProvider value={{ load }}>
          <ReviewFileView file={page({ path: "src/a.ts" })} verdicts={undefined} />
        </ReviewDiffsProvider>
      </TestLinks>,
    );
    const toggle = await screen.findByRole("button", { name: /Show the diff/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(load).toHaveBeenCalledWith("/p/src/a.ts");
    const table = await screen.findByRole("table", { name: "The diff of src/a.ts" });
    const shown = [...table.querySelectorAll(".finding-code-row")].map((r) => (r.classList.contains("gap") ? r.textContent : `${r.classList.contains("add") ? "+" : r.classList.contains("del") ? "-" : " "}${r.querySelector("code")!.textContent}`));
    expect(shown).toEqual([" line 2", " line 3", " line 4", "-old five", "+new five", " line 6", " line 7", " line 8", "⋯ 13 unchanged lines", " line 22", " line 23", " line 24", "-line 25", "+line twenty-five", " line 26", " line 27", " line 28"]);
    fireEvent.click(screen.getByRole("button", { name: "Open in the diff" }));
    expect(open).toHaveBeenCalledWith("/p/src/a.ts", null);
  });

  it("has a card for each file of a group page, named", async () => {
    render(
      <TestLinks open={vi.fn()}>
        <ReviewDiffsProvider value={{ load: vi.fn() }}>
          <ReviewFileView file={page({ group: "Setup", files: ["Package.swift", "ci.yml"] })} verdicts={undefined} />
        </ReviewDiffsProvider>
      </TestLinks>,
    );
    const toggles = await screen.findAllByRole("button", { name: /Show the diff/ });
    expect(toggles.map((t) => t.textContent)).toEqual(["›Show the diffPackage.swift", "›Show the diffci.yml"]);
  });
});
