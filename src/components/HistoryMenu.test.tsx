import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryMenu } from "./HistoryMenu";
import { SessionActionsContext, type SessionActions } from "../lib/sessionActions";

const sessions = [
  { id: "a", title: "Add retries to fetchJson", updated_ms: Date.now() - 60_000 * 5, prompts: 3 },
  { id: "b", title: "Fix the login redirect", updated_ms: Date.now() - 3_600_000 * 30, prompts: 1 },
];

describe("HistoryMenu", () => {
  it("lists past chats and opens a pick", () => {
    const onOpen = vi.fn();
    render(<HistoryMenu sessions={sessions} onOpen={onOpen} onClose={() => {}} />);
    expect(screen.getByText("5m ago")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add retries to fetchJson"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("lists past chats only: a chat that is open (the sidebar has it) is left out, and there is no Open list", () => {
    render(<HistoryMenu sessions={sessions} exclude={["b"]} onOpen={() => {}} onClose={() => {}} />);
    const past = screen.getByRole("list", { name: "Past chats" });
    expect(past).toHaveTextContent("Add retries to fetchJson");
    expect(past).not.toHaveTextContent("Fix the login redirect");
    expect(screen.queryByRole("list", { name: "Open chats" })).toBeNull();
    expect(screen.queryByText("Open chats")).toBeNull();
  });

  it("names the project above the list", () => {
    render(<HistoryMenu sessions={sessions} project="acme-api" onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Past chats in acme-api")).toBeInTheDocument();
  });

  it("offers the old sessions to bring over, above the list, when there are some", () => {
    const onOpen = vi.fn();
    render(<HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} oldSessions={{ count: 12, onOpen }} />);
    const row = screen.getByRole("button", { name: "12 chats from before you moved this project: Bring them here" });
    expect(row.compareDocumentPosition(screen.getByRole("list", { name: "Past chats" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("uses the singular for one session, and shows no row when there's nothing to bring", () => {
    const { rerender } = render(<HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} oldSessions={{ count: 1, onOpen: () => {} }} />);
    expect(screen.getByRole("button", { name: "1 chat from before you moved this project: Bring them here" })).toBeInTheDocument();
    rerender(<HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} oldSessions={{ count: 0, onOpen: () => {} }} />);
    expect(screen.queryByText(/from before you moved/)).not.toBeInTheDocument();
    rerender(<HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} oldSessions={null} />);
    expect(screen.queryByText(/from before you moved/)).not.toBeInTheDocument();
  });

  it("filters by search text", () => {
    render(<HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Search chats"), { target: { value: "login" } });
    expect(screen.queryByText("Add retries to fetchJson")).toBeNull();
    expect(screen.getByText("Fix the login redirect")).toBeInTheDocument();
  });

  it("shows empty and loading states, and closes on Escape", () => {
    const onClose = vi.fn();
    const { rerender } = render(<HistoryMenu sessions={null} onOpen={() => {}} onClose={onClose} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    rerender(<HistoryMenu sessions={[]} onOpen={() => {}} onClose={onClose} />);
    expect(screen.getByText("No past chats in this folder")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Search chats"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a past session's actions", () => {
  const folder = "/Users/me/My Projects/web";
  const actions = (over: Partial<SessionActions> = {}): SessionActions => ({
    folder,
    pinned: [],
    onTogglePin: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onExport: vi.fn(),
    ...over,
  });
  const menu = (a: SessionActions | null) => (
    <SessionActionsContext.Provider value={a}>
      <HistoryMenu sessions={sessions} onOpen={() => {}} onClose={() => {}} />
    </SessionActionsContext.Provider>
  );
  const openActions = (title: string) => fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));

  it("offers no actions without a folder to act in", () => {
    render(menu(null));
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("pins a session to the top, and says so; unpinning brings it back", () => {
    const a = actions();
    const { rerender } = render(menu(a));
    openActions("Fix the login redirect");
    fireEvent.click(screen.getByRole("button", { name: "Pin to top" }));
    expect(a.onTogglePin).toHaveBeenCalledWith("b");
    rerender(menu(actions({ pinned: ["b"] })));
    const rows = screen.getByRole("list", { name: "Past chats" }).querySelectorAll(".menu-row-title");
    expect([...rows].map((r) => r.textContent)).toEqual(["Fix the login redirect", "Add retries to fetchJson"]);
    expect(screen.getByRole("list", { name: "Past chats" })).toHaveTextContent("Pinned");
    // Its actions are still open from the pin, and now offer to unpin.
    expect(screen.getByRole("button", { name: "Unpin" })).toBeInTheDocument();
  });

  it("renames a session in place: the name typed is saved, and shown", async () => {
    const a = actions();
    render(menu(a));
    openActions("Add retries to fetchJson");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Name for this chat" });
    expect(box).toHaveValue("Add retries to fetchJson");
    fireEvent.change(box, { target: { value: "  Retry work  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(a.onRename).toHaveBeenCalledWith("a", "Retry work");
    expect(await screen.findByText("Retry work")).toBeInTheDocument();
  });

  it("drops a rename on Escape, and won't save an empty name", () => {
    const a = actions();
    render(menu(a));
    openActions("Add retries to fetchJson");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Name for this chat" });
    fireEvent.change(box, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Name for this chat" })).toBeNull();
    expect(a.onRename).not.toHaveBeenCalled();
  });

  it("exports a session, and copies the command that resumes it in a terminal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const a = actions();
    render(menu(a));
    openActions("Add retries to fetchJson");
    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    expect(a.onExport).toHaveBeenCalledWith("a", "Add retries to fetchJson");
    fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
    expect(writeText).toHaveBeenCalledWith("cd '/Users/me/My Projects/web' && claude --resume 'a'");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
