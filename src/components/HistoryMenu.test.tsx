import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryMenu } from "./HistoryMenu";

const sessions = [
  { id: "a", title: "Add retries to fetchJson", updated_ms: Date.now() - 60_000 * 5, prompts: 3 },
  { id: "b", title: "Fix the login redirect", updated_ms: Date.now() - 3_600_000 * 30, prompts: 1 },
];

describe("HistoryMenu", () => {
  it("lists sessions, marks the current one, and opens a pick", () => {
    const onOpen = vi.fn();
    render(<HistoryMenu sessions={sessions} currentId="b" onOpen={onOpen} onClose={() => {}} />);
    expect(screen.getByText("5m ago")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Fix the login redirect/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByText("Add retries to fetchJson"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("lists the chat on screen under Open, not among past sessions", () => {
    const open = [{ slot: "s2", title: "Other project chat", state: "done" as const, sessionId: "x", elsewhere: "web" }];
    render(<HistoryMenu sessions={sessions} currentId="b" onOpen={() => {}} onClose={() => {}} open={open} />);
    const openList = screen.getByRole("listbox", { name: "Open chats" });
    expect([...openList.querySelectorAll(".menu-row-title")].map((t) => t.textContent)).toEqual(["Fix the login redirect", "Other project chat"]);
    // A chat from another project says which, beside its title rather than in it.
    expect(screen.getByLabelText("in web")).toHaveTextContent("web");
    const past = screen.getByRole("listbox", { name: "Past sessions" });
    expect(past).not.toHaveTextContent("Fix the login redirect");
    expect(past).toHaveTextContent("Add retries to fetchJson");
  });

  it("says when a finished chat still runs something in the background", () => {
    const open = [{ slot: "s2", title: "Start the dev server", state: "done" as const, background: 1, sessionId: "x", elsewhere: null }];
    render(<HistoryMenu sessions={[]} currentId={null} onOpen={() => {}} onClose={() => {}} open={open} />);
    expect(screen.getByRole("listbox", { name: "Open chats" })).toHaveTextContent("Start the dev server1 in background");
  });

  it("filters by search text", () => {
    render(<HistoryMenu sessions={sessions} currentId={null} onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "login" } });
    expect(screen.queryByText("Add retries to fetchJson")).toBeNull();
    expect(screen.getByText("Fix the login redirect")).toBeInTheDocument();
  });

  it("shows empty and loading states, and closes on Escape", () => {
    const onClose = vi.fn();
    const { rerender } = render(<HistoryMenu sessions={null} currentId={null} onOpen={() => {}} onClose={onClose} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    rerender(<HistoryMenu sessions={[]} currentId={null} onOpen={() => {}} onClose={onClose} />);
    expect(screen.getByText("No past sessions in this folder")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Search sessions"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes a finished open chat, but not one that's still working or waiting", () => {
    const onCloseChat = vi.fn();
    const open = [
      { slot: "s2", title: "Fix the parser", state: "done" as const, sessionId: "x", elsewhere: "web" },
      { slot: "s3", title: "Add retries", state: "running" as const, sessionId: "y", elsewhere: null },
      { slot: "s4", title: "Rename env", state: "waiting" as const, sessionId: "z", elsewhere: null },
    ];
    render(<HistoryMenu sessions={[]} currentId={null} onOpen={() => {}} onClose={() => {}} open={open} onCloseChat={onCloseChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Fix the parser" }));
    expect(onCloseChat).toHaveBeenCalledWith("s2");
    expect(screen.queryByRole("button", { name: "Close Add retries" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Rename env" })).toBeNull();
  });
});
