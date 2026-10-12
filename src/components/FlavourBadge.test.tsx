import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FLAVOUR_LABEL, FLAVOURS } from "../lib/flavour";
import { FlavourBadge } from "./FlavourBadge";

describe("FlavourBadge", () => {
  it("picks another flavour from its menu", () => {
    const onPick = vi.fn();
    render(<FlavourBadge flavour="build" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /Build/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Debug/ }));
    expect(onPick).toHaveBeenCalledWith("debug");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves between the flavours with the arrow keys, and gives focus back to its badge when it closes", () => {
    render(<FlavourBadge flavour={FLAVOURS[0]} onPick={() => {}} />);
    const badge = screen.getByRole("button", { name: new RegExp(FLAVOUR_LABEL[FLAVOURS[0]]) });
    fireEvent.click(badge);
    const rows = screen.getAllByRole("menuitemradio");
    // The flavour in use takes focus when the menu opens.
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(rows[rows.length - 1]).toHaveFocus();
    fireEvent.keyDown(rows[rows.length - 1], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(badge).toHaveFocus();
  });
});
