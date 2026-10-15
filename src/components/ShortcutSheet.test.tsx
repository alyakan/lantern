import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ShortcutSheet } from "./ShortcutSheet";
import { ACTIONS, shortcutLabel } from "../lib/actions";

describe("the shortcut sheet", () => {
  it("lists every shortcut the registry has, under its group, with the key as the menu shows it", () => {
    render(<ShortcutSheet available={[]} onClose={() => {}} />);
    for (const def of ACTIONS.filter((a) => a.key)) {
      const group = screen.getByRole("region", { name: def.group });
      const row = within(group).getByText(def.title).closest("li");
      expect(row, def.id).not.toBeNull();
      expect(within(row as HTMLElement).getByText(shortcutLabel(def) ?? "")).toBeInTheDocument();
    }
  });

  it("lists the groups in the order of the menu bar, and leaves out what has no shortcut", () => {
    render(<ShortcutSheet available={[]} onClose={() => {}} />);
    const groups = screen.getAllByRole("region").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["File", "View", "Search", "Work", "Chat", "Help"]);
    // Report a Bug… is in the menu, but it has no shortcut to show.
    expect(screen.queryByText("Report a Bug…")).toBeNull();
  });

  it("dims the shortcuts that can't be used right now, and says why", () => {
    render(<ShortcutSheet available={["settings"]} onClose={() => {}} />);
    expect(screen.getByText("Settings…").closest("li")).not.toHaveClass("off");
    const dimmed = screen.getByText("Chat History").closest("li");
    expect(dimmed).toHaveClass("off");
    expect(dimmed).toHaveAttribute("title", "Not available right now");
  });

  it("closes with its Close button", () => {
    const onClose = vi.fn();
    render(<ShortcutSheet available={[]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
