import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionPill } from "./SessionPill";

const sessions = [{ id: "s1", title: "Fix the login redirect", updated_ms: Date.now() - 120_000, prompts: 2 }];

describe("SessionPill", () => {
  it("opens the session menu below the capsule and picks a session", async () => {
    const onOpen = vi.fn();
    render(<SessionPill loadSessions={async () => sessions} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    fireEvent.click(await screen.findByText("Fix the login redirect"));
    expect(onOpen).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape from a chat in the list, with focus back on its button", async () => {
    render(<SessionPill loadSessions={async () => sessions} onOpen={() => {}} />);
    const pill = screen.getByRole("button", { name: /New chat/ });
    fireEvent.click(pill);
    const row = await screen.findByRole("button", { name: /Fix the login redirect/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pill).toHaveFocus();
  });

  it("walks the search box and the chats with the arrow keys", async () => {
    render(<SessionPill loadSessions={async () => sessions} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    const search = await screen.findByPlaceholderText("Search chats");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /Fix the login redirect/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(search).toHaveFocus();
  });

  it("is disabled when told to be", () => {
    render(<SessionPill loadSessions={async () => []} onOpen={() => {}} disabled />);
    expect(screen.getByRole("button", { name: /New chat/ })).toBeDisabled();
  });
});
