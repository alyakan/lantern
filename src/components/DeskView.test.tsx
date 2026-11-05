import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import type { RepoStatus } from "../types";
import { DeskView, type DeskViewProps } from "./DeskView";
import { forgetSent, PastChats, ProjectColors } from "./YourWork";

const item = (slot: string, over: Partial<InboxItem> = {}): InboxItem => ({ key: slot, slot, kind: "permission", role: "chat", team: null, title: `Chat ${slot}`, where: "lantern", need: `Wants to use Bash in ${slot}`, since: Date.now() - 60_000, requestId: `r-${slot}`, canAllow: true, detail: `npm test ${slot}`, needsYou: true, ...over });
const row = (n: number, over: Partial<InboxRow> = {}): InboxRow => ({ slot: `s${n}`, title: `Chat ${n}`, folder: "/p/lantern", where: "lantern", workflow: "Chat", state: "done", unread: false, at: Date.now() - n * 60_000, line: `Did thing ${n}.`, ...over });
const repo = (folder: string, over: Partial<RepoStatus> = {}): RepoStatus => ({ repo: folder, github: `aly/${folder.split("/").pop()}`, folders: [{ folder, branch: "main", changed: 0 }], worktrees: [], gh: "ready", prs: [], merged: [], release: null, drafts: [], viewer: "aly", branches: [], error: null, ...over });
const pr = (number: number, checks: RepoStatus["prs"][number]["checks"], over: Partial<RepoStatus["prs"][number]> = {}): RepoStatus["prs"][number] => ({ number, title: `PR ${number}`, author: "aly", branch: `b${number}`, base: "main", draft: false, checks, review: null, mergeable: "MERGEABLE", merge_state: "BLOCKED", review_requests: [], ...over });
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
    onOpen: vi.fn(),
    onGo: vi.fn(),
    onDecide: vi.fn(),
    onStep: vi.fn(() => true),
    onRefreshRepos: vi.fn(),
    onAsk: vi.fn(),
    ...over,
  };
  const view = render(<DeskView {...props} />);
  return { props, rerender: (more: Partial<DeskViewProps>) => view.rerender(<DeskView {...props} {...more} />) };
}

const arm = () => act(() => void vi.advanceTimersByTime(400));
const needs = () => screen.getByRole("region", { name: "Needs you" });

/** The list layout of where things stand (the default is cards): these tests are about the list. */
const list = () => localStorage.setItem("desk.work.layout", JSON.stringify("list"));

