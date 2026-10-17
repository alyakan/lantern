import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OPEN_AFTER_MS, Sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, sidebarMemory } from "./Sidebar";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { CloseCheck } from "../types";
import type { ProjectOpen, SidebarChat } from "../lib/sidebar";

const LANTERN = "/work/lantern";
const MONITOR = "/work/network-monitor";
const IOS = "/work/lumiform-ios";

const chat = (slot: string, title: string, over: Partial<SidebarChat> = {}): SidebarChat => ({ slot, title, state: "done", unread: false, background: 0, sessionId: null, active: false, pinned: false, ...over });

const lanternOpen: ProjectOpen = {
  items: [
    { kind: "chat", ...chat("s2", "Fix restore mode", { state: "waiting" }) },
    { kind: "team", ...chat("lead", "audit sweep", { state: "running" }), agents: [chat("a1", "security pass", { state: "running" }), chat("a2", "ui pass", { unread: true })] },
    { kind: "chat", ...chat("s1", "Network tab polish", { state: "running", active: true }) },
    { kind: "chat", ...chat("s3", "Done chat") },
    { kind: "chat", ...chat("s5", "Typing a draft", { state: "draft" }) },
  ],
  sessionIds: ["x"],
  needs: 1,
  target: { slot: "s2", team: null },
};
const monitorOpen: ProjectOpen = { items: [{ kind: "chat", ...chat("m1", "Retry the proxy", { state: "waiting" }) }, { kind: "chat", ...chat("m2", "Second ask", { state: "waiting" }) }], sessionIds: [], needs: 2, target: { slot: "m1", team: null } };
const iosOpen: ProjectOpen = { items: [{ kind: "chat", ...chat("i1", "Build the app") }], sessionIds: [], needs: 0, target: null };
const ALL_OPEN = { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen, [IOS]: iosOpen };

const noLoss: CloseCheck = { worktree: true, branch: "lantern/x", uncommitted: 0, unmerged_commits: 0 };

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const h = {
    onChat: vi.fn(),
    onTeam: vi.fn(),
    onAgent: vi.fn(),
    onCloseChats: vi.fn(),
    closeCheck: vi.fn(async () => noLoss),
    closeWorker: vi.fn(async () => {}),
    onHistory: vi.fn(),
    onNewChatIn: vi.fn(),
    onNewTeamIn: vi.fn(),
    onBringOld: vi.fn(),
    onProjectNotes: vi.fn(),
    onSetup: vi.fn(),
    onReveal: vi.fn(),
    onPrChecks: vi.fn(),
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
  const props: React.ComponentProps<typeof Sidebar> = {
    ...h,
    mode: "pinned",
    width: SIDEBAR_DEFAULT,
    open: { [LANTERN]: lanternOpen },
    currentFolder: LANTERN,
    branch: "main",
    canNew: true,
    loadRecent: async () => [{ path: MONITOR, updated_ms: 3 }, { path: LANTERN, updated_ms: 2 }, { path: IOS, updated_ms: 1 }],
    hidden: [],
    moved: [],
    colors: {},
    ...over,
  };
  const view = render(<Sidebar {...props} />);
  return { h, props, ...view };
}

