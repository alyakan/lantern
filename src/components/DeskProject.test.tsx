import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { InboxRow, ProjectRow } from "../lib/deskBoard";
import type { RepoStatus, StorageItem, StorageView } from "../types";
import { DeskProject, type DeskProjectProps } from "./DeskProject";

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
  prs: [{ number: 7, title: "feat: the Desk", author: "aly", branch: "feat/desk", draft: false, checks: "fail", review: "REVIEW_REQUIRED" }],
  merged: [],
  release: null,
  drafts: [],
  error: null,
};
const item = (id: string, path: string, over: Partial<StorageItem> = {}): StorageItem => ({ id, kind: "worktree", name: path, path, bytes: 2e9, risk: "safe", removal: "worktree", note: "", warning: null, ticked: true, idle_days: 3, within: null, suggestion: null, ...over });
const view = (items: StorageItem[] | null): StorageView => ({ items: items ?? [], scanning: false, progress: "", scanned_at: items ? 1 : null, free_bytes: null, snapshots: 0, notes: [], deleting: false });

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
    expect(screen.getByText("feat/desk", { selector: ".desk-page-head .desk-branch" })).toBeInTheDocument();
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

  it("lists its worktrees with what the Storage scan says, and removes only a safe one, after asking", async () => {
    vi.mocked(api.storageDelete).mockResolvedValue([{ id: "i1", name: "/wt/clean", ok: true, freed: 2e9, error: null }]);
    setup();
    const wts = screen.getByRole("region", { name: "Worktrees" });
    await waitFor(() => expect(wts).toHaveTextContent("Safe to remove · 2.0 GB"));
    expect(wts).toHaveTextContent("3 uncommitted changes that exist nowhere else.");
    expect(wts).toHaveTextContent("An agent's: its team cleans it up");
    // Only the safe one can be removed, and only once asked.
    expect(within(wts).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    fireEvent.click(within(wts).getByRole("button", { name: "Remove clean…" }));
    expect(wts).toHaveTextContent("Remove it? Its branch stays.");
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
});