/** What a row of where things stand is: a button that opens its details. */
const ROW = "Details, links and the chat on it";

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
    // With nothing waiting, one line above the board sums the Desk up.
    const pulse = screen.getByRole("status", { name: "Where the Desk stands" });
    expect(pulse).toHaveTextContent("✓ Nothing needs you");
    expect(pulse).toHaveTextContent("3 chats open");
    expect(pulse).toHaveTextContent("2 working");
    expect(pulse).toHaveTextContent("1 to-do overdue");
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

  it("offers Bypass & merge, in a warning, for a pull request whose required review nobody gave, and a plain Merge once it is approved", () => {
    setup({ repos: [repo("/p/lantern", { prs: [pr(12, "pass", { review: "REVIEW_REQUIRED" }), pr(13, "pass", { review: "APPROVED" })] })] });
    const next = within(screen.getByRole("region", { name: "Next" }));
    const bypass = next.getByRole("button", { name: "Bypass review and merge #12" });
    expect(bypass).toHaveTextContent("Bypass & merge…");
    expect(bypass).toHaveClass("yw-bypass");
    expect(bypass.closest("li")).toHaveClass("yw-warn");
    expect(bypass.closest("li")).toHaveTextContent("Bypasses review");
    const merge = next.getByRole("button", { name: "Merge #13" });
    expect(merge).toHaveClass("yw-yours");
    expect(merge.closest("li")).not.toHaveClass("yw-warn");
  });

  it("folds what is merged and waiting for a release into one line, which opens to a row each", () => {
    list();
    const now = new Date(2026, 9, 31, 18, 0).getTime();
    vi.setSystemTime(now);
    const at = (h: number, day = 31) => new Date(2026, 9, day, h).toISOString();
    setup({ repos: [repo("/p/lantern", { merged: [merged(6, at(15)), merged(5, at(14))], release: { tag: "v0.1.93", published_at: at(10, 30) } })], page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = within(screen.getByRole("region", { name: "Where things stand" }));
    const line = stand.getByRole("button", { name: /2 Ready · merged, waiting for a release/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(stand.queryByText(/PR 6/)).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(stand.getByText(/PR 6/)).toBeInTheDocument();
    expect(stand.getByText(/PR 5/)).toBeInTheDocument();
  });

  it("puts your next steps first, yours to decide before what is blocked, and where each stands as nodes", () => {
    list();
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
      page: "/p/lantern",
      projects: [project("/p/lantern")],
    });
    const next = within(screen.getByRole("region", { name: "Next" })).getAllByRole("listitem").map((l) => l.textContent);
    expect(next).toEqual([
      expect.stringMatching(/^Merge #8 PR 8Merge…Your callReady to merge/),
      // Yours to decide says so on its pill; the others say where they stand there.
      expect.stringMatching(/^Review #10 PR 10Do itYour review is askedlantern · by @sara$/),
      expect.stringMatching(/^Release 1 pull request since v0\.1\.93Release…Your call/),
      expect.stringMatching(/^Fix failing checks on #7 PR 7Do itChecks failing/),
    ]);
    const stand = within(screen.getByRole("region", { name: "Where things stand" }));
    // Someone else's pull request that doesn't ask for you isn't your work; one merged before the release is done.
    expect(stand.queryByText(/PR 11/)).toBeNull();
    expect(stand.queryByText(/PR 5/)).toBeNull();
    // A row is two quiet lines; its path is in its details.
    expect(stand.queryAllByRole("list", { name: /^At / })).toHaveLength(0);
    fireEvent.click(stand.getByRole("button", { name: /#7 PR 7/ }));
    const failing = within(screen.getByRole("dialog")).getByRole("list", { name: "At Checks, blocked" });
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

  it("opens an item's details from its row: the chat on its branch, its stack and its pages", () => {
    list();
    const ready = { review: "APPROVED", merge_state: "CLEAN" };
    const repos = [repo("/p/lantern", { folders: [{ folder: "/p/lantern", branch: "s2", changed: 0 }], prs: [pr(1, "pass", { ...ready, branch: "s1" }), pr(2, "pass", { ...ready, branch: "s2", base: "s1" })] })];
    const { props } = setup({ repos, chats: [row(4, { folder: "/p/lantern", state: "working" })], page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = within(screen.getByRole("region", { name: "Where things stand" }));
    // A stack's rows sit together, bottom first, each saying its place.
    expect(stand.getAllByTitle(ROW).map((b) => b.textContent)).toEqual([expect.stringMatching(/^#1 PR 1.*stack 1 of 2$/), expect.stringMatching(/^#2 PR 2.*stack 2 of 2 · on #1$/)]);
    fireEvent.click(stand.getAllByTitle(ROW)[1]);
    const detail = within(screen.getByRole("dialog"));
    // Its step, which waits while its chat is busy.
    expect(detail.getByText("Merge the stack up to…")).toBeInTheDocument();
    expect(detail.getByText("Its chat is working")).toBeInTheDocument();
    // The chat working on its branch opens even while it works (nothing is sent to it).
    fireEvent.click(detail.getByRole("button", { name: "Open chat" }));
    expect(props.onOpen).toHaveBeenCalledWith("s4");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds the last chat about an item by its branch, then its issue, and opens it", async () => {
    vi.useRealTimers();
    const hit = { id: "sess-1", title: [{ text: "Fix sync retries", hit: false }], folder: "/p/wt", project: "lantern", updated_ms: Date.now() - 3_600_000, snippets: [] };
    const find = vi.fn(async (q: string) => ({ chats: q === "ENG-1" ? [hit] : [], partial: false, cancelled: false }));
    const open = vi.fn();
    const issue = { identifier: "ENG-1", title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: null, project_id: null, branch: null, links: [] };
    const props = { chats: [], projects: [project("/p/lantern")], needs: [], page: "/p/lantern", onPage: vi.fn(), onNewChat: vi.fn(), onOpen: vi.fn(), onGo: vi.fn(), onDecide: vi.fn(), onStep: vi.fn(() => true), onRefreshRepos: vi.fn(), onAsk: vi.fn() };
    const repos = [repo("/p/lantern", { prs: [pr(7, "pending", { branch: "aly/eng-1-sync" })] })];
    render(
      <PastChats.Provider value={{ find, open }}>
        <DeskView {...props} repos={repos} linear={{ work: { connected: true, viewer: "Aly", org: "A", teams: [], issues: [issue], error: null }, teamOf: { "/p/lantern": "ENG" } }} />
      </PastChats.Provider>,
    );
    fireEvent.click(within(screen.getByRole("region", { name: "Where things stand" })).getByRole("button", { name: /#7 PR 7/ }));
    const last = await within(screen.getByRole("dialog")).findByRole("button", { name: /^Last chat · Fix sync retries/ });
    expect(find.mock.calls.map((c) => c[0])).toEqual(["aly/eng-1-sync", "ENG-1"]);
    fireEvent.click(last);
    expect(open).toHaveBeenCalledWith("sess-1", "/p/wt");
  });

  it("tags each of Next's steps with its project, in the project's sidebar colour, when the Desk has several", () => {
    const props = { chats: [], projects: [project("/p/lantern"), project("/p/web")], needs: [], page: null, onPage: vi.fn(), onNewChat: vi.fn(), onOpen: vi.fn(), onGo: vi.fn(), onDecide: vi.fn(), onStep: vi.fn(() => true), onRefreshRepos: vi.fn(), onAsk: vi.fn() };
    const repos = [repo("/p/lantern", { prs: [pr(7, "fail")] }), repo("/p/web", { github: "aly/web", prs: [pr(3, "fail")] })];
    render(
      <ProjectColors.Provider value={{ "/p/web": 2 }}>
        <DeskView {...props} repos={repos} />
      </ProjectColors.Provider>,
    );
    const next = screen.getByRole("region", { name: "Next" });
    const tags = [...next.querySelectorAll(".yw-project-tag")] as HTMLElement[];
    expect(tags.map((t) => t.textContent).sort()).toEqual(["lantern", "web"]);
    expect(tags.find((t) => t.textContent === "web")!.style.getPropertyValue("--tag")).toBe("#c2255c");
    // The quiet line no longer says the project the tag says.
    expect(within(next).getByText("b3")).toBeInTheDocument();
  });

  it("doesn't send to a chat on the branch that is busy", () => {
    const onStep = vi.fn(() => true);
    const repos = [repo("/p/x", { folders: [{ folder: "/p/x", branch: "b3", changed: 0 }], prs: [pr(3, "fail")] })];
    setup({ repos, chats: [row(1, { folder: "/p/x", state: "working" })], onStep });
    const next = within(screen.getByRole("region", { name: "Next" }));
    expect(next.getByText("Its chat is working")).toBeInTheDocument();
    expect(next.queryByRole("button", { name: "Fix failing checks on #3" })).toBeNull();
  });

  it("sets Next apart in a card of its own, and groups where things stand by feature when Linear is connected", () => {
    list();
    const repos = [repo("/p/lantern", { prs: [pr(7, "fail", { branch: "aly/eng-1-a" }), pr(8, "pending")] })];
    const issue = { title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: "Sync", project_id: "p1", branch: null, links: [] };
    setup({ repos, linear: { work: { connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues: [{ identifier: "ENG-1", ...issue }], error: null }, teamOf: { "/p/lantern": "ENG" } }, page: "/p/lantern", projects: [project("/p/lantern")] });
    expect(within(screen.getByRole("region", { name: "Next" })).getByRole("button", { name: "Fix failing checks on #7" })).toBeInTheDocument();
    const stand = screen.getByRole("region", { name: "Where things stand" });
    // Features start folded; the whole board opens from its one control.
    fireEvent.click(within(stand).getByRole("button", { name: "Expand all" }));
    const sync = within(stand).getByRole("region", { name: "Sync" });
    expect(sync).toHaveTextContent("1 doing");
    // Under its feature's heading, a row doesn't name the feature again, but names the issue it is the work of; its details link to it.
    expect(within(sync).getByText("ENG-1 · lantern · aly/eng-1-a")).toBeInTheDocument();
    fireEvent.click(within(sync).getByRole("button", { name: /#7 PR 7/ }));
    const detail = within(screen.getByRole("dialog"));
    const chip = detail.getByRole("link", { name: /ENG-1\s*Sync it/ });
    expect(chip).toHaveAttribute("href", "https://linear.app/a/issue/ENG-1");
    expect(detail.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/aly/lantern/pull/7");
    expect(detail.getByRole("link", { name: "Linear" })).toHaveAttribute("href", "https://linear.app/a/issue/ENG-1");
    fireEvent.click(detail.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sync).toHaveTextContent("Feature · Linear project");
    expect(within(stand).getByRole("region", { name: "No feature" })).toHaveTextContent("PR 8");
  });

  const linearRepos = () => [repo("/p/lantern", { prs: [pr(7, "fail", { branch: "aly/eng-1-a" }), pr(8, "pending")] })];
  const linearOf = () => {
    const issue = { title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: "Sync", project_id: "p1", branch: null, links: [] };
    return { work: { connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues: [{ identifier: "ENG-1", ...issue }], error: null }, teamOf: { "/p/lantern": "ENG" } };
  };

  it("draws where things stand as a card for each feature, which opens to four tabs of rows that each show their pipeline, and goes back", () => {
    setup({ repos: linearRepos(), linear: linearOf(), page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = screen.getByRole("region", { name: "Where things stand" });
    // No filter bar or grouping switch: the cards and their tabs are how it is looked at.
    expect(within(stand).queryByRole("radiogroup", { name: "Group by" })).toBeNull();
    expect(within(stand).getByRole("button", { name: /^No feature, 1 open/ })).toBeInTheDocument();
    fireEvent.click(within(stand).getByRole("button", { name: /^Sync, 1 open/ }));
    const sync = within(screen.getByRole("region", { name: "Sync" }));
    expect(sync.getByRole("tab", { name: /^Needs you/ })).toHaveAttribute("aria-selected", "true");
    for (const name of ["Moving", "To start", "Shipped"]) expect(sync.getByRole("tab", { name })).toBeInTheDocument();
    // A row carries the item's pipeline and its step.
    expect(sync.getByRole("button", { name: /#7 PR 7/ })).toBeInTheDocument();
    expect(sync.getByLabelText(/^At Checks/)).toBeInTheDocument();
    expect(sync.getByRole("button", { name: "Fix failing checks on #7" })).toBeInTheDocument();
    fireEvent.click(sync.getByRole("tab", { name: "Moving" }));
    expect(sync.getByText("Nothing here.")).toBeInTheDocument();
    fireEvent.click(sync.getByRole("button", { name: "‹ Work" }));
    expect(within(screen.getByRole("region", { name: "Where things stand" })).getByRole("button", { name: /^Sync, 1 open/ })).toBeInTheDocument();
  });

  it("opens an item's details from a row of a feature's page", () => {
    setup({ repos: linearRepos(), linear: linearOf(), page: "/p/lantern", projects: [project("/p/lantern")] });
    fireEvent.click(screen.getByRole("button", { name: /^Sync, 1 open/ }));
    fireEvent.click(within(screen.getByRole("region", { name: "Sync" })).getByRole("button", { name: /#7 PR 7/ }));
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/aly/lantern/pull/7");
  });

  it("switches between the cards and the list, and remembers which", () => {
    setup({ repos: linearRepos(), linear: linearOf(), page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = () => within(screen.getByRole("region", { name: "Where things stand" }));
    expect(stand().getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(stand().getByRole("button", { name: "List" }));
    expect(stand().getByRole("radiogroup", { name: "Group by" })).toBeInTheDocument();
    expect(localStorage.getItem("desk.work.layout")).toBe('"list"');
    fireEvent.click(stand().getByRole("button", { name: "Cards" }));
    expect(stand().queryByRole("radiogroup", { name: "Group by" })).toBeNull();
    expect(localStorage.getItem("desk.work.layout")).toBe('"cards"');
  });

  it("keeps a card for each feature whatever grouping the list was left on", () => {
    localStorage.setItem("desk.work.groupBy", JSON.stringify("none"));
    setup({ repos: linearRepos(), linear: linearOf(), page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = within(screen.getByRole("region", { name: "Where things stand" }));
    expect(stand.getByRole("button", { name: /^Sync, 1 open/ })).toBeInTheDocument();
    expect(stand.getByRole("button", { name: /^No feature, 1 open/ })).toBeInTheDocument();
  });

  it("opens straight to the page when everything is in one feature or project, with no card to go back to", () => {
    setup({ repos: linearRepos(), page: "/p/lantern", projects: [project("/p/lantern")] });
    const page = within(screen.getByRole("region", { name: "lantern" }));
    expect(page.queryByRole("button", { name: "‹ Work" })).toBeNull();
    expect(page.getByRole("tab", { name: /^Needs you/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(page.getByRole("tab", { name: "Moving" }));
    expect(page.getByText(/PR 8/)).toBeInTheDocument();
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
    list();
    const prs = Array.from({ length: 11 }, (_, i) => pr(i + 1, "pending"));
    setup({ repos: [repo("/p/lantern", { prs })], page: "/p/lantern", projects: [project("/p/lantern")] });
    const region = screen.getByRole("region", { name: "Where things stand" });
    expect(within(region).getAllByTitle(ROW)).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(within(screen.getByRole("region", { name: "Where things stand" })).getAllByTitle(ROW)).toHaveLength(11);
  });

  it("filters where things stand by state, and says when nothing is in the states chosen", () => {
    list();
    const repos = [repo("/p/lantern", { prs: [pr(7, "pending"), pr(8, "fail"), pr(9, "pass")] })];
    setup({ repos, page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = () => within(screen.getByRole("region", { name: "Where things stand" }));
    expect(stand().getAllByTitle(ROW)).toHaveLength(3);
    fireEvent.click(stand().getByRole("button", { name: /^blocked 1/ }));
    expect(stand().getAllByTitle(ROW)).toHaveLength(1);
    expect(stand().getByText("PR 8")).toBeInTheDocument();
    fireEvent.click(stand().getByRole("button", { name: /^waiting 1/ }));
    expect(stand().getAllByTitle(ROW)).toHaveLength(2);
    fireEvent.click(stand().getByRole("button", { name: "Show all" }));
    expect(stand().getAllByTitle(ROW)).toHaveLength(3);
  });

  it("folds Next to its first steps, and opens it again", () => {
    setup({ repos: [repo("/p/lantern", { prs: [pr(1, "fail"), pr(2, "fail")] })] });
    const next = within(screen.getByRole("region", { name: "Next" }));
    expect(next.getAllByRole("listitem").length).toBeGreaterThan(0);
    fireEvent.click(next.getByRole("button", { name: "Collapse" }));
    expect(next.queryAllByRole("listitem")).toHaveLength(0);
    expect(next.getByText(/#1 PR 1/)).toBeInTheDocument();
    fireEvent.click(next.getByRole("button", { name: "Expand" }));
    expect(next.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows five of Next's steps, the rest on asking", () => {
    const prs = Array.from({ length: 7 }, (_, i) => pr(i + 1, "fail"));
    setup({ repos: [repo("/p/lantern", { prs })] });
    const next = within(screen.getByRole("region", { name: "Next" }));
    expect(next.getAllByRole("button", { name: /^Fix failing checks on #\d+$/ })).toHaveLength(5);
    fireEvent.click(next.getByRole("button", { name: "Show 2 more" }));
    expect(next.getAllByRole("button", { name: /^Fix failing checks on #\d+$/ })).toHaveLength(7);
  });

  it("hides its scrollbar while its width changes (the sidebar opening or closing) and a moment after, so the system's flash of one isn't seen", () => {
    let width = 900;
    let resized: () => void = () => {};
    const widthOf = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resized = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      setup();
      const main = document.querySelector(".desk-main")!;
      expect(main).not.toHaveClass("resizing");
      // Only what changes the width counts: a change of what scrolls inside it doesn't hide the bar.
      act(() => resized());
      expect(main).not.toHaveClass("resizing");
      width = 1040;
      act(() => resized());
      expect(main).toHaveClass("resizing");
      act(() => void vi.advanceTimersByTime(300));
      width = 1100;
      act(() => resized());
      act(() => void vi.advanceTimersByTime(300));
      expect(main).toHaveClass("resizing");
      act(() => void vi.advanceTimersByTime(200));
      expect(main).not.toHaveClass("resizing");
    } finally {
      widthOf.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("folds each feature to its name and the work in it, and opens them all at once", () => {
    list();
    const repos = [repo("/p/lantern", { prs: [pr(7, "fail", { branch: "aly/eng-1-a" }), pr(8, "pending")] })];
    const issue = { title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: "Sync", project_id: "p1", branch: null, links: [] };
    setup({
      repos,
      linear: { work: { connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues: [{ identifier: "ENG-1", ...issue }], error: null }, teamOf: { "/p/lantern": "ENG" } },
      page: "/p/lantern",
      projects: [project("/p/lantern")],
    });
    const stand = screen.getByRole("region", { name: "Where things stand" });
    // Folded: no rows, but the feature says what is in it.
    expect(within(stand).queryAllByTitle(ROW)).toHaveLength(0);
    expect(stand).toHaveTextContent("#7 PR 7");
    fireEvent.click(within(stand).getByRole("button", { name: "Expand all" }));
    expect(within(stand).getAllByTitle(ROW).length).toBeGreaterThan(0);
    expect(within(stand).getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
  });

  it("gives a project's page its own work first, and only that project's", () => {
    const here = repo("/p/lantern", { prs: [pr(1, "fail", { title: "Retry the fetch" })] });
    const elsewhere = repo("/p/other", { prs: [pr(2, "pass", { title: "Another repository" })] });
    setup({ repos: [here, elsewhere], projects: [project("/p/lantern"), project("/p/other")], page: "/p/lantern" });
    // Where things stand comes before Next: the page opens on where its work stands.
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(heads.indexOf("Where things stand")).toBeGreaterThanOrEqual(0);
    expect(heads.indexOf("Where things stand")).toBeLessThan(heads.indexOf("Next"));
    expect(screen.getByRole("region", { name: "Where things stand" })).toHaveTextContent("Retry the fetch");
    expect(screen.getByRole("region", { name: "Where things stand" })).not.toHaveTextContent("Another repository");
  });

  it("opens a project's page with nothing on its board on a landing page that starts a chat", () => {
    const { props } = setup({ repos: [repo("/p/lantern")], projects: [project("/p/lantern")], page: "/p/lantern" });
    const landing = screen.getByRole("region", { name: "Start here" });
    expect(screen.queryByRole("region", { name: "Where things stand" })).toBeNull();
    // An empty chat is the plain new chat.
    fireEvent.click(within(landing).getByRole("button", { name: "Empty chat" }));
    expect(props.onNewChat).toHaveBeenCalledWith("/p/lantern");
  });

  it("starts a typed first message in the project, through the app's handler", () => {
    const onStartChat = vi.fn();
    setup({ repos: [repo("/p/lantern")], projects: [project("/p/lantern")], page: "/p/lantern", onStartChat });
    const landing = screen.getByRole("region", { name: "Start here" });
    fireEvent.change(within(landing).getByRole("textbox"), { target: { value: "Fix the flaky test" } });
    fireEvent.click(within(landing).getByRole("button", { name: "Start chat" }));
    expect(onStartChat).toHaveBeenCalledWith("/p/lantern", "Fix the flaky test");
  });

  it("keeps the landing page away while there is work on the board, and while the repositories are still being read", () => {
    const { rerender } = setup({ repos: null, projects: [project("/p/lantern")], page: "/p/lantern" });
    expect(screen.queryByRole("region", { name: "Start here" })).toBeNull();
    rerender({ repos: [repo("/p/lantern", { prs: [pr(1, "fail")] })] });
    expect(screen.queryByRole("region", { name: "Start here" })).toBeNull();
    expect(screen.getByRole("region", { name: "Where things stand" })).toBeInTheDocument();
  });

  it("says a project outside any repository has no branches to follow, and still offers a chat", () => {
    setup({ repos: [repo("/p/other")], projects: [project("/p/lantern")], page: "/p/lantern" });
    const landing = screen.getByRole("region", { name: "Start here" });
    expect(within(landing).getByText(/isn't in a git repository/)).toBeInTheDocument();
    expect(within(landing).getByRole("button", { name: "Start chat" })).toBeInTheDocument();
  });

  it("lets a page's work be grouped by none, with Feature needing Linear", () => {
    list();
    setup({ repos: [repo("/p/lantern", { prs: [pr(7, "pending"), pr(8, "pending")] })], page: "/p/lantern", projects: [project("/p/lantern")] });
    const stand = () => within(screen.getByRole("region", { name: "Where things stand" }));
    expect(stand().getByRole("radio", { name: "Feature" })).toBeDisabled();
    fireEvent.click(stand().getByRole("radio", { name: "None" }));
    expect(stand().getByRole("radio", { name: "None" })).toBeChecked();
    expect(stand().queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(stand().getAllByTitle(ROW)).toHaveLength(2);
    // Kept for next time.
    expect(JSON.parse(localStorage.getItem("desk.work.groupBy") ?? "null")).toBe("none");
  });

  it("says nothing is to do when Next is folded and has no steps, and remembers it folded", () => {
    const { rerender } = setup({ repos: [repo("/p/lantern")], projects: [project("/p/lantern")] });
    const next = () => within(screen.getByRole("region", { name: "Next" }));
    fireEvent.click(next().getByRole("button", { name: "Collapse" }));
    expect(next().getByText("Nothing to do right now.")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("desk.work.nextClosed") ?? "null")).toBe(true);
    rerender({ repos: [repo("/p/lantern")] });
    expect(next().getByRole("button", { name: "Expand" })).toBeInTheDocument();
  });

  it("remembers which features are open, by grouping and feature", () => {
    list();
    const repos = [repo("/p/lantern", { prs: [pr(7, "fail", { branch: "aly/eng-1-a" })] })];
    const issue = { title: "Sync it", url: "https://linear.app/a/issue/ENG-1", priority: 3, due: null, state: "In Progress", state_type: "started", team: "ENG", project: "Sync", project_id: "p1", branch: null, links: [] };
    setup({
      repos,
      linear: { work: { connected: true, viewer: "Aly", org: "A", teams: [{ key: "ENG", name: "Eng" }], issues: [{ identifier: "ENG-1", ...issue }], error: null }, teamOf: { "/p/lantern": "ENG" } },
      page: "/p/lantern",
      projects: [project("/p/lantern")],
    });
    const stand = () => screen.getByRole("region", { name: "Where things stand" });
    // Only one group: a click on the feature opens it (no Expand all), and the choice is saved by grouping and feature name.
    expect(within(stand()).queryByRole("button", { name: "Expand all" })).toBeNull();
    fireEvent.click(within(stand()).getByRole("button", { name: /Sync/ }));
    expect(JSON.parse(localStorage.getItem("desk.work.open") ?? "[]")).toEqual(["feature:Sync"]);
    expect(within(stand()).getAllByTitle(ROW).length).toBeGreaterThan(0);
    fireEvent.click(within(stand()).getByRole("button", { name: /Sync/ }));
    expect(JSON.parse(localStorage.getItem("desk.work.open") ?? "[]")).toEqual([]);
  });
});
