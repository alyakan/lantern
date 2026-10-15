import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModeGuide } from "./ModeGuide";
import { PermissionsMenu, WorkflowMenu } from "./ModeMenu";
import { StepsIntro } from "./StepsIntro";
import { ModeGuideContext } from "../lib/modeGuide";

describe("ModeGuide", () => {
  it("opens on a page, moves between modes and flavours, and switches to one", () => {
    const onUse = vi.fn();
    render(<ModeGuide open="review" permissions="ask" workflow="steps" flavour="review" onUse={onUse} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Review");
    expect(screen.getByText("You're in this flavour")).toBeInTheDocument();
    expect(screen.getByText(/rejected finding is dropped for good/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Debug");
    fireEvent.click(screen.getByRole("button", { name: "Start Debug" }));
    expect(onUse).toHaveBeenLastCalledWith("debug");
    fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Auto" }));
    expect(onUse).toHaveBeenLastCalledWith("auto");
    fireEvent.click(screen.getByRole("button", { name: /^Team/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Team" }));
    expect(onUse).toHaveBeenLastCalledWith("team");
  });

  it("lists Permissions, Workflows and five flavours, marks what the chat is on, and says what to ask for Learn", () => {
    render(<ModeGuide open="learn" permissions="ask" workflow="chat" flavour={null} onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Modes" });
    expect([...nav.querySelectorAll(".mode-guide-group-title")].map((t) => t.textContent)).toEqual(["Permissions", "Workflow", "Step by step's flavours"]);
    expect([...nav.querySelectorAll(".mode-guide-tab")].map((t) => t.textContent)).toEqual(["AskNow", "Auto", "ChatNow", "Step by step", "Team", "Build", "Learn", "Review", "Debug", "Architecture"]);
    expect(screen.getByText(/Try: .*interview/)).toBeInTheDocument();
    // No switch offered while the chat can't change.
    expect(screen.queryByRole("button", { name: /^(Use|Start) / })).toBeNull();
  });

  it("describes Team and each Permissions setting in the new vocabulary", () => {
    render(<ModeGuide open="team" permissions="auto" workflow="team" flavour={null} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Team");
    expect(document.querySelector(".mode-guide-eyebrow")).toHaveTextContent("Workflow");
    expect(screen.getByText(/Subagents, in the canvas controls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    expect(document.querySelector(".mode-guide-eyebrow")).toHaveTextContent("Permissions");
    expect(screen.getByText(/never has more freedom than its Lead/)).toBeInTheDocument();
  });

  it("is opened from the Permissions and Workflow menus and Step by step's intro", () => {
    const open = vi.fn();
    render(
      <ModeGuideContext.Provider value={open}>
        <PermissionsMenu permissions="auto" onChange={() => {}} />
        <WorkflowMenu workflow="steps" flavour="review" onChange={() => {}} />
        <StepsIntro picked={null} onPick={() => {}} />
      </ModeGuideContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Permissions: Auto/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /How the modes work/ }));
    // The Workflow chip names Step by step's flavour too.
    fireEvent.click(screen.getByRole("button", { name: /Step by step · Review/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /How the modes work/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(open.mock.calls).toEqual([["auto"], ["review"], ["steps"]]);
  });
});
