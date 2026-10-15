import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OPEN_AFTER_MS, SidebarCompact } from "./SidebarCompact";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { ProjectOpen, SidebarChat } from "../lib/sidebar";

const LANTERN = "/work/lantern";
const MONITOR = "/work/network-monitor";

const chat = (slot: string, title: string, over: Partial<SidebarChat> = {}): SidebarChat => ({ slot, title, state: "done", unread: false, background: 0, sessionId: null, active: false, pinned: false, closable: false, ...over });
const open: Record<string, ProjectOpen> = {
  [LANTERN]: {
    items: [
      { kind: "chat", ...chat("s1", "Network tab polish", { state: "running", active: true }) },
      { kind: "chat", ...chat("s2", "Fix restore mode", { state: "waiting" }) },
      { kind: "chat", ...chat("s3", "Release notes", { unread: true }) },
      { kind: "chat", ...chat("s4", "Plain done") },
      { kind: "team", ...chat("lead", "Audit sweep", { state: "waiting" }), agents: [chat("a1", "security pass", { state: "waiting" })] },
    ],
    sessionIds: [],
    needs: 2,
    target: null,
  },
  [MONITOR]: { items: [{ kind: "chat", ...chat("m1", "Retry the proxy") }], sessionIds: [], needs: 0, target: null },
};

function setup(over: Partial<React.ComponentProps<typeof SidebarCompact>> = {}) {
  const h = { onNewChat: vi.fn(), onChat: vi.fn(), onTeam: vi.fn(), onToggle: vi.fn() };
  const loadRecent = vi.fn().mockResolvedValue([
    { path: LANTERN, updated_ms: 2 },
    { path: MONITOR, updated_ms: 1 },
  ]);
  render(<SidebarCompact open={open} loadRecent={loadRecent} canNew colors={{}} onColors={vi.fn()} width={260} {...h} {...over} />);
  return { h, loadRecent };
}

const chipFor = (name: RegExp) => screen.getByRole("button", { name });

