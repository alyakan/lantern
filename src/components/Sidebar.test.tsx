import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX } from "./Sidebar";
import type { ProjectOpen, SidebarChat } from "../lib/sidebar";

const LANTERN = "/work/lantern";
const MONITOR = "/work/network-monitor";
const IOS = "/work/lumiform-ios";

const chat = (slot: string, title: string, over: Partial<SidebarChat> = {}): SidebarChat => ({ slot, title, state: "done", unread: false, background: 0, sessionId: null, active: false, pinned: false, closable: false, ...over });
const past = (id: string, title: string, ageMs = 3_600_000) => ({ id, title, updated_ms: Date.now() - ageMs, prompts: 1 });

const lanternOpen: ProjectOpen = {
  items: [
    { kind: "chat", ...chat("s2", "Fix restore mode", { state: "waiting" }) },
    { kind: "team", ...chat("lead", "audit sweep", { state: "running" }), agents: [chat("a1", "security pass", { state: "running" }), chat("a2", "ui pass", { unread: true })] },
    { kind: "chat", ...chat("s1", "Network tab polish", { state: "running", active: true }) },
    { kind: "chat", ...chat("s3", "Done chat", { closable: true }) },
  ],
  sessionIds: ["x"],
  needs: 1,
  target: { slot: "s2", team: null },
};
const monitorOpen: ProjectOpen = { items: [{ kind: "chat", ...chat("m1", "Retry the proxy", { state: "waiting" }) }, { kind: "chat", ...chat("m2", "Second ask", { state: "waiting" }) }], sessionIds: [], needs: 2, target: { slot: "m1", team: null } };

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const h = {
    onChat: vi.fn(),
    onTeam: vi.fn(),
    onAgent: vi.fn(),
    onPast: vi.fn(),
    onCloseChat: vi.fn(),
    onHistory: vi.fn(),
    onNewChatIn: vi.fn(),
    onNewTeamIn: vi.fn(),
    onBringOld: vi.fn(),
    onReveal: vi.fn(),
    onRemove: vi.fn(),
    onOpenFolder: vi.fn(),
    onNewChat: vi.fn(),
    onNewTeam: vi.fn(),
    onReviewPr: vi.fn(),
    onToggle: vi.fn(),
    onWidth: vi.fn(),
    onRelocate: vi.fn(),
    onDismissMoved: vi.fn(),
  };
  const loadSessions = vi.fn(async (folder: string) => (folder === LANTERN ? [past("p1", "Map tab layout", 90_000_000), past("p2", "Release flow notes", 5 * 86_400_000), past("p3", "Third", 6 * 86_400_000), past("p4", "Fourth", 7 * 86_400_000), past("p5", "Fifth", 8 * 86_400_000)] : [past("q1", "Old monitor work")]));
  const props: React.ComponentProps<typeof Sidebar> = {
    ...h,
    width: SIDEBAR_DEFAULT,
    open: { [LANTERN]: lanternOpen },
    currentFolder: LANTERN,
    branch: "main",
    canNew: true,
    loadRecent: async () => [{ path: MONITOR, updated_ms: 3 }, { path: LANTERN, updated_ms: 2 }, { path: IOS, updated_ms: 1 }],
    loadSessions,
    pinned: {},
    titles: {},
    hidden: [],
    moved: [],
    ...over,
  };
  const view = render(<Sidebar {...props} />);
  return { h, loadSessions, props, ...view };
}

const project = (name: string) => screen.getByRole("region", { name });

beforeEach(() => localStorage.clear());

