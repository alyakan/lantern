import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModeGuide } from "./ModeGuide";
import { ModeMenu } from "./ModeMenu";
import { StepsIntro } from "./StepsIntro";
import { ModeGuideContext } from "../lib/modeGuide";

describe("ModeGuide", () => {
  it("opens on a page, moves between modes and flavours, and switches to one", () => {
    const onUse = vi.fn();
    render(<ModeGuide open="review" mode="steps" flavour="review" onUse={onUse} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Review");
    expect(screen.getByText("You're in this flavour")).toBeInTheDocument();
    expect(screen.getByText(/rejected finding is dropped for good/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Debug");
    fireEvent.click(screen.getByRole("button", { name: "Start Debug" }));
    expect(onUse).toHaveBeenLastCalledWith("debug");
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Auto-approve" }));
    expect(onUse).toHaveBeenLastCalledWith("auto");
  });

  it("lists three modes and four flavours, and says what to ask for Learn", () => {
    render(<ModeGuide open="learn" mode="ask" flavour={null} onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Modes" });
    expect([...nav.querySelectorAll(".mode-guide-tab")].map((t) => t.textContent)).toEqual(["Ask before actionsNow", "Auto-approve", "Step by step", "Build", "Learn", "Review", "Debug"]);
    expect(screen.getByText(/Try: .*interview/)).toBeInTheDocument();
    // No switch offered while the chat can't change.
    expect(screen.queryByRole("button", { name: /^(Use|Start) / })).toBeNull();
  });

  it("is opened from the mode menu and Step by step's intro", () => {
    const open = vi.fn();
    render(
      <ModeGuideContext.Provider value={open}>
        <ModeMenu mode="steps" flavour="review" onChange={() => {}} />
        <StepsIntro picked={null} onPick={() => {}} />
      </ModeGuideContext.Provider>,
    );
    // The chip names Step by step's flavour too.
    fireEvent.click(screen.getByRole("button", { name: /Step by step · Review/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /How the modes work/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(open.mock.calls).toEqual([["review"], ["steps"]]);
  });
});
