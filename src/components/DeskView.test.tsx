import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { NO_DESKS } from "../lib/desks";
import type { RepoStatus } from "../types";
import { DeskView, type DeskViewProps } from "./DeskView";
import { forgetSent } from "./YourWork";

const item = (slot: string, over: Partial<InboxItem> = {}): InboxItem => ({ key: slot, slot, kind: "permission", role: "chat", team: null, title: `Chat ${slot}`, where: "lantern", need: `Wants to use Bash in ${slot}`, since: Date.now() - 60_000, requestId: `r-${slot}`, canAllow: true, detail: `npm test ${slot}`, needsYou: true, ...over });
const row = (n: number, over: Partial<InboxRow> = {}): InboxRow => ({ slot: `s${n}`, title: `Chat ${n}`, folder: "/p/lantern", where: "lantern", workflow: "Chat", state: "done", unread: false, at: Date.now() - n * 60_000, line: `Did thing ${n}.`, ...over });
const repo = (folder: string, over: Partial<RepoStatus> = {}): RepoStatus => ({ repo: folder, github: `aly/${folder.split("/").pop()}`, folders: [{ folder, branch: "main", changed: 0 }], worktrees: [], gh: "ready", prs: [], merged: [], release: null, drafts: [], viewer: "aly", branches: [], error: null, ...over });
const pr = (number: number, checks: RepoStatus["prs"][number]["checks"], over: Partial<RepoStatus["prs"][number]> = {}): RepoStatus["prs"][number] => ({ number, title: `PR ${number}`, author: "aly", branch: `b${number}`, draft: false, checks, review: null, mergeable: "MERGEABLE", merge_state: "BLOCKED", review_requests: [], ...over });
const merged = (number: number, merged_at: string, over: Partial<RepoStatus["merged"][number]> = {}): RepoStatus["merged"][number] => ({ number, title: `PR ${number}`, author: "aly", branch: `m${number}`, merged_at, ...over });
const project = (folder: string, over: Partial<ProjectRow> = {}): ProjectRow => ({ folder, label: folder.split("/").pop()!, chats: 1, working: 0, waiting: 0, asleep: 0, unread: 0, needs: 0, at: null, todos: { open: 0, overdue: 0 }, ...over });

function setup(over: Partial<DeskViewProps> = {}) {
  const props: DeskViewProps = {
    chats: [],
    projects: [],
    needs: [],
    repos: null,
    page: null,
    onPage: vi.fn(),
    onNewChat: vi.fn(),
    desks: { value: NO_DESKS, waiting: {}, projects: [], onChange: vi.fn(), onAdd: vi.fn() },
    onOpen: vi.fn(),
    onGo: vi.fn(),
    onDecide: vi.fn(),
    onStep: vi.fn(() => true),
    onRefreshRepos: vi.fn(),
    ...over,
  };
  const view = render(<DeskView {...props} />);
  return { props, rerender: (more: Partial<DeskViewProps>) => view.rerender(<DeskView {...props} {...more} />) };
}

const arm = () => act(() => void vi.advanceTimersByTime(400));
const needs = () => screen.getByRole("region", { name: "Needs you" });

