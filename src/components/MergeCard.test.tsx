import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import type { MergeProposal } from "../store";
import { MergeCard } from "./MergeCard";

const proposal: MergeProposal = {
  worker: "w1",
  name: "Login form",
  branch: "lantern/login-form",
  into: "main",
  summary: "Adds the form. 6 tests pass.",
  commits: 3,
  files: [
    { path: "src/LoginForm.tsx", added: 84, removed: 0 },
    { path: "src/LoginForm.test.tsx", added: 61, removed: 0 },
    { path: "src/App.tsx", added: 2, removed: 1 },
  ],
  uncommitted: 0,
  status: "open",
  problem: null,
  attempts: 0,
};

const actions = (over: Partial<NodeActions> = {}): NodeActions => ({
  send: vi.fn(), stop: vi.fn(), queue: vi.fn(), decide: vi.fn(), openFile: vi.fn(), openTestRun: vi.fn(), stopShell: vi.fn(), shellInput: vi.fn(), restart: vi.fn(),
  approveMerge: vi.fn(), declineMerge: vi.fn(), removeWorktree: vi.fn(() => Promise.resolve()), hide: vi.fn(), show: vi.fn(), draft: vi.fn(() => ""), setDraft: vi.fn(),
  ...over,
});

const show = (p: MergeProposal, a = actions()) => {
  const ui = (pp: MergeProposal) => (
    <NodeActionsContext.Provider value={a}>
      <MergeCard proposal={pp} />
    </NodeActionsContext.Provider>
  );
  const r = render(ui(p));
  return { a, update: (pp: MergeProposal) => r.rerender(ui(pp)) };
};

describe("the merge card", () => {
  it("says what would be merged and what it adds, in words", () => {
    show(proposal);
    expect(screen.getByText(/into/).textContent).toContain("Merge lantern/login-form into main?");
    expect(screen.getByText(/3 commits · 3 files/)).toBeTruthy();
    expect(screen.getByText("+147")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText(/The main agent says:/).parentElement!.textContent).toContain("Adds the form. 6 tests pass.");
  });

  it("lists the files only on request, and a few of many", () => {
    show({ ...proposal, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 })) });
    expect(screen.queryByText("f0.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByText("f5.ts")).toBeTruthy();
    expect(screen.queryByText("f6.ts")).toBeNull();
    expect(screen.getByText("and 3 more")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
    expect(screen.queryByText("f0.ts")).toBeNull();
  });

  it("approves, which waits for the outcome, and says no", () => {
    const { a, update } = show(proposal);
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    expect(a.approveMerge).toHaveBeenCalledWith("w1");
    expect((screen.getByRole("button", { name: "Merging…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Not yet" }) as HTMLButtonElement).disabled).toBe(true);
    // It conflicted: the buttons come back, with the reason, to try again.
    update({ ...proposal, problem: "Conflicts with main in a.ts.", attempts: 1 });
    expect(screen.getByRole("alert").textContent).toBe("Conflicts with main in a.ts.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(a.approveMerge).toHaveBeenCalledTimes(2);
    // It failed the very same way: still an answer, so the buttons come back.
    expect((screen.getByRole("button", { name: "Merging…" }) as HTMLButtonElement).disabled).toBe(true);
    update({ ...proposal, problem: "Conflicts with main in a.ts.", attempts: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(a.declineMerge).toHaveBeenCalledWith("w1");
  });

  it("warns that loose work will be committed first", () => {
    show({ ...proposal, uncommitted: 2 });
    expect(screen.getByText(/2 files of loose work in its worktree will be committed first/)).toBeTruthy();
    show({ ...proposal, uncommitted: 1 });
    expect(screen.getAllByText(/1 file of loose work/).length).toBe(1);
  });

  it("shows a declined proposal as a quiet line", () => {
    show({ ...proposal, status: "declined" });
    expect(screen.getByRole("status").textContent).toBe("Not merged: lantern/login-form. The main agent can ask again.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a merged one, with a way to clear the worktree, whose failure is shown", async () => {
    const removeWorktree = vi.fn().mockRejectedValueOnce("It has uncommitted changes.").mockResolvedValueOnce(undefined);
    show({ ...proposal, status: "merged" }, actions({ removeWorktree }));
    expect(screen.getByRole("status").textContent).toContain("Merged lantern/login-form into main.");
    fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    await waitFor(() => expect(screen.getByText("It has uncommitted changes.")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    });
    await waitFor(() => expect(screen.getByText("Worktree removed.")).toBeTruthy());
    expect(removeWorktree).toHaveBeenCalledWith("w1");
  });
});
