import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { WorkItem } from "../lib/yourWork";
import type { RepoStatus, StorageItem, StorageView } from "../types";
import { DeskProject, type DeskProjectProps } from "./DeskProject";
import { ProjectColors } from "./YourWork";

vi.mock("../api", () => {
  const fns: Record<string | symbol, unknown> = {};
  return { api: new Proxy(fns, { get: (all, name) => (all[name] ??= vi.fn(() => Promise.reject(new Error("not in Tauri")))) }) };
});

const row: ProjectRow = { folder: "/p/lantern", label: "lantern", chats: 1, working: 0, waiting: 0, asleep: 0, unread: 0, needs: 0, at: null, todos: { open: 2, overdue: 0 } };
const chat: InboxRow = { slot: "s1", title: "Fix the build", folder: "/p/lantern", where: "lantern", workflow: "Chat", state: "done", unread: true, at: Date.now() - 60_000, line: "Fixed." };
const wt = (path: string, over: Partial<RepoStatus["worktrees"][number]> = {}) => ({ path, branch: `b-${path.split("/").pop()}`, locked: false, agent: false, ...over });
const repo: RepoStatus = {
  repo: "/p/lantern",
  github: "aly/lantern",
  folders: [{ folder: "/p/lantern", branch: "feat/desk", changed: 2 }],
  worktrees: [wt("/wt/clean"), wt("/wt/dirty"), wt("/lantern/worktrees/w1", { agent: true, branch: null })],
  gh: "ready",
  prs: [{ number: 7, title: "feat: the Desk", author: "aly", branch: "feat/desk", base: "main", draft: false, checks: "fail", review: "REVIEW_REQUIRED", mergeable: "MERGEABLE", merge_state: "BLOCKED", review_requests: [] }],
  merged: [],
  release: null,
  drafts: [],
  viewer: "aly",
  branches: [],
  error: null,
};
const item = (id: string, path: string, over: Partial<StorageItem> = {}): StorageItem => ({ id, kind: "worktree", name: path, path, bytes: 2e9, risk: "safe", removal: "worktree", note: "", warning: null, ticked: true, idle_days: 3, within: null, suggestion: null, shared: false, ...over });
const view = (items: StorageItem[] | null): StorageView => ({ items: items ?? [], scanning: false, progress: "", scanned_at: items ? 1 : null, free_bytes: null, total_bytes: null, purgeable_bytes: null, snapshots: 0, notes: [], deleting: false });
/** An item of this repository's work, an issue of a Linear project (a feature). */
const wi = (identifier: string, tone: WorkItem["tone"], project: string): WorkItem => ({
  key: identifier,
  repo: "/p/lantern",
  name: "lantern",
  github: "aly/lantern",
  number: null,
  branch: null,
  title: `${identifier}, as its issue says`,
  stage: "issue",
  tone,
  word: tone === "bad" ? "Blocked" : tone === "todo" ? "Not started" : "Done",
  meta: identifier,
  at: null,
  next: null,
  sig: identifier,
  issue: { identifier, url: `https://linear.app/aly/issue/${identifier}`, project, title: `${identifier}, as its issue says` },
});