describe("the sidebar's projects", () => {
  it("has one group per project: the one with a chat open first and expanded, the other recent folders after it and collapsed", async () => {
    setup();
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["lantern", "network-monitor", "lumiform-ios"]);
    expect(within(project("lantern")).getByRole("button", { name: /^lantern/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(project("lumiform-ios")).getByRole("button", { name: /^lumiform-ios/ })).toHaveAttribute("aria-expanded", "false");
    // The project on screen shows its branch.
    expect(within(project("lantern")).getByText("main")).toBeInTheDocument();
  });

  it("lists open chats with their state, then pinned and the 3 latest past chats, then Show all", async () => {
    setup({ pinned: { [LANTERN]: ["p5"] } });
    const group = project("lantern");
    expect(await within(group).findByText("Map tab layout")).toBeInTheDocument();
    const rows = within(group).getAllByRole("button").map((b) => b.textContent);
    // Pinned first among the past chats, then the three newest of the rest; the 5th and 4th past chats are only in Show all.
    expect(within(group).getByText("Fifth")).toBeInTheDocument();
    expect(within(group).getByText("Release flow notes")).toBeInTheDocument();
    expect(within(group).queryByText("Fourth")).toBeNull();
    expect(rows.some((r) => r?.startsWith("Show all 5"))).toBe(true);
    // The open chats keep their order (needs-you first is the data's job), and each says what it is doing.
    expect(within(group).getByRole("img", { name: "Needs you" })).toBeInTheDocument();
    expect(within(group).getAllByRole("img", { name: "Working" }).length).toBeGreaterThanOrEqual(2);
    expect(within(group).getByRole("button", { name: /Network tab polish/ })).toHaveAttribute("aria-current", "true");
  });

  it("shows a team with its agents nested under it, and marks an unread agent", async () => {
    setup();
    const agents = screen.getByRole("list", { name: "Agents in audit sweep" });
    expect(within(agents).getAllByRole("button").map((b) => b.getAttribute("title"))).toEqual(["security pass", "ui pass"]);
    expect(within(agents).getByRole("img", { name: "Unread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Team: audit sweep/ })).toBeInTheDocument();
  });

  it("reads past chats only for an expanded project, and reads a collapsed one when it is opened", async () => {
    const { loadSessions } = setup();
    await within(project("lantern")).findByText("Map tab layout");
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledWith(LANTERN);
    fireEvent.click(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ }));
    expect(await within(project("network-monitor")).findByText("Old monitor work")).toBeInTheDocument();
    expect(loadSessions).toHaveBeenCalledTimes(2);
    expect(loadSessions).toHaveBeenLastCalledWith(MONITOR);
    expect(loadSessions).not.toHaveBeenCalledWith(IOS);
    // Collapsing and opening it again doesn't read it again.
    fireEvent.click(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ }));
    fireEvent.click(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ }));
    expect(loadSessions).toHaveBeenCalledTimes(2);
  });

  it("reads a project's past chats again when its open chats change, so a closed one shows up", async () => {
    const { loadSessions, rerender, props } = setup();
    await within(project("lantern")).findByText("Map tab layout");
    rerender(<Sidebar {...props} open={{ [LANTERN]: { ...lanternOpen, sessionIds: [] } }} />);
    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));
  });

  it("remembers a project you opened or closed by hand", async () => {
    const first = setup();
    fireEvent.click(within(project("lantern")).getByRole("button", { name: /^lantern/ }));
    expect(within(project("lantern")).getByRole("button", { name: /^lantern/ })).toHaveAttribute("aria-expanded", "false");
    first.unmount();
    setup();
    expect(within(project("lantern")).getByRole("button", { name: /^lantern/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows what needs you as a badge on a collapsed project, and lists it again when expanded", async () => {
    setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    fireEvent.click(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ }));
    expect(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(project("network-monitor")).getByRole("img", { name: "2 need you" })).toHaveTextContent("2");
    fireEvent.click(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ }));
    expect(within(project("network-monitor")).queryByRole("img", { name: "2 need you" })).toBeNull();
    expect(within(project("network-monitor")).getByText("Retry the proxy")).toBeInTheDocument();
  });

  it("says when there is nothing yet", async () => {
    setup({ open: {}, loadRecent: async () => [] });
    expect(await screen.findByText("No projects yet. Open a folder to start.")).toBeInTheDocument();
  });
});

