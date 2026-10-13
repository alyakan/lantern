import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import type { PaletteEntry } from "../lib/palette";

const entries = (): PaletteEntry[] => [
  { id: "settings", title: "Settings…", group: "View", shortcut: "⌘,", run: vi.fn() },
  { id: "session-history", title: "Session History", group: "View", shortcut: "⌘K", run: vi.fn() },
  { id: "mode:auto", title: "Switch to Auto-approve", group: "Mode", shortcut: null, run: vi.fn() },
];

const rows = () => screen.getAllByRole("option");
const search = () => screen.getByRole("combobox", { name: "Search commands" });

describe("the command palette", () => {
  it("lists every entry with its shortcut, and the first one picked", () => {
    render(<CommandPalette entries={entries()} onClose={() => {}} />);
    expect(rows().map((r) => r.textContent)).toEqual(["Settings…View⌘,", "Session HistoryView⌘K", "Switch to Auto-approveMode"]);
    expect(within(rows()[0]).getByText("⌘,")).toBeInTheDocument();
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    expect(rows()[2]).toHaveAttribute("aria-selected", "false");
    expect(search()).toHaveAttribute("aria-activedescendant", "palette-0");
  });

  it("narrows the list as you type, and says so when nothing matches", () => {
    render(<CommandPalette entries={entries()} onClose={() => {}} />);
    fireEvent.change(search(), { target: { value: "hist" } });
    expect(rows().map((r) => r.textContent)).toEqual(["Session HistoryView⌘K"]);
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText(/No command matches “zzz”/)).toBeInTheDocument();
  });

  it("moves the pick with the arrow keys, wrapping at either end", () => {
    render(<CommandPalette entries={entries()} onClose={() => {}} />);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(rows()[2]).toHaveAttribute("aria-selected", "true");
  });

  it("closes, then runs the picked entry on Enter", () => {
    const list = entries();
    const order: string[] = [];
    list[1].run = () => order.push("ran");
    const onClose = vi.fn(() => order.push("closed"));
    render(<CommandPalette entries={list} onClose={onClose} />);
    fireEvent.change(search(), { target: { value: "hist" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(order).toEqual(["closed", "ran"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs an entry when it's clicked", () => {
    const list = entries();
    const onClose = vi.fn();
    render(<CommandPalette entries={list} onClose={onClose} />);
    fireEvent.click(rows()[2]);
    expect(list[2].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("follows the mouse as the pick", () => {
    render(<CommandPalette entries={entries()} onClose={() => {}} />);
    fireEvent.mouseEnter(rows()[1]);
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape and runs nothing", () => {
    const list = entries();
    const onClose = vi.fn();
    render(<CommandPalette entries={list} onClose={onClose} />);
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(list[0].run).not.toHaveBeenCalled();
  });

  it("does nothing on Enter when nothing matches", () => {
    const list = entries();
    const onClose = vi.fn();
    render(<CommandPalette entries={list} onClose={onClose} />);
    fireEvent.change(search(), { target: { value: "zzz" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
