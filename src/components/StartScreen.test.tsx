import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StartScreen } from "./StartScreen";

const props = { picked: null, team: false, onFlavour: vi.fn(), onReview: vi.fn(), onTeam: vi.fn() };

describe("StartScreen", () => {
  it("shows Build, Review a PR, Debug, Design and Start a team, with what to ask for", () => {
    render(<StartScreen {...props} />);
    const names = [...screen.getByRole("group", { name: "Ways to start" }).querySelectorAll(".steps-intro-flavour-name")].map((n) => n.textContent);
    expect(names).toEqual(["Build", "Review a PR", "Debug", "Design", "Start a team"]);
    expect(screen.getByRole("button", { name: /Design.*Map the architecture/ })).toBeInTheDocument();
    expect(screen.queryByText(/Learn|Architecture\b/)).toBeNull();
  });

  it("picks a flavour or none, opens the PR list, and toggles the team", () => {
    const onFlavour = vi.fn();
    const onReview = vi.fn();
    const onTeam = vi.fn();
    const { rerender } = render(<StartScreen {...props} onFlavour={onFlavour} onReview={onReview} onTeam={onTeam} />);
    fireEvent.click(screen.getByRole("button", { name: /^Debug/ }));
    expect(onFlavour).toHaveBeenLastCalledWith("debug");
    fireEvent.click(screen.getByRole("button", { name: /^Design/ }));
    expect(onFlavour).toHaveBeenLastCalledWith("architecture");
    fireEvent.click(screen.getByRole("button", { name: /^Review a PR/ }));
    expect(onReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /^Start a team/ }));
    expect(onTeam).toHaveBeenCalledOnce();
    rerender(<StartScreen {...props} picked="debug" onFlavour={onFlavour} />);
    expect(screen.getByRole("button", { name: /^Debug/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Debug/ }));
    expect(onFlavour).toHaveBeenLastCalledWith(null);
    rerender(<StartScreen {...props} team />);
    expect(screen.getByRole("button", { name: /^Start a team/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers Explain as you go for Build and Debug only, once picked", () => {
    const onExplain = vi.fn();
    const { rerender } = render(<StartScreen {...props} onExplain={onExplain} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(<StartScreen {...props} picked="architecture" onExplain={onExplain} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(<StartScreen {...props} picked="build" onExplain={onExplain} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Explain as you go/ }));
    expect(onExplain).toHaveBeenCalledWith(true);
    rerender(<StartScreen {...props} picked="debug" explain onExplain={onExplain} />);
    expect(screen.getByRole("checkbox", { name: /Explain as you go/ })).toBeChecked();
  });
});
