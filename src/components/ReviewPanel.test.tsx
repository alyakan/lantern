import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ReviewPanel, migrateTab } from "./ReviewPanel";
import { api } from "../api";
import type { TestRunItem } from "../store";
import { NetworkEmpty } from "./NetworkTab";
import type { RevertControls } from "../lib/revert";
import type { CommentControls, DiffComment } from "../lib/diffComments";
import { freshLoop, type LoopState } from "../lib/prChecks";
import type { PrView } from "../lib/usePrChecks";
import type { PrCheck } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

vi.mock("./FullDiff", () => ({ default: ({ path }: { path: string }) => <div>diff of {path}</div> }));

const files = [
  { path: "/p/src/a.ts", created: false, added: 3, removed: 1 },
  { path: "/p/src/b.ts", created: true, added: 9, removed: 0 },
];
const base = { folder: "/p", ready: false, files, refreshKey: 0, onSelect: () => {}, onFollow: () => {} };

// Reverting: the controls the App hands the panel. The dialog reads files through the api, which fails outside Tauri;
// these tests only look at what the panel offers.
const controls = (over: Partial<RevertControls> = {}): RevertControls => ({ slot: "s1", blocked: null, latestTurn: null, undo: null, onUndo: vi.fn(), onReverted: vi.fn(), ...over });

describe("ReviewPanel's Ship it", () => {
  it("is in the Changes header when there are changes and a chat to ask, and opens Ship it", () => {
    const onShip = vi.fn();
    render(<ReviewPanel {...base} selected={null} follow onShip={onShip} />);
    fireEvent.click(screen.getByRole("button", { name: "Ship it…" }));
    expect(onShip).toHaveBeenCalledTimes(1);
  });

  it("is absent without a chat to ask, and without changes", () => {
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow />);
    expect(screen.queryByRole("button", { name: "Ship it…" })).toBeNull();
    rerender(<ReviewPanel {...base} selected={null} follow files={[]} onShip={() => {}} />);
    expect(screen.queryByRole("button", { name: "Ship it…" })).toBeNull();
  });
});

