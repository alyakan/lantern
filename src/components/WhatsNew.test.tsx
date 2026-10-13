import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WhatsNew } from "./WhatsNew";

describe("What's new", () => {
  it("shows the release's changes under the version's name, with the link to its page", () => {
    render(<WhatsNew version="0.1.16" notes={"- Faster search\n- A calmer toast"} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "What's new in Lantern 0.1.16" })).toBeInTheDocument();
    expect(screen.getByText("Faster search")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release page" })).toHaveAttribute("href", "https://github.com/alyakan/lantern/releases/tag/v0.1.16");
  });

  it("doesn't load the pictures in the notes", () => {
    render(<WhatsNew version="0.1.16" notes={"Look: ![the new view](https://example.com/shot.png)"} onClose={() => {}} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".md-image-blocked")).not.toBeNull();
  });

  it("links the release page when its changes can't be had, instead of showing nothing", () => {
    render(<WhatsNew version="0.1.16" notes={null} onClose={() => {}} />);
    expect(screen.getByText(/aren't kept here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release page" })).toBeInTheDocument();
  });

  it("closes with Got it", () => {
    const onClose = vi.fn();
    render(<WhatsNew version="0.1.16" notes={"- x"} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
