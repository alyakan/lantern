import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModeGuide } from "./ModeGuide";
import { ModeMenu } from "./ModeMenu";
import { StepsIntro } from "./StepsIntro";
import { ModeGuideContext } from "../lib/modeGuide";

describe("ModeGuide", () => {
  it("opens on a mode's page, moves between modes, and switches to one", () => {
    const onUse = vi.fn();
    render(<ModeGuide open="review" current="review" onUse={onUse} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Review");
    expect(screen.getByText("You're in this mode")).toBeInTheDocument();
    expect(screen.getByText(/Rejected finding is dropped for good/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Debug");
    fireEvent.click(screen.getByRole("button", { name: "Use Debug" }));
    expect(onUse).toHaveBeenCalledWith("debug");
  });

  it("offers no switch while the chat can't change mode", () => {
    render(<ModeGuide open="teach" current="steps" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("is opened from the mode menu and Step by step's intro, on the mode you're in", () => {
    const open = vi.fn();
    render(
      <ModeGuideContext.Provider value={open}>
        <ModeMenu mode="review" onChange={() => {}} />
        <StepsIntro mode="review" onFlavour={() => {}} />
      </ModeGuideContext.Provider>,
    );
    // The chip names Step by step's style too.
    fireEvent.click(screen.getByRole("button", { name: /Step by step · Review/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /How the modes work/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(open.mock.calls).toEqual([["review"], ["review"]]);
  });
});