function setup(over: Partial<DeskProjectProps> = {}) {
  const props: DeskProjectProps = { row, chats: [chat], repo, now: Date.now(), onBack: vi.fn(), onOpen: vi.fn(), onNewChat: vi.fn(), ...over };
  render(<DeskProject {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(api.todosList).mockReset().mockResolvedValue({ key: "/p/lantern", items: [
    { id: "a", title: "Ship the Desk", done: false, created_at: 2, created_by: "user" },
    { id: "b", title: "Renew the cert", done: false, created_at: 1, created_by: "user", due: { date: "2026-11-02" } },
    { id: "c", title: "Done already", done: true, created_at: 3, created_by: "user" },
  ] });
  vi.mocked(api.onTodosChanged).mockReset().mockResolvedValue(() => {});
  vi.mocked(api.onStorageChanged).mockReset().mockResolvedValue(() => {});
  vi.mocked(api.storageState).mockReset().mockResolvedValue(view([item("i1", "/wt/clean"), item("i2", "/wt/dirty", { risk: "blocked", warning: "3 uncommitted changes that exist nowhere else." })]));
  vi.mocked(api.storageDelete).mockReset();
});

describe("a project's page on the Desk", () => {
  it("has its chats, its pull requests with their checks, and its open to-dos, the nearest due first", async () => {
    const props = setup();
    expect(screen.getByRole("heading", { name: "lantern" })).toBeInTheDocument();
    expect(screen.getByText("feat/desk", { selector: ".dp-project .dp-mono" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Chats" })).getByRole("button", { name: "Fix the build, unread" }));
    expect(props.onOpen).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "+ New chat here" }));
    expect(props.onNewChat).toHaveBeenCalledWith("/p/lantern");
    const prs = screen.getByRole("region", { name: "Pull requests" });
    expect(within(prs).getByRole("link", { name: /#7 feat: the Desk/ })).toHaveAttribute("href", "https://github.com/aly/lantern/pull/7");
    expect(prs).toHaveTextContent("checks failing");
    expect(prs).toHaveTextContent("needs a review");
    const todos = screen.getByRole("region", { name: "To-dos" });
    await waitFor(() => expect(within(todos).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Renew the certdue 2026-11-02", "Ship the Desk"]));
    fireEvent.click(screen.getByRole("button", { name: "‹ All projects" }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("wears its own colour and mark, and offers the features its open work is in, a chip opening each on the board below", () => {
    const work = [wi("ENG-1", "bad", "Sync"), wi("ENG-2", "todo", "Sync"), wi("ENG-3", "done", "Export")];
    const props: DeskProjectProps = { row, chats: [chat], repo, work, issues: true, now: Date.now(), onBack: vi.fn(), onOpen: vi.fn(), onNewChat: vi.fn() };
    render(
      <ProjectColors.Provider value={{ "/p/lantern": 2 }}>
        <DeskProject {...props} />
      </ProjectColors.Provider>,
    );
    // The colour the sidebar gives the project, so its page is plainly its own.
    const head = document.querySelector(".dp-project") as HTMLElement;
    expect(head.style.getPropertyValue("--proj")).toBe(PROJECT_COLORS[2]);
    expect(within(head).getByText("LA", { selector: ".dp-project-mark" })).toBeInTheDocument();
    expect(within(head).getByRole("heading", { name: "lantern" })).toBeInTheDocument();
    expect(within(head).getByText("feat/desk", { selector: ".dp-mono" })).toBeInTheDocument();
    expect(head.querySelector(".dp-project-meta")).toHaveTextContent("aly/lantern");
    // A feature with nothing open isn't offered: Export shipped, and shipped isn't work to open.
    const features = within(head).getByRole("group", { name: "Features" });
    expect(within(features).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open the feature Sync"]);
    expect(features).toHaveTextContent("1 doing");
    expect(features).toHaveTextContent("1 to start");
    // Its chip opens the feature's own page on the board below, and ‹ Work goes back to the cards.
    fireEvent.click(within(features).getByRole("button", { name: "Open the feature Sync" }));
    const page = screen.getByRole("region", { name: "Sync" });
    expect(within(page).getByRole("heading", { name: "Sync" })).toBeInTheDocument();
    expect(within(page).getByRole("tab", { name: /Needs you/ })).toHaveAttribute("aria-selected", "true");
    expect(within(page).getByText("ENG-1, as its issue says")).toBeInTheDocument();
    fireEvent.click(within(page).getByRole("button", { name: "‹ Work" }));
    expect(screen.queryByRole("region", { name: "Sync" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the feature Sync" })).toBeInTheDocument();
  });

  it("lists its worktrees, not an agent's, the safe ones first, and removes only a safe one, after asking", async () => {
    vi.mocked(api.storageDelete).mockResolvedValue([{ id: "i1", name: "/wt/clean", ok: true, freed: 2e9, error: null }]);
    setup();
    const wts = screen.getByRole("region", { name: "Worktrees" });
    await waitFor(() => expect(wts).toHaveTextContent("1 safe to remove, 2.0 GB in all."));
    const rows = within(wts).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".dp-tone")?.textContent)).toEqual(["Safe to remove", "Keep"]);
    expect(rows[0]).toHaveTextContent("2.0 GB");
    expect(rows[1]).toHaveTextContent("3 uncommitted changes that exist nowhere else.");
    // Only the safe one can be removed, and only once asked.
    expect(within(wts).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    expect(wts).not.toHaveTextContent("w1");
    fireEvent.click(within(wts).getByRole("button", { name: "Remove clean…" }));
    expect(api.storageDelete).not.toHaveBeenCalled();
    fireEvent.click(within(wts).getByRole("button", { name: "Remove the worktree clean" }));
    expect(api.storageDelete).toHaveBeenCalledWith(["i1"]);
  });

  it("says what went wrong when Storage wouldn't remove it", async () => {
    vi.mocked(api.storageDelete).mockResolvedValue([{ id: "i1", name: "/wt/clean", ok: false, freed: 0, error: "It changed since the scan: look again." }]);
    setup();
    const wts = screen.getByRole("region", { name: "Worktrees" });
    fireEvent.click(await within(wts).findByRole("button", { name: "Remove clean…" }));
    fireEvent.click(within(wts).getByRole("button", { name: "Remove the worktree clean" }));
    await waitFor(() => expect(wts).toHaveTextContent("It changed since the scan: look again."));
    expect(wts).toHaveTextContent("Not removed");
  });

  it("offers a scan when Storage hasn't scanned, and removes nothing before it has", async () => {
    vi.mocked(api.storageState).mockResolvedValue(view(null));
    vi.mocked(api.storageScan).mockReset().mockResolvedValue(true);
    setup();
    const wts = screen.getByRole("region", { name: "Worktrees" });
    fireEvent.click(await within(wts).findByRole("button", { name: "Scan now" }));
    expect(api.storageScan).toHaveBeenCalled();
    expect(within(wts).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("says why there are no pull requests when GitHub can't be asked", () => {
    setup({ repo: { ...repo, gh: "logged_out", prs: [], worktrees: [] } });
    expect(screen.getByRole("region", { name: "Pull requests" })).toHaveTextContent("gh isn't logged in to GitHub.");
    expect(screen.queryByRole("region", { name: "Worktrees" })).toBeNull();
  });

  it("offers no Remove for a worktree with a chat open in it, whatever an older scan says", async () => {
    setup({ repo: { ...repo, folders: [...repo.folders, { folder: "/wt/clean", branch: "b-clean", changed: 0 }] } });
    const wts = screen.getByRole("region", { name: "Worktrees" });
    await waitFor(() => expect(wts).toHaveTextContent("A chat is open in it."));
    expect(wts).toHaveTextContent("Chat open");
    expect(within(wts).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });
});