describe("ReviewPanel's worktree chip", () => {
  it("names the worktree the chat works in and switches to the chat's own folder and back", () => {
    const onToggle = vi.fn();
    const worktree = { name: "retry-fix", branch: "worktree-retry-fix", main: false, onToggle };
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow onScope={() => {}} worktree={worktree} />);
    fireEvent.click(screen.getByRole("button", { name: "Worktree: retry-fix" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<ReviewPanel {...base} selected={null} follow onScope={() => {}} worktree={{ ...worktree, main: true }} />);
    expect(screen.getByRole("button", { name: "Main folder" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is absent when the chat works in its own folder", () => {
    render(<ReviewPanel {...base} selected={null} follow onScope={() => {}} />);
    expect(screen.queryByRole("button", { name: /Worktree:|Main folder/ })).toBeNull();
  });
});

describe("ReviewPanel reverts", () => {
  it("a file's Revert opens a dialog for that file", () => {
    render(<ReviewPanel {...base} scope="session" selected="/p/src/a.ts" follow revert={controls()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.getByRole("dialog", { name: "Revert a.ts?" })).toBeInTheDocument();
  });

  it("Revert all is offered for the whole chat and for the last message, not for a step", () => {
    const { rerender } = render(<ReviewPanel {...base} scope="session" selected="/p/src/a.ts" follow revert={controls()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    expect(screen.getByRole("dialog", { name: "Revert all of this chat's changes?" })).toHaveTextContent("2 files go back to how they were before this chat began.");
    rerender(<ReviewPanel {...base} scope="turn" selected="/p/src/a.ts" follow revert={controls()} />);
    expect(screen.getByRole("button", { name: "Revert all" })).toBeEnabled();
    rerender(<ReviewPanel {...base} scope="turn" stepRange={{ from: 1, to: 2 }} selected="/p/src/a.ts" follow revert={controls()} />);
    expect(screen.queryByRole("button", { name: "Revert all" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
  });

  it("is off while Claude works, with the reason on the buttons", () => {
    render(<ReviewPanel {...base} scope="session" selected="/p/src/a.ts" follow revert={controls({ blocked: "Wait for Claude to finish before reverting." })} />);
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert" })).toHaveAttribute("title", "Wait for Claude to finish before reverting.");
    expect(screen.getByRole("button", { name: "Revert all" })).toBeDisabled();
  });

  it("is off for a step whose turns aren't known, and absent for a git view", () => {
    const { rerender } = render(<ReviewPanel {...base} scope="turn" stepRange={null} selected="/p/src/a.ts" follow revert={controls()} />);
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert" })).toHaveAttribute("title", "This step's changes aren't known: the chat was reopened after it.");
    rerender(<ReviewPanel {...base} scope="git" selected="/p/src/a.ts" follow revert={controls()} />);
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });

  it("shows what the last revert did, with Undo, on every tab", () => {
    const onUndo = vi.fn();
    render(<ReviewPanel {...base} scope="session" selected="/p/src/a.ts" follow revert={controls({ undo: { id: 1, files: [], summary: "Reverted 2 files." }, onUndo })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reverted 2 files.");
    expect(screen.getByText(/Undo lasts until your next message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewPanel", () => {
  it("shows an empty state", () => {
    render(<ReviewPanel {...base} files={[]} selected={null} follow />);
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });

  it("shows the selected file with position and navigates", async () => {
    const onSelect = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow onSelect={onSelect} />);
    expect(await screen.findByText("diff of /p/src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous file" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(onSelect).toHaveBeenCalledWith("/p/src/b.ts");
    expect(screen.queryByText("↓ Latest")).toBeNull();
  });

  // The filter is a menu: its button names the current choice; the options say what each one means.
  const filterButton = () => screen.getByRole("button", { name: /^Show changes from/ });
  const openFilter = () => fireEvent.click(filterButton());
  const option = (name: string | RegExp) => screen.getByRole("menuitemradio", { name });

  it("filters between the last turn's changes and the whole session's", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} scopeCounts={{ turn: 1, session: 2, git: null }} selected="/p/src/a.ts" follow />);
    expect(filterButton()).toHaveTextContent("This chat2");
    openFilter();
    expect(option(/^This chat/)).toHaveAttribute("aria-checked", "true");
    expect(option(/^Last turn/)).toHaveAttribute("aria-checked", "false");
    expect(option(/^Last turn/)).toHaveTextContent("What changed since your last message");
    fireEvent.click(option(/^Last turn/));
    expect(onScope).toHaveBeenCalledWith("turn");
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<ReviewPanel {...base} files={[]} scope="turn" onScope={onScope} selected={null} follow />);
    expect(screen.getByText("No changes in the last turn")).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent("Last turn");
  });

  it("offers what's uncommitted, and says why when there's none to show", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} scopeCounts={{ turn: 0, session: 2, git: 5 }} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(option(/^Uncommitted/)).toHaveTextContent("Uncommitted5Everything not committed yet");
    fireEvent.click(option(/^Uncommitted/));
    expect(onScope).toHaveBeenCalledWith("git");
    rerender(<ReviewPanel {...base} files={[]} scope="git" onScope={onScope} gitError="This folder isn't in a git repository." selected={null} follow />);
    expect(screen.getByText("This folder isn't in a git repository.")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} files={[]} scope="git" onScope={onScope} selected={null} follow />);
    expect(screen.getByText("Nothing uncommitted")).toBeInTheDocument();
  });

  it("offers a reviewed PR's files, first among the filters, and says while it's fetching", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} pr={128} scopeCounts={{ pr: 2 }} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent(/^PR #1282/);
    fireEvent.click(option(/^PR #128/));
    expect(onScope).toHaveBeenCalledWith("pr");
    rerender(<ReviewPanel {...base} files={[]} scope="pr" onScope={onScope} pr={128} selected={null} follow />);
    expect(screen.getByText("Fetching pull request #128…")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} files={[]} scope="pr" onScope={onScope} pr={128} gitError="gh pr view: no pull requests found" selected={null} follow />);
    expect(screen.getByText("gh pr view: no pull requests found")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} scope="session" onScope={onScope} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(screen.queryByRole("menuitemradio", { name: /PR/ })).toBeNull();
  });

  it("offers a local branch's files, with its commits above the diff", () => {
    const branch = { branch: "feat/x", base: "origin/main", commits: [{ sha: "a41c9e2", subject: "test: retries", author: "Sam", at: Date.now() - 60_000 }] };
    render(<ReviewPanel {...base} scope="branch" onScope={() => {}} branch={branch} scopeCounts={{ branch: 2 }} selected="/p/src/a.ts" follow />);
    expect(filterButton()).toHaveTextContent("This branch2");
    openFilter();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Committed on feat/x since it left origin/main");
    expect(screen.getByText(/1 commit on/)).toHaveTextContent("1 commit on feat/x since origin/main");
    expect(screen.getByText("test: retries")).toBeInTheDocument();
  });

  it("picks a file from the dropdown", () => {
    const onSelect = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    fireEvent.click(screen.getByRole("option", { name: /b\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith("/p/src/b.ts");
    expect(screen.queryByRole("listbox", { name: "Changed files" })).toBeNull();
  });

  it("offers to follow again after a manual selection", () => {
    const onFollow = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow={false} onFollow={onFollow} />);
    fireEvent.click(screen.getByText("↓ Latest"));
    expect(onFollow).toHaveBeenCalled();
  });
});

vi.mock("./SummaryTab", () => ({ SummaryTab: ({ summary, onOpenPage }: { summary: { headline: string | null; rows: { page: string }[] }; onOpenPage: (page: string) => void }) => <button onClick={() => onOpenPage(summary.rows[0].page)}>summary: {summary.headline}</button> }));
vi.mock("./ArchitectureTab", () => ({ ArchitectureTab: () => <div>the map</div> }));

const summary = (onOpenPage = vi.fn()) => ({ slot: "s1", data: { headline: "Plan: 2 steps · 1 built", rows: [{ page: "p1" }] } as never, changed: [], running: false, onOpenPage });
const architecture = (openKey = 0) => ({ map: {} as never, current: [], pageNames: {}, onOpenPage: vi.fn(), openKey });
const check = (name: string, bucket: PrCheck["bucket"]): PrCheck => ({ name, state: bucket.toUpperCase(), bucket, link: `https://github.com/o/r/actions/runs/1/job/${name}`, workflow: "CI", run_id: "1" });
const MIXED = [check("build", "pass"), check("lint", "pass"), check("test", "fail"), check("e2e", "pending")];
const prView = (checks: PrCheck[], over: { setting?: PrView["setting"]; state?: "OPEN" | "MERGED"; loop?: Partial<LoopState> } = {}): PrView => ({
  folder: "/p",
  setting: over.setting ?? { mode: "tell", tries: 3 },
  snap: { pr: { number: 57, url: "https://github.com/o/r/pull/57", state: over.state ?? "OPEN", branch: "feat/x", base: "main", head_sha: "aaa" }, checks },
  access: "ok",
  loop: { ...freshLoop(), ...over.loop },
  needsYou: false,
});
const checksProps = (view: PrView) => ({ view, busy: false, onSend: vi.fn(() => Promise.resolve()), onStop: vi.fn() });
const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
// Tabs that aren't pinned are opened from the ⋯ menu, which closes when one is picked.
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^More tabs/ }));
const openTab = (name: string) => {
  openMenu();
  fireEvent.click(within(screen.getByRole("menu", { name: "Side panel tabs" })).getByRole("menuitem", { name: new RegExp(`^${name}`) }));
};
const failedRun = (failed: number): TestRunItem => ({ id: "r1", command: "npm test", run: { framework: "vitest", outcome: "failed", passed: 3, failed, skipped: 0, duration_ms: 10, cases: [], tail: "" } });
const SAVED = "review.tabs";
const saved = () => JSON.parse(localStorage.getItem(SAVED)!);

describe("ReviewPanel's tabs", () => {
  it("pins Changes, Files and Plan by default, with the rest in the ⋯ menu", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow />);
    expect(tabs()).toEqual(["Changes2", "Files", "Plan"]);
    rerender(<ReviewPanel {...base} selected={null} follow summary={summary()} architecture={architecture()} />);
    expect(tabs()).toEqual(["Changes2", "Files", "Plan"]);
    expect(screen.queryByRole("tab", { name: /Activity|Storage/ })).toBeNull();
    openMenu();
    const menu = screen.getByRole("menu", { name: "Side panel tabs" });
    expect(within(menu).getAllByRole("menuitem").filter((i) => i.classList.contains("menu-row")).map((i) => i.textContent)).toEqual(["Changes2", "Files", "Plan", "Tests", "Checks", "Network", "Dashboard", "Reset to default"]);
    expect(within(menu).getAllByRole("menuitemcheckbox").map((c) => [c.getAttribute("aria-label"), c.getAttribute("aria-checked")])).toEqual([
      ["Pin Changes", "true"], ["Pin Files", "true"], ["Pin Plan", "true"], ["Pin Tests", "false"], ["Pin Checks", "false"], ["Pin Network", "false"], ["Pin Dashboard", "false"],
    ]);
    localStorage.clear();
  });

  it("Plan shows the plan and opens a row's page; it takes a click, so it doesn't take the pane over", () => {
    localStorage.clear();
    const onOpenPage = vi.fn();
    render(<ReviewPanel {...base} selected={null} follow summary={summary(onOpenPage)} />);
    expect(screen.queryByText(/Plan: 2 steps/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByText(/Plan: 2 steps/));
    expect(onOpenPage).toHaveBeenCalledWith("p1");
    // No toggle without a map too.
    expect(screen.queryByRole("group", { name: "Plan view" })).toBeNull();
  });

  it("Plan in a Design chat shows the map first, with a toggle to the plan", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow summary={summary()} architecture={architecture()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByText("the map")).toBeInTheDocument();
    expect(screen.queryByText(/Plan: 2 steps/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByText(/Plan: 2 steps/)).toBeInTheDocument();
    expect(screen.queryByText("the map")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByText("the map")).toBeInTheDocument();
    localStorage.clear();
  });

  it("opening the map brings Plan up on the map", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow summary={summary()} architecture={architecture(0)} />);
    expect(selected()).toBe("Changes2");
    rerender(<ReviewPanel {...base} selected={null} follow summary={summary()} architecture={architecture(1)} />);
    expect(selected()).toBe("Plan");
    expect(screen.getByText("the map")).toBeInTheDocument();
    localStorage.clear();
  });

  it("Plan in a chat with no plan says that Step by step chats show theirs here", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow />);
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByText(/Step by step chats show their plan here/)).toBeInTheDocument();
    localStorage.clear();
  });

  it("Tests and Network each say what will show there instead of going away", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow />);
    openTab("Tests");
    expect(screen.getByText("Test runs show here when Claude runs your tests.")).toBeInTheDocument();
    openTab("Network");
    expect(screen.getByText(/Network Monitor is a Mac app/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "github.com/alyakan/network-monitor" })).toHaveAttribute("href", "https://github.com/alyakan/network-monitor");
    localStorage.clear();
  });

  it("moves between the tabs with the arrow keys, and each tab's panel is labelled by it", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow summary={summary()} />);
    const [changes, files, plan] = screen.getAllByRole("tab");
    expect(changes).toHaveAttribute("tabindex", "0");
    expect(files).toHaveAttribute("tabindex", "-1");
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    expect(files).toHaveFocus();
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Files" })).toBeInTheDocument();
    fireEvent.keyDown(files, { key: "End" });
    expect(plan).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Plan" })).toBeInTheDocument();
    localStorage.clear();
  });

  it("Checks says what will show there until a pull request has checks, and why not when it is off", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow />);
    openTab("Checks");
    expect(screen.getByText(/show here, once it has one/)).toBeInTheDocument();
    rerender(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView(MIXED, { setting: { mode: "off", tries: 3 } }))} />);
    expect(screen.getByText(/Checks are off for this project/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Checks" })).toHaveTextContent(/^Checks$/);
    localStorage.clear();
  });

  it("Checks lists the checks and sends the failure to Claude from its button", () => {
    localStorage.clear();
    const props = checksProps(prView(MIXED));
    render(<ReviewPanel {...base} selected={null} follow prChecks={props} />);
    openTab("Checks");
    const panel = screen.getByRole("tabpanel", { name: /^Checks/ });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    expect(within(panel).getByRole("link", { name: "Pull request #57" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Send the failure to Claude" }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    localStorage.clear();
  });

  it("Checks shows how many failed on its tab, a plain count when none did, and nothing when the pull request is closed", () => {
    localStorage.setItem(SAVED, JSON.stringify(["changes", "checks"]));
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView(MIXED))} />);
    expect(screen.getByRole("tab", { name: /Checks/ })).toHaveTextContent("Checks1");
    expect(screen.getByRole("tab", { name: /Checks/ }).querySelector(".tab-count")).toHaveClass("failed");
    rerender(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView([check("build", "pass"), check("lint", "pass")]))} />);
    expect(screen.getByRole("tab", { name: /Checks/ })).toHaveTextContent("Checks2");
    expect(screen.getByRole("tab", { name: /Checks/ }).querySelector(".tab-count")).not.toHaveClass("failed");
    rerender(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView(MIXED, { state: "MERGED" }))} />);
    expect(screen.getByRole("tab", { name: /Checks/ })).toHaveTextContent(/^Checks$/);
    localStorage.clear();
  });

  it("a failed check doesn't bring the Checks tab up on its own", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView([check("build", "pass")]))} />);
    rerender(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView(MIXED))} />);
    expect(selected()).toBe("Changes2");
    localStorage.clear();
  });

  it("a tab saved under an old name moves to its new one: Summary and Map to Plan; Activity, Agents and Storage to Changes", () => {
    for (const [old, now] of [["summary", "Plan"], ["map", "Plan"], ["agents", "Changes2"], ["activity", "Changes2"], ["storage", "Changes2"], ["tests", "Tests"], ["gone", "Changes2"]]) {
      localStorage.setItem("review.tab", JSON.stringify(old));
      const { unmount } = render(<ReviewPanel {...base} selected={null} follow />);
      expect(selected()).toBe(now);
      unmount();
    }
    // The saved name is rewritten, so it migrates once.
    localStorage.setItem("review.tab", JSON.stringify("agents"));
    render(<ReviewPanel {...base} selected={null} follow />);
    expect(JSON.parse(localStorage.getItem("review.tab")!)).toBe("changes");
    localStorage.clear();
  });

  it("migrateTab sends every tab that left the pane to Changes", () => {
    expect(["activity", "agents", "storage", "nonsense"].map(migrateTab)).toEqual(["changes", "changes", "changes", "changes"]);
    expect(["summary", "map"].map(migrateTab)).toEqual(["plan", "plan"]);
    expect(["changes", "files", "plan", "tests", "checks", "network"].map(migrateTab)).toEqual(["changes", "files", "plan", "tests", "checks", "network"]);
  });
});

