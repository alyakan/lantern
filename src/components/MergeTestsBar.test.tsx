import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { NodeActionsContext, type NodeActions } from "../lib/canvasContext";
import { SlotContext, useSlot } from "../lib/slot";
import type { MergeProposal } from "../store";
import type { MergeTestsInfo, MergeTestsReport } from "../types";
import { MergeCard } from "./MergeCard";

vi.mock("../api", () => ({
  api: { mergeTestsInfo: vi.fn(), runMergeTests: vi.fn(), cancelMergeTests: vi.fn(), splitTestCommand: vi.fn(), setAutoMergeTests: vi.fn() },
}));
// The diff itself is Monaco's; what the card hands it is what matters here.
vi.mock("./FullDiff", () => ({
  default: function FullDiff(p: { path: string; scope?: string; base?: string | null; layout: string }) {
    return (
      <div data-testid="diff">
        diff of {p.path} · {p.scope} · {p.base} · {p.layout} · {useSlot()}
      </div>
    );
  },
}));

const proposal: MergeProposal = {
  worker: "w1",
  name: "Login form",
  branch: "lantern/login-form",
  into: "main",
  summary: "",
  commits: 3,
  files: [
    { path: "src/LoginForm.tsx", added: 84, removed: 0 },
    { path: "src/App.tsx", added: 2, removed: 1 },
  ],
  uncommitted: 0,
  loose: [],
  status: "open",
  problem: null,
  attempts: 0,
};

const actions = (): NodeActions =>
  ({ approveMerge: vi.fn(), declineMerge: vi.fn(() => Promise.resolve()), reviewMerge: vi.fn(), removeWorktree: vi.fn(() => Promise.resolve()) }) as unknown as NodeActions;

const report = (over: Partial<MergeTestsReport> = {}): MergeTestsReport => ({
  command: ["npm", "test"],
  result: "passed",
  passed: 214,
  failed: 0,
  skipped: 0,
  exit_code: 0,
  took_ms: 3420,
  tail: "Tests  214 passed (214)",
  note: null,
  new_files: [],
  at: 1,
  stale: false,
  ...over,
});

const info = (over: Partial<MergeTestsInfo> = {}): MergeTestsInfo => ({ project: "/repo", detected: { command: ["npm", "test"], source: "package.json" }, running: null, last: null, ...over });

