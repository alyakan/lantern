import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MemorySnapshot, MenuBarChat, MenuBarStats } from "../types";

const handlers: { chats: ((c: MenuBarChat[]) => void) | null; shown: (() => void) | null } = { chats: null, shown: null };
const api = {
  setMenuBar: vi.fn(() => Promise.resolve()),
  menubarStats: vi.fn(),
  memorySnapshot: vi.fn(),
  recentFolders: vi.fn(),
  menubarAct: vi.fn(),
  menubarFit: vi.fn(),
  menubarHide: vi.fn(),
  askMenubarChats: vi.fn(),
  onMenubarChats: vi.fn((cb: (c: MenuBarChat[]) => void) => {
    handlers.chats = cb;
    return Promise.resolve(() => {});
  }),
  onMenubarShown: vi.fn((cb: () => void) => {
    handlers.shown = cb;
    return Promise.resolve(() => {});
  }),
};
vi.mock("../api", () => ({ api: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { MenuBarPanel } from "./MenuBarPanel";
import { setMenuBar } from "../lib/menuBar";

const stats = (over: Partial<MenuBarStats> = {}): MenuBarStats => ({ ram: { total_bytes: 16_000_000_000, used_bytes: 10_000_000_000, pressure: "normal" }, disk_free: 82_000_000_000, disk_total: 494_000_000_000, ...over });
const snapshot = (): MemorySnapshot => ({
  total_bytes: 16e9, used_bytes: 10e9, cached_bytes: 3e9, free_bytes: 3e9, compressed_bytes: 1e9, swap_used_bytes: null, pressure: "normal", pressure_source: "kernel", scaled: false,
  apps: [
    { name: "Lantern and its agents", bytes: 3_100_000_000, processes: 14, share: 0.19, kind: "lantern" },
    { name: "Google Chrome", bytes: 2_200_000_000, processes: 20, share: 0.13, kind: "app" },
    { name: "Xcode", bytes: 1_400_000_000, processes: 6, share: 0.09, kind: "app" },
    { name: "Slack", bytes: 900_000_000, processes: 5, share: 0.05, kind: "app" },
    { name: "Other apps", bytes: 2_000_000_000, processes: 90, share: 0.12, kind: "other" },
  ],
});
const chat = (slot: string, over: Partial<MenuBarChat> = {}): MenuBarChat => ({ slot, title: `Chat ${slot}`, project: "acme-api", state: "done", team: false, ...over });

/** The panel as the user meets it: its window was just shown, which is what makes it read anything. */
async function shownPanel() {
  const view = render(<MenuBarPanel />);
  await waitFor(() => expect(handlers.shown).not.toBeNull());
  act(() => handlers.shown!());
  return view;
}

beforeEach(() => {
  handlers.chats = null;
  handlers.shown = null;
  localStorage.clear();
  document.documentElement.className = "";
  for (const fn of [api.menubarStats, api.memorySnapshot, api.recentFolders, api.menubarAct, api.menubarFit, api.menubarHide, api.askMenubarChats]) fn.mockReset();
  api.menubarStats.mockResolvedValue(stats());
  api.memorySnapshot.mockResolvedValue(snapshot());
  api.recentFolders.mockResolvedValue([{ path: "/Users/me/acme-api", updated_ms: 2 }, { path: "/Users/me/web", updated_ms: 1 }]);
  api.menubarAct.mockResolvedValue(undefined);
  api.menubarFit.mockResolvedValue(undefined);
  api.menubarHide.mockResolvedValue(undefined);
  api.askMenubarChats.mockResolvedValue(undefined);
});

describe("MenuBarPanel", () => {
  it("shows memory used with its pressure and the biggest apps, and the disk free, from the numbers it reads", async () => {
    await shownPanel();
    const memory = await screen.findByRole("region", { name: "Memory" });
    await waitFor(() => expect(within(memory).getByText("63%")).toBeInTheDocument());
    expect(within(memory).getByText("10.0 GB of 16.0 GB used · Normal pressure")).toBeInTheDocument();
    expect(within(memory).getByRole("progressbar", { name: "Memory used" })).toHaveAttribute("aria-valuenow", "63");
    // The three biggest named apps, not "Other apps" and not a fourth.
    const apps = await within(memory).findAllByRole("listitem");
    expect(apps.map((a) => a.textContent)).toEqual(["Lantern and its agents3.1 GB", "Google Chrome2.2 GB", "Xcode1.4 GB"]);
    const disk = screen.getByRole("region", { name: "Disk" });
    expect(within(disk).getByText("82.0 GB free")).toBeInTheDocument();
    expect(within(disk).getByText("83% of 494.0 GB used")).toBeInTheDocument();
  });

  it("reads nothing until it is shown, and stops when it loses focus", async () => {
    render(<MenuBarPanel />);
    await waitFor(() => expect(handlers.shown).not.toBeNull());
    // A panel that was created at launch and never opened must cost nothing.
    await new Promise((r) => setTimeout(r, 100));
    expect(api.menubarStats).not.toHaveBeenCalled();
    expect(api.memorySnapshot).not.toHaveBeenCalled();
    act(() => handlers.shown!());
    await waitFor(() => expect(api.menubarStats).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.memorySnapshot).toHaveBeenCalledTimes(1));
    // Closed again: the timers are cleared, so no more is read.
    act(() => window.dispatchEvent(new Event("blur")));
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTime(30_000));
    vi.useRealTimers();
    expect(api.menubarStats).toHaveBeenCalledTimes(1);
  });

  it("draws the disk meter amber when little is free and red when almost none is", async () => {
    api.menubarStats.mockResolvedValue(stats({ disk_free: 8_300_000_000 }));
    const { unmount } = await shownPanel();
    const bar = () => within(screen.getByRole("region", { name: "Disk" })).getByRole("progressbar", { name: "Disk used" });
    await waitFor(() => expect(bar()).toHaveClass("warn"));
    unmount();
    handlers.shown = null;
    api.menubarStats.mockResolvedValue(stats({ disk_free: 3_000_000_000 }));
    await shownPanel();
    await waitFor(() => expect(bar()).toHaveClass("critical"));
  });

  it("lists the open chats, what needs you first, and opens one on a click", async () => {
    await shownPanel();
    await waitFor(() => expect(handlers.chats).not.toBeNull());
    act(() => handlers.chats!([chat("s1", { title: "Done one" }), chat("s2", { title: "Working one", state: "running" }), chat("s3", { title: "Asking one", state: "waiting" }), chat("s4", { title: "A team", team: true, state: "running", project: "web" })]));
    const list = screen.getByRole("list", { name: "Open chats" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Asking oneacme-api", "Working oneacme-api", "A teamTeam · web", "Done oneacme-api"]);
    // Each row's dot says its state in words.
    expect(within(list).getAllByRole("img").map((d) => d.getAttribute("aria-label"))).toEqual(["Needs you", "Working", "Working", "Done"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 needs you");
    fireEvent.click(within(list).getByRole("button", { name: /Working one/ }));
    expect(api.menubarAct).toHaveBeenCalledWith({ kind: "chat", slot: "s2" });
  });

  it("says when nothing is open, and how many more there are beyond the five it lists", async () => {
    render(<MenuBarPanel />);
    expect(await screen.findByText("No chats open.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("All quiet");
    act(() => handlers.chats!(Array.from({ length: 8 }, (_, i) => chat(`s${i}`))));
    expect(within(screen.getByRole("list", { name: "Open chats" })).getAllByRole("button")).toHaveLength(5);
    expect(screen.getByText("3 more in Lantern")).toBeInTheDocument();
  });

  it("starts a chat in the chosen project with what was typed, on Enter, and clears the box", async () => {
    render(<MenuBarPanel />);
    const box = await screen.findByRole("textbox", { name: "What should Claude do?" });
    const project = screen.getByRole("combobox", { name: "Project" });
    await waitFor(() => expect(within(project).getAllByRole("option")).toHaveLength(2));
    expect(project).toHaveValue("/Users/me/acme-api");
    fireEvent.change(project, { target: { value: "/Users/me/web" } });
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "  add a dark mode  " } });
    // Shift+Enter is a new line, not a start.
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.menubarAct).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.menubarAct).toHaveBeenCalledWith({ kind: "new_chat", folder: "/Users/me/web", text: "add a dark mode" }));
    await waitFor(() => expect(box).toHaveValue(""));
    // The project is remembered for next time.
    expect(JSON.parse(localStorage.getItem("menubar.folder")!)).toBe("/Users/me/web");
  });

  it("keeps what was typed and says why when the chat couldn't be started", async () => {
    api.menubarAct.mockRejectedValue("That isn't a project folder.");
    render(<MenuBarPanel />);
    const box = await screen.findByRole("textbox", { name: "What should Claude do?" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("/Users/me/acme-api"));
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That isn't a project folder.");
    expect(box).toHaveValue("hello");
  });

  it("leaves projects the user removed from the sidebar out of the choice", async () => {
    localStorage.setItem("sidebar.hidden", JSON.stringify(["/Users/me/web"]));
    render(<MenuBarPanel />);
    const project = await screen.findByRole("combobox", { name: "Project" });
    await waitFor(() => expect(within(project).getAllByRole("option").map((o) => o.textContent)).toEqual(["acme-api"]));
  });

  it("asks the main window for Storage, for Open, and for the Menu bar settings", async () => {
    render(<MenuBarPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Free up space" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Lantern" }));
    fireEvent.click(screen.getByRole("button", { name: "Menu bar settings" }));
    expect(api.menubarAct.mock.calls.map(([a]) => a.kind)).toEqual(["storage", "open", "settings"]);
  });

  it("closes on Escape", async () => {
    render(<MenuBarPanel />);
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Lantern" }), { key: "Escape" });
    expect(api.menubarHide).toHaveBeenCalled();
  });

  it("shows only the sections the user chose", async () => {
    setMenuBar({ panel: { memory: false, chats: false } });
    await shownPanel();
    expect(await screen.findByRole("region", { name: "Disk" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "New chat" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Memory" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Chats" })).toBeNull();
    // Nothing is read for a section that isn't shown.
    expect(api.memorySnapshot).not.toHaveBeenCalled();
  });

  it("takes a transparent page for its window, and asks for the open chats when it starts and each time it is shown", async () => {
    render(<MenuBarPanel />);
    await waitFor(() => expect(api.askMenubarChats).toHaveBeenCalledTimes(1));
    expect(document.documentElement).toHaveClass("menubar-window");
    await waitFor(() => expect(handlers.shown).not.toBeNull());
    act(() => handlers.shown!());
    expect(api.askMenubarChats).toHaveBeenCalledTimes(2);
  });

  it("follows the saved theme each time it is shown", async () => {
    render(<MenuBarPanel />);
    await waitFor(() => expect(handlers.shown).not.toBeNull());
    expect(document.documentElement.dataset.theme).toBe("system");
    localStorage.setItem("settings.theme", JSON.stringify("dark"));
    act(() => handlers.shown!());
    expect(document.documentElement.dataset.theme).toBe("dark");
    localStorage.setItem("settings.theme", JSON.stringify("light"));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "settings.theme" })));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