const project = (name: string) => screen.getByRole("region", { name });
const regions = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const toggleOf = (name: string) => within(project(name)).getByRole("button", { name: new RegExp(`^${name}`) });
const rowOf = (name: RegExp | string) => {
  // Not the × at the row's end, whose name has the title in it too.
  const rows = screen.getAllByRole("button", { name }).filter((b) => !b.classList.contains("sb-close"));
  expect(rows).toHaveLength(1);
  return rows[0];
};
/** The line under a team that opens the list of its agents (they are folded until it is pressed). */
const showAgents = (team = "audit sweep") => fireEvent.click(screen.getByRole("button", { name: new RegExp(`agents? in ${team}`) }));
/** The × at the end of an open chat's row. */
const closeOf = (title: string) => screen.getByRole("button", { name: `Close ${title}` });

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
  it("shown again (as each peek is), starts from the recents it read last, so the projects keep their order", async () => {
    const memory = sidebarMemory();
    const first = setup({ memory, open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    await waitFor(() => expect(regions()).toEqual(["network-monitor", "lantern"]));
    first.unmount();
    // The read of the second one never finishes, so what it shows can only be what the first listed.
    setup({ memory, loadRecent: () => new Promise<never>(() => {}), open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    expect(regions()).toEqual(["network-monitor", "lantern"]);
  });

  it("has one group for each project with something open, and none for the other recent folders", async () => {
    setup({ open: { [LANTERN]: lanternOpen, [IOS]: iosOpen } });
    await waitFor(() => expect(regions()).toEqual(["lantern", "lumiform-ios"]));
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "true");
    // The project on screen shows its branch.
    expect(within(project("lantern")).getByText("main")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "network-monitor" })).toBeNull();
  });

  it("has no past chats and no Show all: History has them", async () => {
    setup();
    await act(async () => {});
    expect(screen.queryByText(/Show all/)).toBeNull();
    expect(project("lantern").querySelector(".sb-past-list")).toBeNull();
  });

  it("heads each project with its initials, in a colour of its own", async () => {
    setup({ open: ALL_OPEN, colors: { [LANTERN]: 2, [MONITOR]: 5 } });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    const initialsOf = (name: string) => project(name).querySelector(".sb-project-initials")?.textContent;
    expect([initialsOf("lantern"), initialsOf("network-monitor"), initialsOf("lumiform-ios")]).toEqual(["LA", "NM", "LI"]);
    expect(project("lantern").style.getPropertyValue("--pc")).toBe(PROJECT_COLORS[2]);
    expect(project("network-monitor").style.getPropertyValue("--pc")).toBe(PROJECT_COLORS[5]);
  });

  it("lists open chats as squares with their state", () => {
    setup();
    expect(rowOf("Fix restore mode, lantern, Needs you")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /, lantern, Working$/ }).length).toBeGreaterThanOrEqual(2);
    const row = rowOf(/Network tab polish/);
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row.querySelector(".sb-initials")).toHaveTextContent("NT");
    expect(row.querySelector(".sb-chip")).toHaveClass("current");
    expect(row.querySelector(".sb-status")).toHaveTextContent("Working");
  });

  it("says when a chat is pinned or has tasks in the background", () => {
    const open = { [LANTERN]: { ...lanternOpen, items: [{ kind: "chat" as const, ...chat("s9", "Long task", { pinned: true, background: 2 }) }] } };
    setup({ open });
    const row = rowOf(/Long task/);
    expect(row).toHaveAccessibleName("Long task, lantern, Done, pinned, 2 running in the background");
    expect(row.querySelector(".sb-pin")).not.toBeNull();
    expect(row.querySelector(".spinner")).not.toBeNull();
  });

  it("folds a team's agents under a line that says how many and what they do, and opens them on a press", () => {
    setup();
    expect(screen.queryByRole("list", { name: "Agents in audit sweep" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^ui pass/ })).toBeNull();
    const line = screen.getByRole("button", { name: "2 agents in audit sweep, 1 working" });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line).toHaveTextContent("2 agents");
    expect(line).toHaveTextContent("1 working");
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Agents in audit sweep" })).toBeInTheDocument();
    fireEvent.click(line);
    expect(screen.queryByRole("list", { name: "Agents in audit sweep" })).toBeNull();
  });

  it("names an agent's role in its row, and to VoiceOver", () => {
    const team = { kind: "team" as const, ...chat("lead", "audit sweep", { state: "running" }), agents: [chat("a1", "Reviewer: login form", { state: "running", role: "Reviewer" }), chat("a2", "ui pass")] };
    setup({ open: { [LANTERN]: { ...lanternOpen, items: [team] } } });
    showAgents();
    const row = screen.getByRole("button", { name: "Reviewer: login form, Reviewer, lantern, Working" });
    expect(row).toHaveTextContent("Reviewer · Working");
    // An agent with no role reads as before.
    expect(screen.getByRole("button", { name: "ui pass, lantern, Done" }).querySelector(".sb-status")?.textContent).toBe("Done");
  });

  it("says who needs you on the line that folds a team's agents", () => {
    const team = { kind: "team" as const, ...chat("lead", "audit sweep", { state: "waiting" }), agents: [chat("a1", "security pass", { state: "waiting" }), chat("a2", "ui pass", { state: "waiting" })] };
    setup({ open: { [LANTERN]: { ...lanternOpen, items: [team] } } });
    const line = screen.getByRole("button", { name: "2 agents in audit sweep, 2 need you" });
    expect(line.querySelector(".sb-agents-sum")).toHaveClass("waiting");
  });

  it("keeps a team's agents open while one of them is the chat on screen", () => {
    const team = { kind: "team" as const, ...chat("lead", "audit sweep", { state: "running" }), agents: [chat("a1", "security pass", { state: "running", active: true }), chat("a2", "ui pass")] };
    setup({ open: { [LANTERN]: { ...lanternOpen, items: [team] } } });
    expect(screen.getByRole("list", { name: "Agents in audit sweep" })).toBeInTheDocument();
  });

  it("shows a team with its agents nested under it, and marks an unread agent", () => {
    setup();
    showAgents();
    const agents = screen.getByRole("list", { name: "Agents in audit sweep" });
    expect(within(agents).getAllByRole("button", { name: /, lantern,/ }).map((b) => b.getAttribute("title"))).toEqual(["security pass", "ui pass"]);
    expect(within(agents).getByRole("button", { name: "ui pass, lantern, Unread" })).toBeInTheDocument();
    const team = rowOf(/^Team: audit sweep/);
    expect(team.querySelector(".sb-chip")).toHaveClass("team");
    expect(team).toHaveTextContent("Team: audit sweep");
  });

  it("marks what works, what needs you and what finished unread; a plain finished chat has no mark", () => {
    setup();
    showAgents();
    const marks = (name: RegExp) => Array.from(rowOf(name).querySelectorAll(".sb-mark")).map((m) => m.className);
    expect(marks(/Network tab polish/)).toEqual(["sb-mark running"]);
    expect(marks(/Fix restore mode/)).toEqual(["sb-mark waiting"]);
    expect(marks(/ui pass/)).toEqual(["sb-mark unread"]);
    expect(marks(/^Done chat/)).toEqual([]);
  });

  it("remembers a project you folded by hand", () => {
    const first = setup();
    fireEvent.click(toggleOf("lantern"));
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Fix restore mode/ })).toBeNull();
    first.unmount();
    setup();
    expect(toggleOf("lantern")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows what needs you as a badge on a folded project, and lists it again when expanded", () => {
    setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    fireEvent.click(toggleOf("network-monitor"));
    expect(toggleOf("network-monitor")).toHaveAttribute("aria-expanded", "false");
    expect(within(project("network-monitor")).getByRole("img", { name: "2 need you" })).toHaveTextContent("2");
    fireEvent.click(toggleOf("network-monitor"));
    expect(within(project("network-monitor")).queryByRole("img", { name: "2 need you" })).toBeNull();
    expect(within(project("network-monitor")).getByText("Retry the proxy")).toBeInTheDocument();
  });

  it("says where to go when nothing is open", async () => {
    setup({ open: {}, loadRecent: async () => [] });
    expect(await screen.findByText("Nothing open. Start a chat with New, or find an old one in History.")).toBeInTheDocument();
  });

  it("gives each project a colour of its own: a saved one stays, a new project gets one no other has, to save", async () => {
    const onColors = vi.fn();
    const color = (name: string) => project(name).style.getPropertyValue("--pc");
    const { rerender, props } = setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen }, colors: { [MONITOR]: 0 }, onColors });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(2));
    expect(color("network-monitor")).toBe(PROJECT_COLORS[0]);
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    // The ones with something open get theirs first, then the other recent projects.
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
  it("switches to an open chat, opens a team's canvas, and focuses an agent", () => {
    const { h } = setup();
    fireEvent.click(rowOf(/Fix restore mode/));
    expect(h.onChat).toHaveBeenCalledWith("s2");
    fireEvent.click(rowOf(/Team: audit sweep/));
    expect(h.onTeam).toHaveBeenCalledWith("lead");
    showAgents();
    fireEvent.click(rowOf(/ui pass/));
    expect(h.onAgent).toHaveBeenCalledWith("a2", "lead");
  });

  it("starts a chat in a project with its +", () => {
    const { h } = setup({ open: ALL_OPEN });
    fireEvent.click(screen.getByRole("button", { name: "New chat in lumiform-ios" }));
    expect(h.onNewChatIn).toHaveBeenCalledWith(IOS);
  });

  it("closes a project's ⋯ menu on Escape, with focus back on the ⋯ button", () => {
    setup();
    const more = screen.getByRole("button", { name: "More for lantern" });
    fireEvent.click(more);
    expect(within(screen.getByRole("menu", { name: "lantern actions" })).getAllByRole("menuitem")[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "lantern actions" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("has a ⋯ menu per project: New team, Close finished chats, Project notes…, Project setup…, Bring old chats here…, Reveal in Finder, Remove from recents", () => {
    const { h } = setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    fireEvent.click(screen.getByRole("button", { name: "More for network-monitor" }));
    const menu = screen.getByRole("menu", { name: "network-monitor actions" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["New team", "Close finished chats", "Project notes…", "Project setup…", "Bring old chats here…", "Pull request checks…", "Reveal in Finder", "Move up⌥⌘↑", "Move down⌥⌘↓", "Remove from recents"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New team" }));
    expect(h.onNewTeamIn).toHaveBeenCalledWith(MONITOR);
    expect(screen.queryByRole("menu", { name: "network-monitor actions" })).toBeNull();
    for (const [label, handler] of [["Project notes…", h.onProjectNotes], ["Project setup…", h.onSetup], ["Bring old chats here…", h.onBringOld], ["Pull request checks…", h.onPrChecks], ["Reveal in Finder", h.onReveal], ["Remove from recents", h.onRemove]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "More for network-monitor" }));
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledWith(MONITOR);
    }
  });

  it("marks a project that has notes on its header, and only that one", () => {
    setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen }, noted: [MONITOR] });
    expect(within(project("network-monitor")).getByRole("img", { name: "Has project notes" })).toBeInTheDocument();
    expect(within(project("lantern")).queryByRole("img", { name: "Has project notes" })).toBeNull();
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

describe("the History button", () => {
  it("sits under New, says History, and opens History, open or collapsed", () => {
    const first = setup();
    const button = screen.getByRole("button", { name: "History" });
    expect(button).toHaveAttribute("title", "History");
    expect(button).toHaveAttribute("data-history-toggle");
    fireEvent.click(button);
    expect(first.h.onHistory).toHaveBeenCalledTimes(1);
    first.unmount();
    const bar = setup({ mode: "collapsed" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(bar.h.onHistory).toHaveBeenCalledTimes(1);
  });
});

describe("closing from the sidebar", () => {
  it("closes a finished chat at once from its ×, with no question", () => {
    const { h } = setup();
    fireEvent.click(closeOf("Done chat"));
    expect(h.onCloseChats).toHaveBeenCalledWith(["s3"]);
    expect(screen.queryByRole("group", { name: /^Close / })).toBeNull();
  });

  it("closes a chat with only a draft at once too (the × says it discards the text)", () => {
    const { h } = setup();
    expect(closeOf("Typing a draft")).toHaveAttribute("title", "Close (discards the unsent text)");
    fireEvent.click(closeOf("Typing a draft"));
    expect(h.onCloseChats).toHaveBeenCalledWith(["s5"]);
  });

  it("closes the chat on screen too, when it is done", () => {
    const active = { [LANTERN]: { ...lanternOpen, items: [{ kind: "chat" as const, ...chat("s1", "On screen", { active: true }) }] } };
    const { h } = setup({ open: active });
    fireEvent.click(closeOf("On screen"));
    expect(h.onCloseChats).toHaveBeenCalledWith(["s1"]);
  });

  it("asks \"Stop and close?\" for a chat that is working, inline under it, and closes nothing until yes", () => {
    const { h } = setup();
    fireEvent.click(closeOf("Network tab polish"));
    const ask = screen.getByRole("group", { name: "Close Network tab polish" });
    expect(ask).toHaveTextContent("Stop and close?");
    expect(h.onCloseChats).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Close Network tab polish" })).toBeNull();
    expect(h.onCloseChats).not.toHaveBeenCalled();
    fireEvent.click(closeOf("Network tab polish"));
    fireEvent.click(within(screen.getByRole("group", { name: "Close Network tab polish" })).getByRole("button", { name: "Stop and close" }));
    expect(h.onCloseChats).toHaveBeenCalledWith(["s1"]);
    expect(screen.queryByRole("group", { name: "Close Network tab polish" })).toBeNull();
  });

  it("asks for a chat that is waiting on you too, and Escape cancels the question", () => {
    const { h } = setup();
    fireEvent.click(closeOf("Fix restore mode"));
    expect(screen.getByRole("group", { name: "Close Fix restore mode" })).toHaveTextContent("Stop and close?");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Close Fix restore mode" })).toBeNull();
    expect(h.onCloseChats).not.toHaveBeenCalled();
  });

  it("closes an agent with nothing to lose at once, through the canvas's own check", async () => {
    const { h } = setup();
    showAgents();
    fireEvent.click(closeOf("ui pass"));
    await waitFor(() => expect(h.closeWorker).toHaveBeenCalledWith("a2"));
    expect(h.closeCheck).toHaveBeenCalledWith("a2");
    expect(screen.queryByRole("group", { name: "Close ui pass" })).toBeNull();
    expect(h.onCloseChats).not.toHaveBeenCalled();
  });

  it("asks before closing an agent that has uncommitted or unmerged work, and agrees to exactly what it was told", async () => {
    const closeCheck = vi.fn(async () => ({ ...noLoss, uncommitted: 3, unmerged_commits: 2 }));
    const { h } = setup({ closeCheck });
    showAgents();
    fireEvent.click(closeOf("security pass"));
    const ask = await screen.findByRole("group", { name: "Close security pass" });
    expect(ask).toHaveTextContent("3 uncommitted files and 2 commits that aren't merged");
    expect(h.closeWorker).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Discard work and close" }));
    await waitFor(() => expect(h.closeWorker).toHaveBeenCalledWith("a1", { uncommitted: 3, unmerged_commits: 2 }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Close security pass" })).toBeNull());
  });

  it("says so when an agent can't be checked or closed, and offers another try", async () => {
    const closeCheck = vi.fn().mockRejectedValue("The worker is gone");
    setup({ closeCheck });
    showAgents();
    fireEvent.click(closeOf("ui pass"));
    expect(await screen.findByRole("group", { name: "Close ui pass" })).toHaveTextContent("Couldn't close it: The worker is gone");
  });

  it("asks \"Close the team and its 2 agents?\" before closing a team, then closes the agents and the Lead", async () => {
    const { h } = setup();
    fireEvent.click(closeOf("audit sweep"));
    const ask = await screen.findByRole("group", { name: "Close audit sweep" });
    expect(ask).toHaveTextContent("Close the team and its 2 agents?");
    expect(h.closeWorker).not.toHaveBeenCalled();
    expect(h.onCloseChats).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Close team and agents" }));
    await waitFor(() => expect(h.onCloseChats).toHaveBeenCalledWith(["lead"]));
    expect((h.closeWorker.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual(["a1", "a2"]);
  });

  it("says what the team's agents would lose, and a no leaves the team alone", async () => {
    const closeCheck = vi.fn(async (worker: string) => ({ ...noLoss, uncommitted: worker === "a1" ? 2 : 1 }));
    const { h } = setup({ closeCheck });
    fireEvent.click(closeOf("audit sweep"));
    const ask = await screen.findByRole("group", { name: "Close audit sweep" });
    expect(ask).toHaveTextContent("3 uncommitted files would be lost.");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(h.closeWorker).not.toHaveBeenCalled();
    expect(h.onCloseChats).not.toHaveBeenCalled();
  });

  it("closes every finished chat of a project from its ⋯ menu, not the ones working, drafts or teams, and says how many", () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "More for lantern" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close finished chats" }));
    expect(h.onCloseChats).toHaveBeenCalledWith(["s3"]);
    expect(within(project("lantern")).getByRole("status")).toHaveTextContent("Closed 1 finished chat");
  });

  it("says when a project has no finished chat to close", () => {
    const { h } = setup({ open: { [LANTERN]: lanternOpen, [MONITOR]: monitorOpen } });
    fireEvent.click(screen.getByRole("button", { name: "More for network-monitor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close finished chats" }));
    expect(h.onCloseChats).not.toHaveBeenCalled();
    expect(within(project("network-monitor")).getByRole("status")).toHaveTextContent("No finished chats to close");
  });

  it("counts several finished chats", () => {
    const open = { [LANTERN]: { ...lanternOpen, items: [{ kind: "chat" as const, ...chat("a", "One") }, { kind: "chat" as const, ...chat("b", "Two", { active: true }) }, { kind: "chat" as const, ...chat("c", "Busy", { state: "running" }) }] } };
    const { h } = setup({ open });
    fireEvent.click(screen.getByRole("button", { name: "More for lantern" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close finished chats" }));
    expect(h.onCloseChats).toHaveBeenCalledWith(["a", "b"]);
    expect(within(project("lantern")).getByRole("status")).toHaveTextContent("Closed 2 finished chats");
  });

  describe("in the collapsed bar", () => {
    const bar = (over: Partial<React.ComponentProps<typeof Sidebar>> = {}) => setup({ mode: "collapsed", ...over });

    it("has \"Close chat\" in the menu of a right click, which closes a finished chat at once", () => {
      const { h } = bar();
      fireEvent.contextMenu(rowOf(/^Done chat/), { clientX: 30, clientY: 200 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Close chat" }));
      expect(h.onCloseChats).toHaveBeenCalledWith(["s3"]);
      expect(screen.queryByRole("menu", { name: "Chat" })).toBeNull();
    });

    it("asks where the user pressed before stopping a working chat", () => {
      const { h } = bar();
      fireEvent.contextMenu(rowOf(/Network tab polish/), { clientX: 30, clientY: 200 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Close chat" }));
      const ask = screen.getByRole("group", { name: "Close Network tab polish" });
      expect(ask).toHaveClass("floating");
      expect(ask).toHaveStyle({ left: "30px", top: "200px" });
      expect(h.onCloseChats).not.toHaveBeenCalled();
      fireEvent.click(within(ask).getByRole("button", { name: "Stop and close" }));
      expect(h.onCloseChats).toHaveBeenCalledWith(["s1"]);
    });

    it("names what it closes in the menu: a team, an agent", () => {
      bar();
      fireEvent.contextMenu(rowOf(/^Team: audit sweep/), { clientX: 30, clientY: 200 });
      expect(screen.getByRole("menuitem", { name: "Close team" })).toBeInTheDocument();
    });

    it("has a small × on a square's corner, for the pointer, which closes the same way", () => {
      const { h } = bar();
      const corner = rowOf(/^Done chat/).parentElement!.querySelector<HTMLElement>(".sb-corner-close")!;
      // Only the pointer uses it: it is out of the way of the keyboard and of screen readers.
      expect(corner).toHaveAttribute("aria-hidden", "true");
      expect(corner).toHaveAttribute("tabindex", "-1");
      fireEvent.click(corner);
      expect(h.onCloseChats).toHaveBeenCalledWith(["s3"]);
    });
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

  it("closes on Escape, with focus back on the New button", () => {
    setup();
    const button = screen.getByRole("button", { name: "New" });
    fireEvent.click(button);
    expect(within(screen.getByRole("menu", { name: "New" })).getAllByRole("menuitem")[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "New" })).toBeNull();
    expect(button).toHaveFocus();
  });

  it("is off when nothing can be started (no project open, or its chat is starting)", () => {
    setup({ canNew: false });
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
  });
});

describe("the Moved? notice", () => {
  it("sits on the header of an open project whose folder moved, and brings its chats or is dismissed", () => {
    const moved = [{ old: LANTERN, suggested: "/projects/lantern" }];
    const { h } = setup({ moved });
    const group = project("lantern");
    fireEvent.click(within(group).getByRole("button", { name: "Move chats from " + LANTERN + " to /projects/lantern" }));
    expect(h.onRelocate).toHaveBeenCalledWith(moved[0]);
    fireEvent.click(within(group).getByRole("button", { name: "Not moved: hide the notice for lantern" }));
    expect(h.onDismissMoved).toHaveBeenCalledWith(LANTERN);
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
    expect(within(lantern).getAllByRole("button")).toHaveLength(6);
    // The title's initials: filler words skipped, a team by its Lead's title.
    expect(within(lantern).getAllByRole("button").map((b) => b.querySelector(".sb-initials")?.textContent)).toEqual(["FR", "AS", "NT", "DC", "TD", "RN"]);
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

  it("opens over the chat once the pointer rests on it, not as it passes, and closes when it leaves or a chat is picked", async () => {
    vi.useFakeTimers();
    try {
      const { h } = bar();
      await act(async () => {});
      expect(panel().style.getPropertyValue("--sb-open")).toBe(`${SIDEBAR_DEFAULT}px`);
      // Passing over it on the way to the chat.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS - 50));
      fireEvent.pointerLeave(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).not.toHaveClass("expanded");
      // Resting on it: the same projects and chats, with the pin button in place of the bar's.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).toHaveClass("expanded");
      expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("collapsed");
      expect(regions()).toEqual(["lantern", "network-monitor"]);
      expect(screen.getByRole("button", { name: "Keep sidebar open" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
      fireEvent.pointerLeave(panel());
      expect(panel()).not.toHaveClass("expanded");
      // It takes a moment to shut; then the bar is back.
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole("complementary", { name: "Open chats" })).toBeInTheDocument();
      // Picking a chat closes it.
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      fireEvent.click(rowOf(/Fix restore mode/));
      expect(h.onChat).toHaveBeenCalledWith("s2");
      expect(panel()).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });

  /** The width transition ending on the panel (jsdom has no TransitionEvent, so the one property React reads is put on a plain event). */
  const widthEnded = () => {
    const ev = new Event("transitionend", { bubbles: true });
    Object.defineProperty(ev, "propertyName", { value: "width" });
    fireEvent(panel(), ev);
  };
  const hover = async () => {
    await act(async () => {});
    fireEvent.pointerEnter(panel());
    act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
    expect(panel()).toHaveClass("expanded");
  };

  it("keeps drawing the open pane while it narrows, and swaps in the bar when the width transition ends", async () => {
    vi.useFakeTimers();
    try {
      bar();
      await hover();
      fireEvent.pointerLeave(panel());
      // Closing: not "expanded" any more, but still the pane (projects, labels, the foot), folding away as the width goes.
      expect(panel()).not.toHaveClass("expanded");
      expect(panel()).toHaveClass("closing");
      expect(screen.getByRole("complementary", { name: "Projects" })).toBeInTheDocument();
      expect(regions()).toEqual(["lantern", "network-monitor"]);
      expect(screen.getByRole("button", { name: "Open folder…" })).toBeInTheDocument();
      expect(document.querySelectorAll(".sb-project")).toHaveLength(0);
      // Some other property ending (or a part of the pane) isn't the bar's width.
      const other = new Event("transitionend", { bubbles: true });
      Object.defineProperty(other, "propertyName", { value: "opacity" });
      fireEvent(panel(), other);
      expect(panel()).toHaveClass("closing");
      act(() => vi.advanceTimersByTime(100));
      expect(panel()).toHaveClass("closing");
      widthEnded();
      expect(panel()).not.toHaveClass("closing");
      expect(screen.getByRole("complementary", { name: "Open chats" })).toBeInTheDocument();
      expect(document.querySelectorAll(".sb-project")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Open folder…" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swaps in the bar after a moment even when no transition ends", async () => {
    vi.useFakeTimers();
    try {
      bar();
      await hover();
      fireEvent.pointerLeave(panel());
      act(() => vi.advanceTimersByTime(200));
      expect(panel()).toHaveClass("closing");
      act(() => vi.advanceTimersByTime(150));
      expect(panel()).not.toHaveClass("closing");
      expect(screen.getByRole("complementary", { name: "Open chats" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens again from a half-closed pane without swapping in the bar in between", async () => {
    vi.useFakeTimers();
    try {
      bar();
      await hover();
      fireEvent.pointerLeave(panel());
      act(() => vi.advanceTimersByTime(80));
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel()).toHaveClass("expanded");
      expect(panel()).not.toHaveClass("closing");
      widthEnded();
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByRole("complementary", { name: "Projects" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("while it closes, what the bar doesn't have is folded away and the pin gives way to the bar's own icon; a folded project's squares unfold", async () => {
    vi.useFakeTimers();
    localStorage.setItem("sidebar.expanded", JSON.stringify({ [MONITOR]: false }));
    try {
      bar();
      await hover();
      // Opening is the same move the other way: the bar's squares of a folded project fold away and the bar's icon fades, and
      // the pane has let go of the bar's look (no "opening" class) by the time it is drawn.
      expect(panel()).not.toHaveClass("opening");
      expect(document.querySelector(".sb-unfold.folding")).not.toBeNull();
      expect(document.querySelector(".sb-head .sb-side-glyph.leaving")).not.toBeNull();
      act(() => vi.advanceTimersByTime(300));
      expect(document.querySelector(".sb-unfold")).toBeNull();
      expect(document.querySelector(".sb-side-glyph")).toBeNull();
      // Open: the monitor's squares are not listed, and the team's agents have a line of their own.
      expect(within(project("network-monitor")).queryByRole("button", { name: /Retry the proxy/ })).toBeNull();
      expect(document.querySelector(".sb-unfold")).toBeNull();
      expect(document.querySelector(".sb-side-glyph")).toBeNull();
      fireEvent.pointerLeave(panel());
      expect(document.querySelector(".sb-agents-wrap")).toHaveClass("sb-away-y");
      expect(within(project("network-monitor")).getByRole("list", { hidden: true, name: "network-monitor" })).toBeInTheDocument();
      expect(document.querySelector(".sb-unfold")).not.toBeNull();
      expect(document.querySelector(".sb-head .sb-side-glyph")).not.toBeNull();
      expect(document.querySelector(".sb-head .sb-pin-glyph")).not.toBeNull();
      widthEnded();
      expect(document.querySelector(".sb-unfold")).toBeNull();
      expect(document.querySelector(".sb-side-glyph")).toBeNull();
      expect(screen.getByRole("list", { name: "network-monitor" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes an open menu away at once when the pane closes, instead of shrinking it with the pane", async () => {
    vi.useFakeTimers();
    try {
      bar();
      await hover();
      act(() => vi.advanceTimersByTime(300));
      // A project's ⋯ menu.
      fireEvent.click(screen.getByRole("button", { name: /^More for network-monitor/ }));
      expect(screen.getByRole("menu", { name: "network-monitor actions" })).toBeInTheDocument();
      fireEvent.pointerLeave(panel());
      expect(panel()).toHaveClass("closing");
      expect(screen.queryByRole("menu", { name: "network-monitor actions" })).toBeNull();
      widthEnded();
      // It doesn't come back when the pane is the bar, nor when the pane opens again.
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS + 300));
      expect(screen.queryByRole("menu")).toBeNull();
      // New ▾, the same way.
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      expect(screen.getByRole("menu", { name: "New" })).toBeInTheDocument();
      fireEvent.pointerLeave(panel());
      expect(screen.queryByRole("menu", { name: "New" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swaps at once when motion is reduced: no closing pane is kept", async () => {
    vi.useFakeTimers();
    const was = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    try {
      bar();
      await hover();
      fireEvent.pointerLeave(panel());
      expect(panel()).not.toHaveClass("expanded");
      expect(panel()).not.toHaveClass("closing");
      expect(screen.getByRole("complementary", { name: "Open chats" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open folder…" })).toBeNull();
    } finally {
      window.matchMedia = was;
      vi.useRealTimers();
    }
  });

  it("stays open while a question about closing is asked, and shuts once it is answered and the pointer is elsewhere", async () => {
    vi.useFakeTimers();
    try {
      const { h } = bar();
      await act(async () => {});
      fireEvent.pointerEnter(panel());
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      fireEvent.click(screen.getByRole("button", { name: "Close Network tab polish" }));
      fireEvent.pointerLeave(panel());
      expect(panel()).toHaveClass("expanded");
      fireEvent.click(within(screen.getByRole("group", { name: "Close Network tab polish" })).getByRole("button", { name: "Stop and close" }));
      expect(h.onCloseChats).toHaveBeenCalledWith(["s1"]);
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
    setup({ order: [MONITOR, LANTERN], onOrder, open: ALL_OPEN });
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(3));
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["lumiform-ios", "network-monitor", "lantern"]);
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith([IOS, MONITOR, LANTERN]));
  });

  it("moves a project up or down from its ⋯ menu, which has no Move up at the top", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder, open: ALL_OPEN });
    fireEvent.click(await screen.findByRole("button", { name: "More for lantern" }));
    expect(screen.getByRole("menuitem", { name: /Move up/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Move down/ }));
    expect(onOrder).toHaveBeenLastCalledWith([MONITOR, LANTERN, IOS]);
  });

  it("moves the focused project with ⌥⌘↑ and ⌥⌘↓", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder, open: ALL_OPEN });
    const ios = await within(await screen.findByRole("region", { name: "lumiform-ios" })).findByRole("button", { name: /^lumiform-ios/ });
    fireEvent.keyDown(ios, { key: "ArrowUp", altKey: true, metaKey: true });
    expect(onOrder).toHaveBeenLastCalledWith([LANTERN, IOS, MONITOR]);
    fireEvent.keyDown(ios, { key: "ArrowUp", metaKey: true });
    expect(onOrder).toHaveBeenCalledTimes(1);
  });

  it("drags a project by its header to a new place, settling it there before saving, and the release isn't a click", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder, open: ALL_OPEN });
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
    expect(within(project("network-monitor")).getByRole("button", { name: /^network-monitor/ })).toHaveAttribute("aria-expanded", "true");
    expect(onOrder).not.toHaveBeenCalled();
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith([MONITOR, LANTERN, IOS]));
    expect(project("network-monitor")).not.toHaveClass("lifted");
  });

  it("treats a press that barely moves as a click, and puts a dragged project back on Escape", async () => {
    const onOrder = vi.fn();
    setup({ order: ORDER, onOrder, open: ALL_OPEN });
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
