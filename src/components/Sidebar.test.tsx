import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OPEN_AFTER_MS, Sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, sidebarMemory } from "./Sidebar";
import { PROJECT_COLORS } from "../lib/projectColors";
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
    onColors: vi.fn(),
  };
  const loadSessions = vi.fn(async (folder: string) => (folder === LANTERN ? [past("p1", "Map tab layout", 90_000_000), past("p2", "Release flow notes", 5 * 86_400_000), past("p3", "Third", 6 * 86_400_000), past("p4", "Fourth", 7 * 86_400_000), past("p5", "Fifth", 8 * 86_400_000)] : [past("q1", "Old monitor work")]));
  const props: React.ComponentProps<typeof Sidebar> = {
    ...h,
    mode: "pinned",
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
    colors: {},
    ...over,
  };
  const view = render(<Sidebar {...props} />);
  return { h, loadSessions, props, ...view };
}

const project = (name: string) => screen.getByRole("region", { name });
const regions = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const toggleOf = (name: string) => within(project(name)).getByRole("button", { name: new RegExp(`^${name}`) });

// jsdom has no PointerEvent, so pointer events would carry no coordinates: one on top of MouseEvent, for these tests.
const had = window.PointerEvent;
beforeAll(() => {
  window.PointerEvent ??= class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  } as unknown as typeof PointerEvent;
});
afterAll(() => {
  window.PointerEvent = had;
});

beforeEach(() => localStorage.clear());