describe("the compact sidebar", () => {
  const had = window.PointerEvent;
  beforeAll(() => {
    window.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
  });
  afterAll(() => {
    window.PointerEvent = had;
  });

  it("has a square for each open chat and team, but none for an agent, with the chat's initials, and a label above each project", async () => {
    setup();
    await waitFor(() => expect(screen.getAllByRole("list")).toHaveLength(2));
    const lantern = screen.getByRole("list", { name: "lantern" });
    expect(within(lantern).getAllByRole("button")).toHaveLength(5);
    // The title's initials: filler words skipped, a team by its Lead's title.
    expect(within(lantern).getAllByRole("button").map((b) => b.querySelector(".cp-initials")?.textContent)).toEqual(["NT", "FR", "RN", "PD", "AS"]);
    expect(within(screen.getByRole("list", { name: "network-monitor" })).getByText("RP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /security pass/ })).toBeNull();
    // Above each project's squares, its initials, with its name as the tooltip.
    const labels = Array.from(document.querySelectorAll(".cp-project"));
    expect(labels.map((l) => [l.querySelector(".cp-project-initials")?.textContent, l.getAttribute("title")])).toEqual([
      ["LA", "lantern"],
      ["NM", "network-monitor"],
    ]);
  });

  it("gives each project a colour of its own: a saved one stays, a new project gets one no other has, to save", async () => {
    const onColors = vi.fn();
    const color = (name: string) => screen.getByRole("list", { name }).style.getPropertyValue("--pc");
    const { rerender } = render(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={{ [MONITOR]: 0 }} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} width={260} onToggle={vi.fn()} />);
    expect(color("network-monitor")).toBe(PROJECT_COLORS[0]);
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    await waitFor(() => expect(onColors).toHaveBeenCalledWith({ [MONITOR]: 0, [LANTERN]: 1 }));
    // Once saved (and after a restart, read back), nothing new is saved and the colours stay.
    const saved = { [MONITOR]: 0, [LANTERN]: 1 };
    rerender(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={saved} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} width={260} onToggle={vi.fn()} />);
    await act(async () => {});
    onColors.mockClear();
    rerender(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={saved} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} width={260} onToggle={vi.fn()} />);
    await act(async () => {});
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    expect(onColors).not.toHaveBeenCalled();
  });

  it("lists projects in the saved order, and saves one new to it at the top, but doesn't start the order itself", async () => {
    const onOrder = vi.fn();
    const props = { width: 260, loadRecent: vi.fn().mockResolvedValue([]), canNew: true, colors: {}, onColors: vi.fn(), onNewChat: vi.fn(), onChat: vi.fn(), onTeam: vi.fn(), onToggle: vi.fn() };
    const { unmount } = render(<SidebarCompact open={open} order={[MONITOR]} onOrder={onOrder} {...props} />);
    expect(screen.getAllByRole("list").map((l) => l.getAttribute("aria-label"))).toEqual(["lantern", "network-monitor"]);
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith([LANTERN, MONITOR]));
    unmount();
    const none = vi.fn();
    render(<SidebarCompact open={open} order={[]} onOrder={none} {...props} />);
    await act(async () => {});
    expect(none).not.toHaveBeenCalled();
  });

  it("marks what works, what needs you and what finished unread; a plain finished chat has no mark", async () => {
    setup();
    await screen.findByRole("list", { name: "lantern" });
    const marks = (name: RegExp) => Array.from(chipFor(name).querySelectorAll(".cp-mark")).map((m) => m.className);
    expect(marks(/Network tab polish/)).toEqual(["cp-mark running"]);
    expect(marks(/Fix restore mode/)).toEqual(["cp-mark waiting"]);
    expect(marks(/Release notes/)).toEqual(["cp-mark unread"]);
    expect(marks(/Plain done/)).toEqual([]);
    expect(marks(/^Team: Audit sweep/)).toEqual(["cp-mark waiting"]);
    expect(chipFor(/^Team: Audit sweep/).querySelector(".cp-chip")).toHaveClass("team");
  });

  it("lights the chat on screen", async () => {
    setup();
    await screen.findByRole("list", { name: "lantern" });
    expect(chipFor(/Network tab polish/)).toHaveAttribute("aria-current", "true");
    expect(chipFor(/Network tab polish/)).toHaveClass("current");
    expect(chipFor(/Fix restore mode/)).not.toHaveAttribute("aria-current");
  });

  it("has the title, the project and the status as each row's name, and shows the title and status beside the square", async () => {
    setup();
    await screen.findByRole("list", { name: "lantern" });
    const row = chipFor(/Fix restore mode/);
    expect(row).toHaveAccessibleName("Fix restore mode, lantern, Needs you");
    expect(row.querySelector(".cp-title")).toHaveTextContent("Fix restore mode");
    expect(row.querySelector(".cp-status")).toHaveTextContent("Needs you");
    expect(row.querySelector(".cp-status")).toHaveClass("waiting");
    expect(document.querySelector(".cp-project-name")).toHaveTextContent("lantern");
  });

  it("switches to a chat on a click, and opens a team's canvas", async () => {
    const { h } = setup();
    await screen.findByRole("list", { name: "lantern" });
    fireEvent.click(chipFor(/Fix restore mode/));
    expect(h.onChat).toHaveBeenCalledWith("s2");
    fireEvent.click(chipFor(/^Team: Audit sweep/));
    expect(h.onTeam).toHaveBeenCalledWith("lead");
    expect(h.onChat).toHaveBeenCalledTimes(1);
  });

  it("has a + for a new chat (off when none can start) and a button back to the full sidebar", async () => {
    const { h } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(h.onNewChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Full sidebar" }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("disables + when nothing can be started", () => {
    setup({ canNew: false });
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("opens over the chat once the pointer rests on it, not as it passes, and closes when it leaves or a chat is picked", async () => {
    vi.useFakeTimers();
    try {
      const { h } = setup();
      await act(async () => {});
      const panel = document.querySelector<HTMLElement>(".cp-panel")!;
      expect(panel.style.getPropertyValue("--cp-open")).toBe("260px");
      // Passing over it on the way to the chat.
      fireEvent.pointerEnter(panel);
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS - 50));
      fireEvent.pointerLeave(panel);
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel).not.toHaveClass("expanded");
      // Resting on it.
      fireEvent.pointerEnter(panel);
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      expect(panel).toHaveClass("expanded");
      fireEvent.pointerLeave(panel);
      expect(panel).not.toHaveClass("expanded");
      // Picking a chat closes it.
      fireEvent.pointerEnter(panel);
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS));
      fireEvent.click(chipFor(/Fix restore mode/));
      expect(h.onChat).toHaveBeenCalledWith("s2");
      expect(panel).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't open while something is dragged across it", () => {
    vi.useFakeTimers();
    try {
      setup();
      const panel = document.querySelector<HTMLElement>(".cp-panel")!;
      fireEvent.pointerEnter(panel, { buttons: 1 });
      act(() => vi.advanceTimersByTime(OPEN_AFTER_MS * 2));
      expect(panel).not.toHaveClass("expanded");
    } finally {
      vi.useRealTimers();
    }
  });
});