describe("clicking in the sidebar", () => {
  it("switches to an open chat, opens a team's canvas, focuses an agent, and resumes a past chat", async () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Fix restore mode/ }));
    expect(h.onChat).toHaveBeenCalledWith("s2");
    fireEvent.click(screen.getByRole("button", { name: /Team: audit sweep/ }));
    expect(h.onTeam).toHaveBeenCalledWith("lead");
    fireEvent.click(screen.getByRole("button", { name: /ui pass/ }));
    expect(h.onAgent).toHaveBeenCalledWith("a2", "lead");
    fireEvent.click(await screen.findByRole("button", { name: /Map tab layout/ }));
    expect(h.onPast).toHaveBeenCalledWith(LANTERN, "p1");
  });

  it("opens History for the project from Show all…", async () => {
    const { h } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Show all 5…" }));
    expect(h.onHistory).toHaveBeenCalledWith(LANTERN);
  });

  it("closes a finished chat from its ×, and offers no × on one that is working or on screen", () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close Done chat" }));
    expect(h.onCloseChat).toHaveBeenCalledWith("s3");
    expect(screen.queryByRole("button", { name: "Close Network tab polish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Fix restore mode" })).toBeNull();
  });

  it("starts a chat in a project with its +, even one that is collapsed, and then shows it open", async () => {
    const { h } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "New chat in lumiform-ios" }));
    expect(h.onNewChatIn).toHaveBeenCalledWith(IOS);
    expect(within(project("lumiform-ios")).getByRole("button", { name: /^lumiform-ios/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("has a ⋯ menu per project: New team, Bring old chats here…, Reveal in Finder, Remove from recents", async () => {
    const { h } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for network-monitor" }));
    const menu = screen.getByRole("menu", { name: "network-monitor actions" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["New team", "Bring old chats here…", "Reveal in Finder", "Remove from recents"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New team" }));
    expect(h.onNewTeamIn).toHaveBeenCalledWith(MONITOR);
    expect(screen.queryByRole("menu", { name: "network-monitor actions" })).toBeNull();
    for (const [label, handler] of [["Bring old chats here…", h.onBringOld], ["Reveal in Finder", h.onReveal], ["Remove from recents", h.onRemove]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "More for network-monitor" }));
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledWith(MONITOR);
    }
  });

  it("closes the ⋯ menu on Escape", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "More for lantern" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens a folder from the foot of the list", () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(h.onOpenFolder).toHaveBeenCalled();
  });
});

describe("the Moved? notice", () => {
  it("sits on the project row of the folder that moved, and brings its chats or is dismissed", async () => {
    const moved = [{ old: MONITOR, suggested: "/projects/network-monitor" }];
    const { h } = setup({ moved });
    await screen.findByRole("region", { name: "network-monitor" });
    const group = project("network-monitor");
    fireEvent.click(within(group).getByRole("button", { name: "Move chats from " + MONITOR + " to /projects/network-monitor" }));
    expect(h.onRelocate).toHaveBeenCalledWith(moved[0]);
    fireEvent.click(within(group).getByRole("button", { name: "Not moved: hide the notice for network-monitor" }));
    expect(h.onDismissMoved).toHaveBeenCalledWith(MONITOR);
    expect(within(project("lantern")).queryByText(/Moved\?/)).toBeNull();
  });
});

describe("New ▾", () => {
  it("offers Chat, Team and Review a PR…, with their shortcuts", () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Chat⌘N", "Team⇧⌘N", "Review a PR…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Team/ }));
    expect(h.onNewTeam).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "New" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Chat/ }));
    expect(h.onNewChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review a PR…" }));
    expect(h.onReviewPr).toHaveBeenCalledTimes(1);
  });

  it("is off when nothing can be started (no project open, or its chat is starting)", () => {
    setup({ canNew: false });
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
  });
});

describe("hiding", () => {
  it("hides from the button in the sidebar", () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers to keep it open while it only peeks in over the chat", () => {
    const { h } = setup({ peek: true });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("peek");
    expect(screen.queryByRole("button", { name: "Hide sidebar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep sidebar open" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("is a plain sidebar otherwise, with no rail of initials", () => {
    setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    expect(screen.getByRole("complementary", { name: "Projects" })).not.toHaveClass("peek");
    expect(screen.queryByRole("button", { name: "network-monitor, 2 need you" })).toBeNull();
  });
});

describe("resizing", () => {
  it("moves the edge with the arrow keys, within limits, and tells the app the width", () => {
    const { h, rerender, props } = setup({ width: 300 });
    const edge = screen.getByRole("separator", { name: "Resize the sidebar" });
    expect(edge).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(h.onWidth).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(edge, { key: "ArrowLeft", shiftKey: true });
    expect(h.onWidth).toHaveBeenLastCalledWith(252);
    rerender(<Sidebar {...props} width={SIDEBAR_MAX} />);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the sidebar" }), { key: "ArrowRight" });
    expect(h.onWidth).toHaveBeenLastCalledWith(SIDEBAR_MAX);
  });

  it("is as wide as it was saved", () => {
    setup({ width: 311 });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "311px" });
  });
});