const show = (p: MergeProposal = proposal, a = actions()) => {
  const ui = (pp: MergeProposal) => (
    <SlotContext.Provider value="s1">
      <NodeActionsContext.Provider value={a}>
        <MergeCard proposal={pp} />
      </NodeActionsContext.Provider>
    </SlotContext.Provider>
  );
  const r = render(ui(p));
  return { a, update: (pp: MergeProposal) => r.rerender(ui(pp)) };
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.mergeTestsInfo).mockReset().mockResolvedValue(info());
  vi.mocked(api.runMergeTests).mockReset().mockResolvedValue(null);
  vi.mocked(api.cancelMergeTests).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.splitTestCommand).mockReset().mockImplementation((text) => (text.includes("&&") ? Promise.reject("“&” is a shell symbol") : Promise.resolve(text.trim().split(/\s+/))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the tests on a merge card", () => {
  it("runs nothing until the button is pressed, then runs what the project says and names it first", async () => {
    show();
    const run = await screen.findByRole("button", { name: "Run tests" });
    expect(screen.getByText(/npm test/).textContent).toContain("from package.json");
    expect(api.runMergeTests).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(api.runMergeTests).toHaveBeenCalledWith("w1", ["npm", "test"]);
  });

  it("shows the clock, the line it is on and a Cancel while it runs", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ running: { command: ["npm", "test"], elapsed_ms: 42_000, last_line: "✓ src/App.test.tsx (31 tests)" } }));
    show();
    expect(await screen.findByText("Running tests…")).toBeTruthy();
    expect(screen.getByText("42s")).toBeTruthy();
    expect(screen.getByText("✓ src/App.test.tsx (31 tests)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelMergeTests).toHaveBeenCalledWith("w1");
  });

  it("keeps looking while the tests run, and shows the result when they end", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const going = info({ running: { command: ["npm", "test"], elapsed_ms: 1000, last_line: "" } });
    vi.mocked(api.mergeTestsInfo).mockResolvedValueOnce(going).mockResolvedValue(info({ last: report() }));
    show();
    expect(await screen.findByText("Running tests…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(await screen.findByText("Tests passed: 214")).toBeTruthy();
    expect(screen.getByText("3s")).toBeTruthy();
  });

  it("says a failure in words, shows the end of the output on request, and marks a result the branch has moved past", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ last: report({ result: "failed", passed: 211, failed: 3, exit_code: 1, tail: "FAIL LoginForm", stale: true }) }));
    show();
    expect(await screen.findByText("3 tests failed")).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.getByText(/The branch changed after these tests ran/)).toBeTruthy();
    expect(screen.queryByText("FAIL LoginForm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the end of the output" }));
    expect(screen.getByText("FAIL LoginForm")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run the tests again" })).toBeTruthy();
  });

  it("says a time-out, a note, and the files a run left behind", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ last: report({ result: "timed_out", passed: null, failed: null, note: "Stopped after 10 minutes, the longest a run may take.", new_files: ["coverage/index.html"] }) }));
    show();
    expect(await screen.findByText("Tests timed out")).toBeTruthy();
    expect(screen.getByText(/Stopped after 10 minutes/)).toBeTruthy();
    expect(screen.getByText(/left 1 new file in the worktree \(coverage\/index\.html\)/)).toBeTruthy();
  });

  it("can't tell how an unknown project is tested: it asks for the command, shows what it would run, and remembers it for the project", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ detected: null }));
    show();
    expect(await screen.findByText(/Lantern can't tell how to run them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));
    expect(api.runMergeTests).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    expect(screen.getByText(/Lantern can't tell how this project is tested/)).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Run tests" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "make check -j 4" } });
    expect(await screen.findByText(/Nothing goes through a shell/)).toBeTruthy();
    expect(screen.getByText("make check -j 4", { selector: "code" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Run tests" })[0]);
    expect(api.runMergeTests).toHaveBeenCalledWith("w1", ["make", "check", "-j", "4"]);
    expect(JSON.parse(localStorage.getItem("merge.testCommandByFolder")!)).toEqual({ "/repo": "make check -j 4" });
  });

  it("refuses a command with shell symbols, saying why, and runs nothing", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ detected: null }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Run tests" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "npm ci && npm test" } });
    expect((await screen.findByRole("alert")).textContent).toContain("shell symbol");
    expect((screen.getAllByRole("button", { name: "Run tests" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.runMergeTests).not.toHaveBeenCalled();
  });

  it("uses the command remembered for the project, and lets it be changed or put back to the detected one", async () => {
    localStorage.setItem("merge.testCommandByFolder", JSON.stringify({ "/repo": "npm run test:unit", "/other": "x" }));
    show();
    expect(await screen.findByText("npm run test:unit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));
    await waitFor(() => expect(api.runMergeTests).toHaveBeenCalledWith("w1", ["npm", "run", "test:unit"]));
    cleanup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Use npm test" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("npm test");
    fireEvent.click(await screen.findByText(/Nothing goes through a shell/).then(() => screen.getAllByRole("button", { name: "Run tests" })[0]));
    // What the project says itself isn't kept as the user's own, and other projects' entries stay.
    expect(JSON.parse(localStorage.getItem("merge.testCommandByFolder")!)).toEqual({ "/other": "x" });
  });

  it("shows why a run couldn't start", async () => {
    vi.mocked(api.runMergeTests).mockRejectedValue("Couldn't start “npm”: it isn't installed.");
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Run tests" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't start “npm”: it isn't installed.");
  });
});

describe("merging over the tests", () => {
  const failed = () => info({ last: report({ result: "failed", passed: 211, failed: 3, exit_code: 1 }) });

  it("merges as before when the tests passed, never ran, or are out of date", async () => {
    for (const last of [report(), null, report({ result: "failed", failed: 3, stale: true })]) {
      cleanup();
      vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ last }));
      const { a } = show();
      await screen.findByRole("button", { name: "Run tests" }).catch(() => screen.findByRole("button", { name: "Run the tests again" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
      expect(a.approveMerge).toHaveBeenCalledWith("w1");
    }
  });

  it("asks once more over a failed run, and goes back or merges anyway", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(failed());
    const { a } = show();
    await screen.findByText("3 tests failed");
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    expect(await screen.findByText("Tests failed: merge anyway?")).toBeTruthy();
    expect(a.approveMerge).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    // Go back: Escape does the same.
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go back" }));
    expect(a.approveMerge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge anyway" }));
    expect(a.approveMerge).toHaveBeenCalledTimes(1);
    expect(a.approveMerge).toHaveBeenCalledWith("w1");
    expect(screen.getByRole("button", { name: "Merging…" })).toBeTruthy();
  });

  it("doesn't ask when the branch was fixed since the failed run", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValueOnce(failed()).mockResolvedValue(info({ last: report({ result: "failed", failed: 3, stale: true }) }));
    const { a } = show();
    await screen.findByText("3 tests failed");
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    await waitFor(() => expect(a.approveMerge).toHaveBeenCalledWith("w1"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks over tests still going, which merging stops", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(info({ running: { command: ["npm", "test"], elapsed_ms: 5000, last_line: "" } }));
    const { a } = show();
    await screen.findByText("Running tests…");
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    expect(screen.getByText("The tests are still running: merge anyway?")).toBeTruthy();
    expect(screen.getByText(/Merging stops them/)).toBeTruthy();
    expect(a.approveMerge).not.toHaveBeenCalled();
  });

  it("comes back to the buttons when a merge that was approved over failed tests didn't go through", async () => {
    vi.mocked(api.mergeTestsInfo).mockResolvedValue(failed());
    const { update } = show();
    await screen.findByText("3 tests failed");
    fireEvent.click(screen.getByRole("button", { name: "Approve merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge anyway" }));
    update({ ...proposal, problem: "Conflicts with main in a.ts.", attempts: 1 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("the diff on a merge card", () => {
  it("opens each file's changes under its name, from the worker's own folder against the branch it goes into", async () => {
    const { a } = show();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.queryByTestId("diff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the changes in src/App.tsx" }));
    expect((await screen.findByTestId("diff")).textContent).toBe("diff of src/App.tsx · branch · main · inline · w1");
    fireEvent.click(screen.getByRole("button", { name: "Show the changes in src/LoginForm.tsx" }));
    expect(screen.getAllByTestId("diff").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide the changes in src/App.tsx" }));
    expect(screen.getAllByTestId("diff").length).toBe(1);
    // The name still opens the side panel at that file, and the card's Review diff the whole branch.
    fireEvent.click(screen.getByRole("button", { name: "src/App.tsx" }));
    expect(a.reviewMerge).toHaveBeenLastCalledWith("w1", "src/App.tsx");
    fireEvent.click(screen.getByRole("button", { name: "Review diff" }));
    expect(a.reviewMerge).toHaveBeenLastCalledWith("w1");
  });

  it("asks nothing of the backend for a merge that is over", () => {
    show({ ...proposal, status: "merged" });
    expect(api.mergeTestsInfo).not.toHaveBeenCalled();
  });
});
