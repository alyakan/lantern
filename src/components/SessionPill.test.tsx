import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionPill } from "./SessionPill";

const sessions = [{ id: "s1", title: "Fix the login redirect", updated_ms: Date.now() - 120_000, prompts: 2 }];

describe("SessionPill", () => {
  it("opens the session menu below the capsule and picks a session", async () => {
    const onOpen = vi.fn();
    render(<SessionPill loadSessions={async () => sessions} currentId={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /New session/ }));
    fireEvent.click(await screen.findByText("Fix the login redirect"));
    expect(onOpen).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is disabled when told to be", () => {
    render(<SessionPill loadSessions={async () => []} currentId={null} onOpen={() => {}} disabled />);
    expect(screen.getByRole("button", { name: /New session/ })).toBeDisabled();
  });
});