describe("the open sidebar's projects", () => {
  it("shown again (as each peek is), starts from what it listed last instead of empty, and reads it all again behind it", async () => {
    const memory = sidebarMemory();
    const first = setup({ memory });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    await waitFor(() => expect(within(project("lantern")).getByText("Map tab layout")).toBeInTheDocument());
    first.unmount();
    // The reads of the second one never finish, so what it shows can only be what the first listed.
    const pending = () => new Promise<never>(() => {});
    const reread = vi.fn(pending);
    setup({ memory, loadRecent: pending, loadSessions: reread });
    expect(regions()).toEqual(["lantern", "network-monitor", "lumiform-ios"]);
    expect(within(project("lantern")).getByText("Map tab layout")).toBeInTheDocument();
    expect(reread).toHaveBeenCalledWith(LANTERN);
  });

  it("has one group per project: the one with a chat open first and expanded, the other recent folders after it and folded", async () => {
    setup();
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    expect(regions()).toEqual(["lantern", "network-monitor", "lumiform-ios"]);
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "true");
    expect(toggleOf("network-monitor")).toHaveAttribute("aria-expanded", "false");
    expect(toggleOf("lumiform-ios")).toHaveAttribute("aria-expanded", "false");
    // The project on screen shows its branch.
    expect(within(project("lantern")).getByText("main")).toBeInTheDocument();
  });

  it("heads each project with its initials, in a colour of its own", async () => {
    setup({ colors: { [LANTERN]: 2, [MONITOR]: 5 } });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    const initialsOf = (name: string) => project(name).querySelector(".sb-project-initials")?.textContent;
    expect([initialsOf("lantern"), initialsOf("network-monitor"), initialsOf("lumiform-ios")]).toEqual(["LA", "NM", "LI"]);
    expect(project("lantern").style.getPropertyValue("--pc")).toBe(PROJECT_COLORS[2]);
    expect(project("network-monitor").style.getPropertyValue("--pc")).toBe(PROJECT_COLORS[5]);
  });

  it("lists open chats as squares with their state, then pinned and the 3 latest past chats, then Show all", async () => {
    setup({ pinned: { [LANTERN]: ["p5"] } });
    const group = project("lantern");
    expect(await within(group).findByText("Map tab layout")).toBeInTheDocument();
    const rows = within(group).getAllByRole("button").map((b) => b.textContent);
    // Pinned first among the past chats, then the three newest of the rest; the 5th and 4th past chats are only in Show all.
    expect(within(group).getByText("Fifth")).toBeInTheDocument();
    expect(within(group).getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(within(group).getByText("Release flow notes")).toBeInTheDocument();
    expect(within(group).queryByText("Fourth")).toBeNull();
    expect(rows.some((r) => r?.startsWith("Show all 5"))).toBe(true);
    // The open chats keep their order (needs-you first is the data's job), and each says what it is doing.
    expect(within(group).getByRole("button", { name: "Fix restore mode, lantern, Needs you" })).toBeInTheDocument();
    expect(within(group).getAllByRole("button", { name: /, lantern, Working$/ }).length).toBeGreaterThanOrEqual(2);
    const row = within(group).getByRole("button", { name: /Network tab polish/ });
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row.querySelector(".sb-initials")).toHaveTextContent("NT");
    expect(row.querySelector(".sb-chip")).toHaveClass("current");
    expect(row.querySelector(".sb-status")).toHaveTextContent("Working");
  });

  it("says when a chat is pinned or has tasks in the background", () => {
    const open = { [LANTERN]: { ...lanternOpen, items: [{ kind: "chat" as const, ...chat("s9", "Long task", { pinned: true, background: 2 }) }] } };
    setup({ open });
    const row = screen.getByRole("button", { name: /Long task/ });
    expect(row).toHaveAccessibleName("Long task, lantern, Done, pinned, 2 running in the background");
    expect(row.querySelector(".sb-pin")).not.toBeNull();
    expect(row.querySelector(".spinner")).not.toBeNull();
  });

  it("shows a team with its agents nested under it, and marks an unread agent", async () => {
    setup();
    const agents = screen.getByRole("list", { name: "Agents in audit sweep" });
    expect(within(agents).getAllByRole("button").map((b) => b.getAttribute("title"))).toEqual(["security pass", "ui pass"]);
    expect(within(agents).getByRole("button", { name: "ui pass, lantern, Unread" })).toBeInTheDocument();
    const team = screen.getByRole("button", { name: /^Team: audit sweep/ });
    expect(team.querySelector(".sb-chip")).toHaveClass("team");
    expect(team).toHaveTextContent("Team: audit sweep");
  });

  it("marks what works, what needs you and what finished unread; a plain finished chat has no mark", () => {
    setup();
    const marks = (name: RegExp) => Array.from(screen.getByRole("button", { name }).querySelectorAll(".sb-mark")).map((m) => m.className);
    expect(marks(/Network tab polish/)).toEqual(["sb-mark running"]);
    expect(marks(/Fix restore mode/)).toEqual(["sb-mark waiting"]);
    expect(marks(/ui pass/)).toEqual(["sb-mark unread"]);
    expect(marks(/^Done chat/)).toEqual([]);
  });

  it("reads past chats only for an expanded project, and reads a folded one when it is opened", async () => {
    const { loadSessions } = setup();
    await within(project("lantern")).findByText("Map tab layout");
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledWith(LANTERN);
    fireEvent.click(toggleOf("network-monitor"));
    expect(await within(project("network-monitor")).findByText("Old monitor work")).toBeInTheDocument();
    expect(loadSessions).toHaveBeenCalledTimes(2);
    expect(loadSessions).toHaveBeenLastCalledWith(MONITOR);
    expect(loadSessions).not.toHaveBeenCalledWith(IOS);
    // Folding and opening it again doesn't read it again.
    fireEvent.click(toggleOf("network-monitor"));
    fireEvent.click(toggleOf("network-monitor"));
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
    fireEvent.click(toggleOf("lantern"));
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "false");
    first.unmount();
    setup();
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows what needs you as a badge on a folded project, and lists it again when expanded", async () => {
    setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    fireEvent.click(toggleOf("network-monitor"));
    expect(toggleOf("network-monitor")).toHaveAttribute("aria-expanded", "false");
    expect(within(project("network-monitor")).getByRole("img", { name: "2 need you" })).toHaveTextContent("2");
    fireEvent.click(toggleOf("network-monitor"));
    expect(within(project("network-monitor")).queryByRole("img", { name: "2 need you" })).toBeNull();
    expect(within(project("network-monitor")).getByText("Retry the proxy")).toBeInTheDocument();
  });

  it("says when there is nothing yet", async () => {
    setup({ open: {}, loadRecent: async () => [] });
    expect(await screen.findByText("No projects yet. Open a folder to start.")).toBeInTheDocument();
  });

  it("gives each project a colour of its own: a saved one stays, a new project gets one no other has, to save", async () => {
    const onColors = vi.fn();
    const color = (name: string) => project(name).style.getPropertyValue("--pc");
    const { rerender, props } = setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen }, colors: { [MONITOR]: 0 }, onColors });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    expect(color("network-monitor")).toBe(PROJECT_COLORS[0]);
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    // The ones with something open get theirs first, then the rest.
    await waitFor(() => expect(onColors).toHaveBeenCalledWith({ [MONITOR]: 0, [LANTERN]: 1, [IOS]: 2 }));
    // Once saved (and after a restart, read back), nothing new is saved and the colours stay.
    const saved = { [MONITOR]: 0, [LANTERN]: 1, [IOS]: 2 };
    rerender(<Sidebar {...props} colors={saved} />);
    await act(async () => {});
    onColors.mockClear();
    rerender(<Sidebar {...props} colors={saved} />);
    await act(async () => {});
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    expect(onColors).not.toHaveBeenCalled();
  });
});

