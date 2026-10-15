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
    // The last row is Explain as you go, below the flavours.
    expect(screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(badge).toHaveFocus();
  });

  it("lists Design, not Architecture, and no Learn flavour", () => {
    render(<FlavourBadge flavour="build" onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Build/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Build", "Review", "Debug", "Design"]);
  });

  it("turns Explain as you go on and off for Build and Debug, and shows it on the badge", () => {
    const onPick = vi.fn();
    const { rerender } = render(<FlavourBadge flavour="debug" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
    const option = screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ });
    expect(option).toHaveAttribute("aria-checked", "false");
    fireEvent.click(option);
    expect(onPick).toHaveBeenLastCalledWith("debug", true);
    rerender(<FlavourBadge flavour="debug" explain onPick={onPick} />);
    expect(screen.getByRole("button", { name: /Debug/ })).toHaveTextContent("explaining");
    fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ }));
    expect(onPick).toHaveBeenLastCalledWith("debug", false);
  });

  it("offers Explain as you go only where it applies", () => {
    render(<FlavourBadge flavour="review" onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Explain as you go/ })).toBeDisabled();
  });
});
