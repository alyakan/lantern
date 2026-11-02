import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboxItem } from "../lib/inbox";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { NO_DESKS } from "../lib/desks";
import type { RepoStatus } from "../types";
import { DeskView, type DeskViewProps } from "./DeskView";

const item = (slot: string, over: Partial<InboxItem> = {}): InboxItem => ({ key: slot, slot, kind: "permission", role: "chat", team: null, title: `Chat ${slot}`, where: "lantern", need: `Wants to use Bash in ${slot}`, since: Date.now() - 60_000, requestId: `r-${slot}`, canAllow: true, detail: `npm test ${slot}`, needsYou: true, ...over });
const row = (n: number, over: Partial<InboxRow> = {}): InboxRow => ({ slot: `s${n}`, title: `Chat ${n}`, folder: "/p/lantern", where: "lantern", workflow: "Chat", state: "done", unread: false, at: Date.now() - n * 60_000, line: `Did thing ${n}.`, ...over });
const repo = (folder: string, over: Partial<RepoStatus> = {}): RepoStatus => ({ repo: folder, github: `aly/${folder.split("/").pop()}`, folders: [{ folder, branch: "main", changed: 0 }], worktrees: [], gh: "ready", prs: [], merged: [], release: null, drafts: [], error: null, ...over });
const pr = (number: number, checks: RepoStatus["prs"][number]["checks"]) => ({ number, title: `PR ${number}`, author: "aly", branch: `b${number}`, draft: false, checks, review: null });
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
    ...over,
  };
  const view = render(<DeskView {...props} />);
  return { props, rerender: (more: Partial<DeskViewProps>) => view.rerender(<DeskView {...props} {...more} />) };
}

const arm = () => act(() => void vi.advanceTimersByTime(400));
const needs = () => screen.getByRole("region", { name: "Needs you" });

describe("the Desk", () => {
  beforeEach(() => {
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

  it("adds each project's branch, pull requests and release, and says why when GitHub can't be asked", () => {
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
    expect(lantern).toHaveTextContent("3 open · 1 failing");
    expect(within(lantern).getByTitle("1 with checks still running")).toBeInTheDocument();
    expect(lantern).toHaveTextContent("v0.1.93 · 1 draft");
    expect(within(lantern).getByTitle("Published 3h ago")).toBeInTheDocument();
    expect(rayak).toHaveTextContent("gh isn't logged in");
    // Not in a repository: dashes, not dots.
    expect(notes).not.toHaveTextContent("…");
  });

  it("lists what happened in the repositories today, what is left hanging first", () => {
    const now = new Date(2026, 9, 31, 18, 0).getTime();
    vi.setSystemTime(now);
    const at = (h: number, day = 31) => new Date(2026, 9, day, h).toISOString();
    setup({
      repos: [
        repo("/p/lantern", { prs: [pr(7, "fail"), pr(8, "pass")], merged: [{ number: 6, title: "Merged today", merged_at: at(15) }, { number: 5, title: "Merged yesterday", merged_at: at(15, 30) }], release: { tag: "v0.1.93", published_at: at(17) }, drafts: ["v0.1.94"] }),
        repo("/p/rayak"),
      ],
    });
    const lines = within(screen.getByRole("region", { name: "Repos today" })).getAllByRole("listitem").map((l) => l.textContent);
    expect(lines).toEqual([
      expect.stringMatching(/^✕Checks failing: #7 PR 7lantern$/),
      expect.stringMatching(/^◷Draft release waiting: v0\.1\.94lantern$/),
      expect.stringMatching(/^↑Released: v0\.1\.93lantern1h ago$/),
      expect.stringMatching(/^✓Merged: #6 Merged todaylantern3h ago$/),
    ]);
  });

  it("says a quiet day is quiet, and shows nothing before the Mac has said", () => {
    const { rerender } = setup();
    expect(screen.queryByRole("region", { name: "Repos today" })).toBeNull();
    rerender({ repos: [repo("/p/lantern")] });
    expect(screen.getByRole("region", { name: "Repos today" })).toHaveTextContent("Nothing merged, released or failing today.");
  });

  it("shows five of a busy day's lines, and the rest on asking", () => {
    const now = new Date(2026, 9, 31, 18, 0).getTime();
    vi.setSystemTime(now);
    const merged = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, merged_at: new Date(2026, 9, 31, 9 + i).toISOString() }));
    setup({ repos: [repo("/p/lantern", { merged })] });
    const region = screen.getByRole("region", { name: "Repos today" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(within(region).getByRole("button", { name: "Show 3 more" }));
    expect(within(region).getAllByRole("listitem")).toHaveLength(8);
  });
});