describe("ReviewPanel's pinned tabs", () => {
  it("pinning a tab puts it in the strip, unpinning takes it out, and both persist for the next panel", () => {
    localStorage.clear();
    const { unmount } = render(<ReviewPanel {...base} selected={null} follow />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pin Tests" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Pin Tests" })).toHaveAttribute("aria-checked", "true");
    // The menu stays open to pin more.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pin Files" }));
    expect(tabs()).toEqual(["Changes2", "Plan", "Tests"]);
    expect(saved()).toEqual(["changes", "plan", "tests"]);
    unmount();
    render(<ReviewPanel {...base} selected={null} follow />);
    expect(tabs()).toEqual(["Changes2", "Plan", "Tests"]);
    localStorage.clear();
  });

  it("keeps at least one tab pinned", () => {
    localStorage.setItem(SAVED, JSON.stringify(["files"]));
    render(<ReviewPanel {...base} selected={null} follow />);
    openMenu();
    const pin = screen.getByRole("menuitemcheckbox", { name: "Pin Files" });
    expect(pin).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(pin);
    // (The open tab, Changes, is shown after it.)
    expect(tabs()).toEqual(["Files", "Changes2"]);
    localStorage.clear();
  });

  it("moves a pinned tab up and down, and the strip follows", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow />);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Move Changes up" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Move Plan down" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move Plan up" }));
    expect(tabs()).toEqual(["Changes2", "Plan", "Files"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move Changes down" }));
    expect(tabs()).toEqual(["Plan", "Changes2", "Files"]);
    expect(saved()).toEqual(["plan", "changes", "files"]);
    // A tab that isn't pinned has no arrows.
    expect(screen.queryByRole("menuitem", { name: "Move Tests up" })).toBeNull();
    localStorage.clear();
  });

  it("Reset to default puts back Changes, Files and Plan in that order", () => {
    localStorage.setItem(SAVED, JSON.stringify(["network", "plan"]));
    render(<ReviewPanel {...base} selected={null} follow />);
    expect(tabs()).toEqual(["Network", "Plan", "Changes2"]);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to default" }));
    expect(tabs()).toEqual(["Changes2", "Files", "Plan"]);
    localStorage.clear();
  });

  it("falls back to the default when what was saved isn't usable, and drops unknown names and repeats", () => {
    for (const bad of [null, "files", 3, [], ["storage", "activity"], {}]) {
      localStorage.setItem(SAVED, JSON.stringify(bad));
      const { unmount } = render(<ReviewPanel {...base} selected={null} follow />);
      expect(tabs()).toEqual(["Changes2", "Files", "Plan"]);
      unmount();
    }
    localStorage.setItem(SAVED, JSON.stringify(["tests", "activity", "files", "tests", 7, "files"]));
    render(<ReviewPanel {...base} selected={null} follow />);
    // What is open (Changes, the default) isn't pinned any more, so it shows at the end.
    expect(tabs()).toEqual(["Tests", "Files", "Changes2"]);
    localStorage.clear();
  });

  it("a tab opened from the menu without being pinned shows in the strip until another is opened", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow />);
    openTab("Tests");
    expect(tabs()).toEqual(["Changes2", "Files", "Plan", "Tests"]);
    expect(selected()).toBe("Tests");
    // It was not pinned by being opened.
    expect(saved()).toEqual(["changes", "files", "plan"]);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(tabs()).toEqual(["Changes2", "Files", "Plan"]);
    localStorage.clear();
  });

  it("a tab the app opens (a test run) shows in the strip while it is the one open, and unpinning the open tab keeps it there", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow testRuns={[failedRun(2)]} />);
    rerender(<ReviewPanel {...base} selected={null} follow testRuns={[failedRun(2)]} focusRun={{ id: "r1", key: 1 }} />);
    expect(selected()).toBe("Tests2");
    expect(tabs()).toEqual(["Changes2", "Files", "Plan", "Tests2"]);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pin Plan" }));
    expect(tabs()).toEqual(["Changes2", "Files", "Tests2"]);
    localStorage.clear();
  });

  it("a request the pane already acted on doesn't act again when the pane is shown again (another project's pane was open in between)", () => {
    localStorage.clear();
    const search = { mode: "files" as const, key: 9001 };
    const first = render(<ReviewPanel {...base} selected={null} follow searchKey={search} />);
    // A request made as the pane opens is acted on.
    expect(selected()).toBe("Files");
    fireEvent.click(screen.getByRole("tab", { name: /^Changes/ }));
    first.unmount();
    // The pane comes back (the app still holds the old request): the tab the user left stays.
    render(<ReviewPanel {...base} selected={null} follow searchKey={search} />);
    expect(selected()).toMatch(/^Changes/);
    localStorage.clear();
  });

  it("the ⋯ carries a red count for a failed test run in a tab that isn't pinned, and the menu row shows it too", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow />);
    expect(screen.getByRole("button", { name: "More tabs" })).toHaveTextContent(/^⋯$/);
    rerender(<ReviewPanel {...base} selected={null} follow testRuns={[failedRun(2)]} />);
    const more = screen.getByRole("button", { name: "More tabs, 2 failed" });
    expect(more.querySelector(".tab-count")).toHaveClass("failed");
    expect(more).toHaveTextContent("⋯2");
    openMenu();
    expect(within(screen.getByRole("menu", { name: "Side panel tabs" })).getByRole("menuitem", { name: /^Tests/ }).querySelector(".tab-count")).toHaveClass("failed");
    // Pinned, the tab has the count itself and the ⋯ has none.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pin Tests" }));
    expect(screen.getByRole("button", { name: "More tabs" })).toHaveTextContent(/^⋯$/);
    expect(screen.getByRole("tab", { name: /Tests/ })).toHaveTextContent("Tests2");
    localStorage.clear();
  });

  it("the ⋯ doesn't count the tab that is open, which is in the strip already", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow testRuns={[failedRun(2)]} />);
    openTab("Tests");
    expect(screen.getByRole("button", { name: "More tabs" })).toHaveTextContent(/^⋯$/);
    localStorage.clear();
  });

  it("the ⋯ counts failed checks that are in an unpinned tab, but not checks that merely passed", () => {
    localStorage.clear();
    const { rerender } = render(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView([check("build", "pass")]))} />);
    expect(screen.getByRole("button", { name: "More tabs" })).toBeInTheDocument();
    rerender(<ReviewPanel {...base} selected={null} follow prChecks={checksProps(prView(MIXED))} />);
    expect(screen.getByRole("button", { name: "More tabs, 1 failed" })).toHaveTextContent("⋯1");
    localStorage.clear();
  });

  it("the ⋯ counts the requests in an unpinned Network tab, plainly", async () => {
    localStorage.clear();
    const view = { link: { status: "connected" }, watches: [], items: [{ id: "a" }, { id: "b" }, { id: "c" }] } as never;
    const spy = vi.spyOn(api, "networkState").mockResolvedValue(view);
    render(<ReviewPanel {...base} selected={null} follow />);
    const more = await screen.findByRole("button", { name: "More tabs, 3 new" });
    expect(more.querySelector(".tab-count")).not.toHaveClass("failed");
    spy.mockRestore();
    localStorage.clear();
  });

  it("Escape closes the menu", () => {
    localStorage.clear();
    render(<ReviewPanel {...base} selected={null} follow />);
    openMenu();
    expect(screen.getByRole("menu", { name: "Side panel tabs" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Side panel tabs" })).toBeNull();
    localStorage.clear();
  });
});

describe("ReviewPanel review comments", () => {
  const note = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "/p/src/a.ts", side: "new", line: 4, lineText: "const a = 1;", kind: "added", text: "Why 1?", ...over });
  const withComments = (items: DiffComment[], over: Partial<CommentControls> = {}): CommentControls => ({ items, update: vi.fn(), send: vi.fn(), ...over });

  it("shows no bar until there is a comment", () => {
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow comments={withComments([])} />);
    expect(screen.queryByRole("group", { name: "Review comments" })).toBeNull();
  });

  it("counts every comment, and Send to Claude sends them as one message and clears them", () => {
    const comments = withComments([note(), note({ id: "c2", path: "/p/src/b.ts", line: 9, lineText: "x", kind: "context", text: "Fine." })]);
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow comments={comments} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 comments");
    fireEvent.click(screen.getByRole("button", { name: "Send to Claude" }));
    expect(comments.send).toHaveBeenCalledTimes(1);
    expect(comments.send).toHaveBeenCalledWith("Please address these review comments:\n\n1. src/a.ts line 4 (added line: `const a = 1;`): Why 1?\n2. src/b.ts line 9 (unchanged line: `x`): Fine.");
    const change = vi.mocked(comments.update).mock.calls[0][0];
    expect(change(comments.items)).toEqual([]);
  });

  it("Discard asks first, and Keep leaves the comments alone", () => {
    const comments = withComments([note()]);
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow comments={comments} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("Discard this comment?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(comments.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(vi.mocked(comments.update).mock.calls[0][0](comments.items)).toEqual([]);
    expect(comments.send).not.toHaveBeenCalled();
  });

  it("is off, with the reason, when the chat can't take a message", () => {
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow comments={withComments([note()], { send: undefined })} />);
    const send = screen.getByRole("button", { name: "Send to Claude" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Claude can't take a message right now.");
  });

  it("says Claude will get them after its turn when it is working", () => {
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow chatBusy comments={withComments([note()])} />);
    expect(screen.getByRole("button", { name: "Send to Claude" })).toHaveAttribute("title", "Claude is working: this goes in as soon as it's done");
  });

  it("stays in view when the file shown has no changes (comments on other files, another filter)", () => {
    render(<ReviewPanel {...base} files={[]} selected={null} follow comments={withComments([note()])} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 comment");
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });
});

describe("NetworkEmpty", () => {
  it("explains Network Monitor when it isn't running", () => {
    render(<NetworkEmpty link={{ status: "not_running" } as never} />);
    expect(screen.getByText(/Route your app's traffic through it/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /network-monitor/ })).toBeInTheDocument();
  });

  it("says how to add a watch when Network Monitor is running but nothing is watched", () => {
    render(<NetworkEmpty link={{ status: "connected" } as never} />);
    expect(screen.getByText(/Network Monitor is running, but nothing is watched yet/)).toBeInTheDocument();
    expect(screen.getByText(/Tell Claude which requests matter/)).toBeInTheDocument();
  });
});
