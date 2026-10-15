import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SidebarCompact } from "./SidebarCompact";
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
  const h = { onNewChat: vi.fn(), onChat: vi.fn(), onTeam: vi.fn(), onToggle: vi.fn(), onPointerEnter: vi.fn(), onPointerLeave: vi.fn() };
  const loadRecent = vi.fn().mockResolvedValue([
    { path: LANTERN, updated_ms: 2 },
    { path: MONITOR, updated_ms: 1 },
  ]);
  render(<SidebarCompact open={open} loadRecent={loadRecent} canNew colors={{}} onColors={vi.fn()} {...h} {...over} />);
  return { h, loadRecent };
}

const chipFor = (name: RegExp) => screen.getByRole("button", { name });

describe("the compact sidebar", () => {
  it("has a square for each open chat and team, but none for an agent, with the chat's initials, and a label above each project", async () => {
    setup();
    await waitFor(() => expect(screen.getAllByRole("list")).toHaveLength(2));
    const lantern = screen.getByRole("list", { name: "lantern" });
    expect(within(lantern).getAllByRole("button")).toHaveLength(5);
    // The title's initials: filler words skipped, a team by its Lead's title.
    expect(within(lantern).getAllByRole("button").map((b) => b.textContent)).toEqual(["NT", "FR", "RN", "PD", "AS"]);
    expect(within(screen.getByRole("list", { name: "network-monitor" })).getByText("RP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /security pass/ })).toBeNull();
    // Above each project's squares, its initials, with its name as the tooltip.
    const labels = Array.from(document.querySelectorAll(".cp-project"));
    expect(labels.map((l) => [l.textContent, l.getAttribute("title")])).toEqual([
      ["LA", "lantern"],
      ["NM", "network-monitor"],
    ]);
  });

  it("gives each project a colour of its own: a saved one stays, a new project gets one no other has, to save", async () => {
    const onColors = vi.fn();
    const color = (name: string) => screen.getByRole("list", { name }).style.getPropertyValue("--pc");
    const { rerender } = render(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={{ [MONITOR]: 0 }} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} onToggle={vi.fn()} />);
    expect(color("network-monitor")).toBe(PROJECT_COLORS[0]);
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    await waitFor(() => expect(onColors).toHaveBeenCalledWith({ [MONITOR]: 0, [LANTERN]: 1 }));
    // Once saved (and after a restart, read back), nothing new is saved and the colours stay.
    const saved = { [MONITOR]: 0, [LANTERN]: 1 };
    rerender(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={saved} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} onToggle={vi.fn()} />);
    await act(async () => {});
    onColors.mockClear();
    rerender(<SidebarCompact open={open} loadRecent={vi.fn().mockResolvedValue([])} canNew colors={saved} onColors={onColors} onNewChat={vi.fn()} onChat={vi.fn()} onTeam={vi.fn()} onToggle={vi.fn()} />);
    await act(async () => {});
    expect(color("lantern")).toBe(PROJECT_COLORS[1]);
    expect(onColors).not.toHaveBeenCalled();
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
    expect(chipFor(/^Team: Audit sweep/)).toHaveClass("team");
  });

  it("lights the chat on screen", async () => {
    setup();
    await screen.findByRole("list", { name: "lantern" });
    expect(chipFor(/Network tab polish/)).toHaveAttribute("aria-current", "true");
    expect(chipFor(/Network tab polish/)).toHaveClass("current");
    expect(chipFor(/Fix restore mode/)).not.toHaveAttribute("aria-current");
  });

  it("names a square on hover and focus: the title, the project and the status", async () => {
    setup();
    await screen.findByRole("list", { name: "lantern" });
    const square = chipFor(/Fix restore mode/);
    expect(square).toHaveAccessibleName("Fix restore mode, lantern, Needs you");
    fireEvent.mouseEnter(square);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Fix restore mode");
    expect(tip).toHaveTextContent("lantern · Needs you");
    fireEvent.mouseLeave(square);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(chipFor(/Release notes/));
    expect(screen.getByRole("tooltip")).toHaveTextContent("lantern · Unread");
    fireEvent.blur(chipFor(/Release notes/));
    expect(screen.queryByRole("tooltip")).toBeNull();
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

  it("tells the app when the pointer enters and leaves the column", () => {
    const { h } = setup();
    const column = screen.getByRole("complementary", { name: "Open chats" });
    fireEvent.pointerEnter(column);
    expect(h.onPointerEnter).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(column);
    expect(h.onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