describe("clicking in the open sidebar", () => {
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

  it("starts a chat in a project with its +, even one that is folded, and then shows it open", async () => {
    const { h } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "New chat in lumiform-ios" }));
    expect(h.onNewChatIn).toHaveBeenCalledWith(IOS);
    expect(toggleOf("lumiform-ios")).toHaveAttribute("aria-expanded", "true");
  });

  it("has a ⋯ menu per project: New team, Bring old chats here…, Reveal in Finder, Remove from recents", async () => {
    const { h } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "More for network-monitor" }));
    const menu = screen.getByRole("menu", { name: "network-monitor actions" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["New team", "Bring old chats here…", "Reveal in Finder", "Move up⌥⌘↑", "Move down⌥⌘↓", "Remove from recents"]);
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

describe("the pin button", () => {
  it("collapses the pinned sidebar", () => {
    const { h } = setup();
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("pinned");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers to keep it open while it only peeks in over the chat", () => {
    const { h } = setup({ mode: "peek" });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("peek");
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep sidebar open" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("is a button at the top of the collapsed bar that expands it", () => {
    const { h } = setup({ mode: "collapsed" });
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
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

  it("follows the pointer while the edge is dragged, and tells the app the width once, on release", () => {
    const { h } = setup({ width: 300 });
    const edge = screen.getByRole("separator", { name: "Resize the sidebar" });
    fireEvent.pointerDown(edge, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 340 });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "340px" });
    expect(h.onWidth).not.toHaveBeenCalled();
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 340 });
    expect(h.onWidth).toHaveBeenCalledWith(340);
  });

  it("is as wide as it was saved, and has no edge to drag when it is only collapsed or peeking", () => {
    const first = setup({ width: 311 });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "311px" });
    first.unmount();
    setup({ mode: "peek", width: 311 });
    expect(screen.getByRole("complementary", { name: "Projects" })).toHaveStyle({ width: "311px" });
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("the collapsed sidebar", () => {
  const panel = () => document.querySelector<HTMLElement>(".sb-panel")!;
  const bar = (over: Partial<React.ComponentProps<typeof Sidebar>> = {}) => setup({ mode: "collapsed", loadRecent: async () => [{ path: LANTERN, updated_ms: 3 }, { path: MONITOR, updated_ms: 2 }, { path: IOS, updated_ms: 1 }], open: { [LANTERN]: { ...lanternOpen, items: [...lanternOpen.items, { kind: "chat", ...chat("s4", "Release notes", { unread: true }) }] }, [MONITOR]: { items: [{ kind: "chat", ...chat("m1", "Retry the proxy") }], sessionIds: [], needs: 0, target: null } }, ...over });
  const square = (name: RegExp) => screen.getByRole("button", { name });

  it("has a square for each open chat and team, but none for an agent, with the chat's initials, and a label above each project", async () => {
    bar();
    await waitFor(() => expect(screen.getAllByRole("list")).toHaveLength(2));
    const lantern = screen.getByRole("list", { name: "lantern" });
    expect(within(lantern).getAllByRole("button")).toHaveLength(5);
    // The title's initials: filler words skipped, a team by its Lead's title.
    expect(within(lantern).getAllByRole("button").map((b) => b.querySelector(".sb-initials")?.textContent)).toEqual(["FR", "AS", "NT", "DC", "RN"]);
    expect(within(screen.getByRole("list", { name: "network-monitor" })).getByText("RP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /security pass/ })).toBeNull();
    // Above each project's squares, its initials, with its name as the tooltip.
    const labels = Array.from(document.querySelectorAll(".sb-project"));
    expect(labels.map((l) => [l.querySelector(".sb-project-initials")?.textContent, l.getAttribute("title")])).toEqual([
      ["LA", "lantern"],
      ["NM", "network-monitor"],
    ]);
    expect(screen.getByRole("complementary", { name: "Open chats" })).toHaveClass("collapsed");
  });

  it("tints each project's squares with its colour", async () => {
    bar({ colors: { [MONITOR]: 0 } });
    const color = (name: string) => screen.getByRole("list", { name }).style.getPropertyValue("--pc");
    await screen.findByRole("list", { name: "lantern" });
    expect(color("network-monitor")).toBe(PROJECT_COLORS[0]);
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
  });

  it("lists projects in the saved order, and saves one new to it at the top", async () => {
    const onOrder = vi.fn();
    bar({ order: [MONITOR], onOrder });
    await waitFor(() => expect(screen.getAllByRole("list")).toHaveLength(2));
    expect(screen.getAllByRole("list").map((l) => l.getAttribute("aria-label"))).toEqual(["lantern", "network-monitor"]);
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith([LANTERN, IOS, MONITOR]));
  });

  it("marks what works, what needs you and what finished unread; a plain finished chat has no mark", async () => {
    bar();
    await screen.findByRole("list", { name: "lantern" });
    const marks = (name: RegExp) => Array.from(square(name).querySelectorAll(".sb-mark")).map((m) => m.className);
    expect(marks(/Network tab polish/)).toEqual(["sb-mark running"]);
    expect(marks(/Fix restore mode/)).toEqual(["sb-mark waiting"]);
    expect(marks(/Release notes/)).toEqual(["sb-mark unread"]);
    expect(marks(/^Done chat/)).toEqual([]);
    expect(square(/^Team: audit sweep/).querySelector(".sb-chip")).toHaveClass("team");
  });

  it("lights the chat on screen", async () => {
    bar();
    await screen.findByRole("list", { name: "lantern" });
    expect(square(/Network tab polish/)).toHaveAttribute("aria-current", "true");
    expect(square(/Network tab polish/)).toHaveClass("current");
    expect(square(/Fix restore mode/)).not.toHaveAttribute("aria-current");
  });

  it("has the title, the project and the status as each row's name, and keeps the title and status beside the square", async () => {
    bar();
    await screen.findByRole("list", { name: "lantern" });
    const row = square(/Fix restore mode/);
    expect(row).toHaveAccessibleName("Fix restore mode, lantern, Needs you");
    expect(row.querySelector(".sb-title")).toHaveTextContent("Fix restore mode");
    expect(row.querySelector(".sb-status")).toHaveTextContent("Needs you");
    expect(row.querySelector(".sb-status")).toHaveClass("waiting");
    expect(document.querySelector(".sb-project-name")).toHaveTextContent("lantern");
  });

  it("switches to a chat on a click, and opens a team's canvas", async () => {
    const { h } = bar();
    await screen.findByRole("list", { name: "lantern" });
    fireEvent.click(square(/Fix restore mode/));
    expect(h.onChat).toHaveBeenCalledWith("s2");
    fireEvent.click(square(/^Team: audit sweep/));
    expect(h.onTeam).toHaveBeenCalledWith("lead");
    expect(h.onChat).toHaveBeenCalledTimes(1);
  });

  it("has a + for a new chat (off when none can start)", () => {
    const first = bar();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(first.h.onNewChat).toHaveBeenCalledTimes(1);
    first.unmount();
    bar({ canNew: false });
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("reads no past chats until it opens", async () => {
    const { loadSessions } = bar();
    await screen.findByRole("list", { name: "lantern" });
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("opens over the chat once the pointer rests on it, not as it passes, and closes when it leaves or a chat is picked", async () => {
    vi.useFakeTimers();
    try {
      const { h, loadSessions } = bar();
      await act(async () => {});
      expect(panel().style.getPropertyValue("--sb-open")).toBe(`${SIDEBAR_DEFAULT}px`);
      // Passing over it on the way to the chat.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS - 50));
      fireEvent.pointerLeave(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).not.toHaveClass("expanded");
      expect(loadSessions).not.toHaveBeenCalled();
      // Resting on it: the whole sidebar, the pin button in place of the bar's, and the past chats are read.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).toHaveClass("expanded");
      expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("collapsed");
      await act(async () => {});
      expect(regions()).toEqual(["lantern", "network-monitor", "lumiform-ios"]);
      expect(within(project("lantern")).getByText("Map tab layout")).toBeInTheDocument();
      expect(loadSessions).toHaveBeenCalledWith(LANTERN);
      expect(screen.getByRole("button", { name: "Keep sidebar open" })).toBeInTheDocument();
      fireEvent.pointerLeave(panel());
      expect(panel()).not.toHaveClass("expanded");
      // It takes a moment to shut; then the bar is back.
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole("complementary", { name: "Open chats" })).toBeInTheDocument();
      // Picking a chat closes it.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      fireEvent.click(screen.getByRole("button", { name: /Fix restore mode/ }));
      expect(h.onChat).toHaveBeenCalledWith("s2");
      expect(panel()).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the pane's own handlers too, and a past chat picked in it goes there and closes it", async () => {
    vi.useFakeTimers();
    try {
      const { h } = bar();
      await act(async () => {});
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      await act(async () => {});
      fireEvent.click(within(project("lantern")).getByRole("button", { name: /Map tab layout/ }));
      expect(h.onPast).toHaveBeenCalledWith(LANTERN, "p1");
      expect(panel()).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Escape", async () => {
    vi.useFakeTimers();
    try {
      bar();
      await act(async () => {});
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).toHaveClass("expanded");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(panel()).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't open while something is dragged across it", () => {
    vi.useFakeTimers();
    try {
      bar();
      fireEvent.pointerEnter(panel(), { buttons: 1 });
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS * 2));
      expect(panel()).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reordering projects", () => {
  const ORDER = [LANTERN, MONITOR, IOS];
  const header = (name: string) => within(project(name)).getByRole("button", { name: new RegExp(`^${name}`) }).parentElement!;

  /** Lays the projects out by hand (jsdom has none): lantern 200 tall, then the other two 30 each. */
  function layout() {
    const heights: Record<string, number> = { lantern: 200, "network-monitor": 30, "lumiform-ios": 30 };
    let top = 0;
    for (const region of screen.getAllByRole("region")) {
      const name = region.getAttribute("aria-label")!;
      const [t, h] = [top, heights[name]];
      region.getBoundingClientRect = () => ({ top: t, bottom: t + h, height: h }) as DOMRect;
      top += h;
    }
  }

  it("lists projects in the saved order, not with the open one first, and saves a new one at the top", async () => {
    const onOrder = vi.fn();
    setup({ order: [MONITOR, LANTERN], onOrder });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["lumiform-ios", "network-monitor", "lantern"]);
    expect(onOrder).toHaveBeenCalledWith([IOS, MONITOR, LANTERN]);
  });

  it("moves a project up or down from its ⋯ menu, which has no Move up at the top", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder });
    fireEvent.click(await screen.findByRole("button", { name: "More for lantern" }));
    expect(screen.getByRole("menuitem", { name: /Move up/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Move down/ }));
    expect(onOrder).toHaveBeenLastCalledWith([MONITOR, LANTERN, IOS]);
  });

  it("moves the focused project with ⌥⌘↑ and ⌥⌘↓", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder });
    const ios = await within(await screen.findByRole("region", { name: "lumiform-ios" })).findByRole("button", { name: /^lumiform-ios/ });
    fireEvent.keyDown(ios, { key: "ArrowUp", altKey: true, metaKey: true });
    expect(onOrder).toHaveBeenLastCalledWith([LANTERN, IOS, MONITOR]);
    fireEvent.keyDown(ios, { key: "ArrowUp", metaKey: true });
    expect(onOrder).toHaveBeenCalledTimes(1);
  });

  it("drags a project by its header to a new place, settling it there before saving, and the release isn't a click", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    layout();
    const row = header("network-monitor");
    fireEvent.pointerDown(row, { pointerId: 1, clientY: 210, button: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, clientY: 200, buttons: 1 });
    // It lifts, and lantern (which it is now over) makes room by moving down.
    expect(project("network-monitor")).toHaveClass("lifted");
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 60, buttons: 1 });
    expect(project("network-monitor").style.transform).toBe("translateY(-150px)");
    expect(project("lantern").style.transform).toBe("translateY(30px)");
    expect(project("lumiform-ios").style.transform).toBe("translateY(0px)");
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(within(row).getByRole("button", { name: /^network-monitor/ }));
    expect(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ })).toHaveAttribute("aria-expanded", "false");
    expect(onOrder).not.toHaveBeenCalled();
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith([MONITOR, LANTERN, IOS]));
    expect(project("network-monitor")).not.toHaveClass("lifted");
  });

  it("treats a press that barely moves as a click, and puts a dragged project back on Escape", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    layout();
    const row = header("network-monitor");
    fireEvent.pointerDown(row, { pointerId: 1, clientY: 210, button: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, clientY: 212, buttons: 1 });
    expect(project("network-monitor")).not.toHaveClass("lifted");
    fireEvent.pointerUp(row, { pointerId: 1 });
    fireEvent.pointerDown(row, { pointerId: 1, clientY: 210, button: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, clientY: 150, buttons: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(project("network-monitor")).not.toHaveClass("lifted"));
    await new Promise((r) => setTimeout(r, 200));
    expect(onOrder).not.toHaveBeenCalled();
  });
});