describe("the Desk", () => {
  beforeEach(() => {
    forgetSent();
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows what needs you one thing at a time, with the whole command, and moves to the next on asking", () => {
    const { props } = setup({ needs: [item("a"), item("b")] });
    expect(within(needs()).getAllByRole("article")).toHaveLength(1);
    expect(within(needs()).getByText("Wants to use Bash in a")).toBeInTheDocument();
    expect(within(needs()).getByText("npm test a")).toBeInTheDocument();
    fireEvent.click(within(needs()).getByRole("button", { name: "1 more waiting" }));
    expect(within(needs()).getByText("Wants to use Bash in b")).toBeInTheDocument();
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenCalledWith(expect.objectContaining({ slot: "b" }), true);
  });

  it("arms Allow again for the next request, so a quick second click can't allow what just came into view", () => {
    const { props, rerender } = setup({ needs: [item("a"), item("b")] });
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat a" }));
    // The first is answered: the next takes its place, and a click right away does nothing.
    rerender({ needs: [item("b")] });
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenCalledTimes(1);
    arm();
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow Chat b" }));
    expect(props.onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ slot: "b" }), true);
  });

  it("answers what it can't show on one line from the chat's own card, opened in place: never from the summary", () => {
    const request = { type: "permission" as const, id: "r-e", toolName: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" }, decision: null, at: Date.now() };
    const onAnswer = vi.fn();
    const { rerender } = setup({ needs: [item("e", { kind: "permission", canAllow: false, detail: null, need: "Wants to edit a.ts", request }), item("f", { request: { ...request, id: "r-f" }, canAllow: false, detail: null })], onAnswer });
    expect(within(needs()).queryByRole("button", { name: /^Allow/ })).toBeNull();
    fireEvent.click(within(needs()).getByRole("button", { name: "Review Chat e" }));
    // The whole request, as the chat shows it.
    expect(needs().querySelector(".desk-request-full")?.textContent).toBe("/p/a.ts\n\n- a\n+ b");
    fireEvent.click(within(needs()).getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenCalledWith("e", "r-e", true, undefined, undefined, undefined);
    // The next one comes in closed: a second click can't allow what just came into view.
    rerender({ needs: [item("f", { request: { ...request, id: "r-f" }, canAllow: false, detail: null })], onAnswer });
    expect(within(needs()).queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("opens a plan, a question or an approval in place too", () => {
    const plan = { type: "permission" as const, id: "r-p", toolName: "ExitPlanMode", input: { plan: "1. Cap the retry at 8s" }, decision: null, at: Date.now() };
    const onAnswer = vi.fn();
    setup({ needs: [item("p", { kind: "plan", requestId: null, canAllow: false, detail: null, need: "Has a plan for you", request: plan })], onAnswer });
    fireEvent.click(within(needs()).getByRole("button", { name: "Review Chat p" }));
    expect(within(needs()).getByText(/Cap the retry at 8s/)).toBeInTheDocument();
  });

  it("lists the projects with what Lantern knows of each", () => {
    setup({ projects: [project("/p/lantern", { chats: 3, working: 2, waiting: 1, needs: 1, todos: { open: 3, overdue: 1 } }), project("/p/rayak", { chats: 0, todos: null })] });
    expect(screen.getByText("✓ Nothing needs you")).toBeInTheDocument();
    // With nothing waiting, the first tile sums the Desk up.
    expect(screen.getByRole("region", { name: "Summary" })).toHaveTextContent("Projects2Chats open3Working2Unread0To-dos overdue1");
    const [lantern, rayak] = within(screen.getByRole("region", { name: "Projects" })).getAllByRole("article");
    expect(lantern).toHaveTextContent("2 working · 1 needs you");
    expect(lantern).toHaveTextContent("3 · 1 overdue");
    expect(rayak).toHaveTextContent("none open");
    // A project with no chat has nothing to list under it, but its page still opens.
    expect(within(rayak).getByRole("button", { name: "Show the chats of rayak" })).toBeDisabled();
    expect(within(rayak).getByRole("button", { name: "rayak" })).toBeEnabled();
  });

  it("drops a project's chats down from its tile, the unread ones marked, and opens a chat on a click", () => {
    const { props } = setup({
      chats: [row(1, { unread: true }), row(2, { state: "working", line: "Bash: npm test" }), row(3, { folder: "/p/rayak", where: "rayak" })],
      projects: [project("/p/lantern", { chats: 2 }), project("/p/rayak")],
    });
    const tiles = screen.getByRole("region", { name: "Projects" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(tiles).getByRole("button", { name: "Show the chats of lantern" }));
    const menu = screen.getByRole("menu", { name: "Chats of lantern" });
    const unread = within(menu).getByRole("menuitem", { name: "Chat 1, unread" });
    expect(unread).toHaveClass("unread");
    expect(unread).toHaveTextContent("Did thing 1.");
    expect(within(menu).getByRole("menuitem", { name: "Chat 2" })).toHaveTextContent(/working.*Bash: npm test/);
    expect(within(menu).queryByRole("menuitem", { name: "Chat 3" })).toBeNull();
    // Escape puts it away; a chat picked from it opens, and puts it away too.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(tiles).getByRole("button", { name: "Show the chats of lantern" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat 1, unread" }));
    expect(props.onOpen).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("adds each project's branch, your work and release, and says why when GitHub can't be asked", () => {
    const now = Date.now();
    const repos = [
      repo("/p/lantern", { folders: [{ folder: "/p/lantern", branch: "feat/desk", changed: 4 }], prs: [pr(7, "fail"), pr(8, "pending"), pr(9, "pass")], release: { tag: "v0.1.93", published_at: new Date(now - 3 * 3_600_000).toISOString() }, drafts: ["v0.1.94"] }),
      repo("/p/rayak", { gh: "logged_out", error: "gh isn't logged in to GitHub." }),
    ];
    const { rerender } = setup({ projects: [project("/p/lantern"), project("/p/rayak"), project("/p/notes")] });
    // Before the Mac has said: nothing is claimed.
    const rows = () => within(screen.getByRole("region", { name: "Projects" })).getAllByRole("article");
    expect(rows()[0]).toHaveTextContent("…");
    rerender({ repos });
    const [lantern, rayak, notes] = rows();
    expect(lantern).toHaveTextContent("feat/desk · 4 changed");
    // A dot and a count for each state: #7 blocked, #9 yours to merge, #8 on its way.
    expect(within(lantern).getByLabelText("1 blocked, 2 your call, 1 waiting")).toBeInTheDocument();
    expect(lantern).toHaveTextContent("v0.1.93 · 1 draft");
    expect(within(lantern).getByTitle("Published 3h ago")).toBeInTheDocument();
    expect(rayak).toHaveTextContent("gh isn't logged in");
    // Not in a repository: dashes, not dots.
    expect(notes).not.toHaveTextContent("…");
  });

  it("puts your next steps first, yours to decide before what is blocked, and where each stands as nodes", () => {
    const now = new Date(2026, 9, 31, 18, 0).getTime();
    vi.setSystemTime(now);
    const at = (h: number, day = 31) => new Date(2026, 9, day, h).toISOString();
    setup({
      repos: [
        repo("/p/lantern", {
          prs: [pr(7, "fail"), pr(8, "pass"), pr(9, "pending"), pr(10, "pending", { author: "sara", review_requests: ["aly"] }), pr(11, "pass", { author: "sara" })],
          merged: [merged(6, at(15)), merged(5, at(9, 29))],
          release: { tag: "v0.1.93", published_at: at(10, 30) },
        }),
      ],
    });
    const next = within(screen.getByRole("region", { name: "Next" })).getAllByRole("listitem").map((l) => l.textContent);
    expect(next).toEqual([
      expect.stringMatching(/^Merge #8 PR 8Your callMerge…Ready to merge/),
      expect.stringMatching(/^Review #10 PR 10Do itYour review is asked · lantern · by @sara$/),
      expect.stringMatching(/^Release 1 pull request since v0\.1\.93Your callRelease…/),
      expect.stringMatching(/^Fix failing checks on #7 PR 7Do itChecks failing/),
    ]);
    const stand = within(screen.getByRole("region", { name: "Where things stand" }));
    // Someone else's pull request that doesn't ask for you isn't your work; one merged before the release is done.
    expect(stand.queryByText(/PR 11/)).toBeNull();
    expect(stand.queryByText(/PR 5/)).toBeNull();
    const failing = stand.getByRole("list", { name: "At Checks, blocked" });
    expect(within(failing).getAllByRole("listitem").map((n) => n.className)).toEqual(["yw-node yw-past", "yw-node yw-past", "yw-node yw-now", "yw-node", "yw-node", "yw-node"]);
  });

  it("sends a step to the chat on its branch once, and to a new chat when none is on it", () => {
    const onStep = vi.fn(() => true);
    const repos = [repo("/p/lantern", { folders: [{ folder: "/p/lantern", branch: "b7", changed: 0 }], prs: [pr(7, "fail"), pr(8, "fail")] })];
    setup({ repos, chats: [row(1, { folder: "/p/lantern" })], onStep });
    const next = within(screen.getByRole("region", { name: "Next" }));
    fireEvent.click(next.getByRole("button", { name: "Fix failing checks on #7" }));
    expect(onStep).toHaveBeenLastCalledWith(expect.objectContaining({ number: 7 }), { kind: "chat", slot: "s1", title: "Chat 1" });
    // Sent: it says so until #7 moves on, rather than offering the same step again.
    expect(next.getByText('Sent to "Chat 1"')).toBeInTheDocument();
    expect(next.queryByRole("button", { name: "Fix failing checks on #7" })).toBeNull();
    fireEvent.click(next.getByRole("button", { name: "Fix failing checks on #8" }));
    expect(onStep).toHaveBeenLastCalledWith(expect.objectContaining({ number: 8 }), { kind: "new", folder: "/p/lantern" });
  });

  it("doesn't send to a chat on the branch that is busy", () => {
    const onStep = vi.fn(() => true);
    const repos = [repo("/p/x", { folders: [{ folder: "/p/x", branch: "b3", changed: 0 }], prs: [pr(3, "fail")] })];
    setup({ repos, chats: [row(1, { folder: "/p/x", state: "working" })], onStep });
    const next = within(screen.getByRole("region", { name: "Next" }));
    expect(next.getByText("Its chat is working")).toBeInTheDocument();
    expect(next.queryByRole("button", { name: /Fix failing checks/ })).toBeNull();
  });

  it("sets Next apart in a card of its own, and groups where things stand by feature when Linear is connected", () => {
    const repos = [repo("/p/lantern", { prs: [pr(7, "fail", { branch: "aly/eng-1-a" }), pr(8, "pending")] })];
    const issue = { title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: "Sync", project_id: "p1", branch: null, links: [] };
    setup({ repos, linear: { work: { connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues: [{ identifier: "ENG-1", ...issue }], error: null }, teamOf: { "/p/lantern": "ENG" } } });
    expect(within(screen.getByRole("region", { name: "Next" })).getByRole("button", { name: "Fix failing checks on #7" })).toBeInTheDocument();
    const stand = screen.getByRole("region", { name: "Where things stand" });
    const sync = within(stand).getByRole("region", { name: "Sync" });
    expect(sync).toHaveTextContent("1 doing");
    // Under its feature's heading, a row doesn't name the feature again, but names the issue it is the work of.
    expect(within(sync).getByText(/^ENG-1 Sync it · lantern · aly\/eng-1-a$/)).toBeInTheDocument();
    expect(within(stand).getByRole("region", { name: "No feature" })).toHaveTextContent("PR 8");
  });

  it("says when there is no work open, asks again on Refresh, and shows nothing before the Mac has said", () => {
    const { rerender, props } = setup();
    expect(screen.queryByRole("region", { name: "Next" })).toBeNull();
    rerender({ repos: [repo("/p/lantern")] });
    const card = screen.getByRole("region", { name: "Next" });
    expect(card).toHaveTextContent("Nothing open");
    fireEvent.click(within(card).getByRole("button", { name: "Refresh" }));
    expect(props.onRefreshRepos).toHaveBeenCalled();
  });

  it("shows eight rows of where things stand, and the rest on asking", () => {
    const prs = Array.from({ length: 11 }, (_, i) => pr(i + 1, "pending"));
    setup({ repos: [repo("/p/lantern", { prs })] });
    const region = screen.getByRole("region", { name: "Where things stand" });
    expect(within(region).getAllByRole("list", { name: /^At / })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(within(screen.getByRole("region", { name: "Where things stand" })).getAllByRole("list", { name: /^At / })).toHaveLength(11);
  });

  it("groups where things stand by project without Linear, folds a group, and lets you group by none", () => {
    const repos = [repo("/p/lantern", { prs: [pr(7, "pending"), pr(8, "pending")] }), repo("/p/web", { prs: [pr(1, "fail")] })];
    setup({ repos });
    const stand = () => within(screen.getByRole("region", { name: "Where things stand" }));
    // Blocked first: the project with a failing check comes before the other.
    expect(stand().getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["web", "lantern"]);
    // Feature needs Linear.
    expect(stand().getByRole("radio", { name: "Feature" })).toBeDisabled();
    expect(stand().getByRole("radio", { name: "Project" })).toBeChecked();
    // A row doesn't name its project again under the project's heading.
    expect(within(stand().getByRole("region", { name: "lantern" })).getByText("b7")).toBeInTheDocument();
    fireEvent.click(stand().getByRole("button", { name: "lantern" }));
    expect(within(stand().getByRole("region", { name: "lantern" })).queryByText("PR 7")).toBeNull();
    expect(stand().getByRole("button", { name: "lantern" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(stand().getByRole("radio", { name: "None" }));
    expect(stand().queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(stand().getAllByRole("list", { name: /^At / })).toHaveLength(3);
  });

  it("filters where things stand by state, and says when nothing is in the states chosen", () => {
    const repos = [repo("/p/lantern", { prs: [pr(7, "pending"), pr(8, "fail"), pr(9, "pass")] })];
    setup({ repos });
    const stand = () => within(screen.getByRole("region", { name: "Where things stand" }));
    expect(stand().getAllByRole("list", { name: /^At / })).toHaveLength(3);
    fireEvent.click(stand().getByRole("button", { name: /^blocked 1/ }));
    expect(stand().getAllByRole("list", { name: /^At / })).toHaveLength(1);
    expect(stand().getByText("PR 8")).toBeInTheDocument();
    fireEvent.click(stand().getByRole("button", { name: /^waiting 1/ }));
    expect(stand().getAllByRole("list", { name: /^At / })).toHaveLength(2);
    fireEvent.click(stand().getByRole("button", { name: "Show all" }));
    expect(stand().getAllByRole("list", { name: /^At / })).toHaveLength(3);
  });

  it("shows five of Next's steps, the rest on asking", () => {
    const prs = Array.from({ length: 7 }, (_, i) => pr(i + 1, "fail"));
    setup({ repos: [repo("/p/lantern", { prs })] });
    const next = within(screen.getByRole("region", { name: "Next" }));
    expect(next.getAllByRole("button", { name: /^Fix failing checks/ })).toHaveLength(5);
    fireEvent.click(next.getByRole("button", { name: "Show 2 more" }));
    expect(next.getAllByRole("button", { name: /^Fix failing checks/ })).toHaveLength(7);
  });
});
