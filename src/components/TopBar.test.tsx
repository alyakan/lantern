import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopBar } from "./TopBar";

const base = { folder: null, status: "idle" as const, changeCount: 0, onOpenFolder: () => {} };

describe("TopBar", () => {
  it("can reopen a collapsed review panel, even before a folder is open", () => {
    const onToggleReview = vi.fn();
    render(<TopBar {...base} reviewCollapsed onToggleReview={onToggleReview} />);
    const toggle = screen.getByRole("button", { name: "Show changes" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onToggleReview).toHaveBeenCalled();
  });

  it("shows the folder, branch and status like Xcode's activity viewer, with a progress bar while working", () => {
    const { rerender } = render(<TopBar {...base} folder="/work/acme-api" branch="main" reviewCollapsed={false} onToggleReview={() => {}} activity={{ text: "Claude is working", detail: null, working: true }} />);
    expect(screen.getByRole("button", { name: /acme-api/ })).toHaveTextContent("acme-apimain");
    expect(screen.getByRole("status")).toHaveTextContent("Claude is working");
    expect(document.querySelector(".viewer-progress")).not.toBeNull();
    rerender(<TopBar {...base} folder="/work/acme-api" branch="main" reviewCollapsed={false} onToggleReview={() => {}} activity={{ text: "Finished", detail: "Today at 7:22 PM", working: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Finished | Today at 7:22 PM");
    expect(document.querySelector(".viewer-progress")).toBeNull();
  });

  it("counts failed steps and waiting chats in the viewer; the failure count shows the failure", () => {
    const onShowFailure = vi.fn();
    const { rerender } = render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 0, waiting: 0 }} />);
    expect(screen.queryByTitle(/failed/)).toBeNull();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 2, waiting: 1 }} onShowFailure={onShowFailure} />);
    expect(screen.getByTitle("1 other chat is waiting for you")).toHaveTextContent("1");
    fireEvent.click(screen.getByTitle(/2 steps failed/));
    expect(onShowFailure).toHaveBeenCalled();
    const onClearFailures = vi.fn();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 2, waiting: 0 }} onClearFailures={onClearFailures} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear failures" }));
    expect(onClearFailures).toHaveBeenCalled();
  });

  it("loads past sessions into the history menu and opens a pick", async () => {
    const onOpenSession = vi.fn();
    const loadSessions = vi.fn().mockResolvedValue([{ id: "s1", title: "Fix the login redirect", updated_ms: Date.now(), prompts: 2 }]);
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} loadSessions={loadSessions} onOpenSession={onOpenSession} onNewSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    fireEvent.click(await screen.findByText("Fix the login redirect"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("dialog", { name: "Session history" })).toBeNull();
  });

  it("opens the recent-folders menu from the folder pill, one menu at a time", async () => {
    const onPickFolder = vi.fn();
    const onOpenFolder = vi.fn();
    const loadRecent = async () => [{ path: "/p", updated_ms: 2 }, { path: "/work/web", updated_ms: 1 }];
    render(
      <TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenFolder={onOpenFolder} loadRecent={loadRecent} onPickFolder={onPickFolder}
        loadSessions={async () => []} onOpenSession={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^p$/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /web/ }));
    expect(onPickFolder).toHaveBeenCalledWith("/work/web");
    expect(screen.queryByRole("menu", { name: "Folders" })).toBeNull();

    // Opening history closes the folder menu, and "Open folder…" still reaches the dialog.
    fireEvent.click(screen.getByRole("button", { name: /^p$/ }));
    await screen.findByRole("menu", { name: "Folders" });
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.queryByRole("menu", { name: "Folders" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^p$/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open folder…" }));
    expect(onOpenFolder).toHaveBeenCalled();
  });

  it("has ⌘N, ⌘K and ⌘O, which are off while a chat is starting", async () => {
    const cmd = (key: string) => fireEvent.keyDown(window, { key, metaKey: true });
    const onNewSession = vi.fn();
    const onOpenFolder = vi.fn();
    const props = { ...base, folder: "/p", reviewCollapsed: false, onToggleReview: () => {}, onOpenFolder, onNewSession, loadSessions: async () => [], onOpenSession: () => {} };
    const { rerender } = render(<TopBar {...props} />);
    cmd("n");
    expect(onNewSession).toHaveBeenCalledOnce();
    cmd("k");
    expect(await screen.findByRole("dialog", { name: "Session history" })).toBeInTheDocument();
    cmd("o");
    expect(onOpenFolder).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Session history" })).toBeNull();

    rerender(<TopBar {...props} status="starting" />);
    cmd("n");
    cmd("o");
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onOpenFolder).toHaveBeenCalledOnce();
    // A plain letter, or ⌘ with another modifier, is not a shortcut.
    rerender(<TopBar {...props} />);
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it("keeps new session and history available while Claude works, so you can switch away", () => {
    const props = { ...base, folder: "/p", reviewCollapsed: false, onToggleReview: () => {}, loadSessions: async () => [], onOpenSession: () => {}, onNewSession: () => {} };
    const { rerender } = render(<TopBar {...props} status="running" />);
    expect(screen.getByRole("button", { name: "Session history" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "New session" })).toBeEnabled();
    rerender(<TopBar {...props} status="starting" />);
    expect(screen.getByRole("button", { name: "Session history" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New session" })).toBeDisabled();
  });

  it("lists chats open in the background and switches to one", async () => {
    const onSwitchChat = vi.fn();
    const onOpenSession = vi.fn();
    const loadSessions = async () => [
      { id: "abc", title: "Add retries", updated_ms: Date.now(), prompts: 1 },
      { id: "old", title: "Older work", updated_ms: Date.now() - 86_400_000, prompts: 3 },
    ];
    const openChats = [{ slot: "s2", title: "Add retries", state: "running" as const, sessionId: "abc", elsewhere: null }];
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} loadSessions={loadSessions} onOpenSession={onOpenSession} openChats={openChats} onSwitchChat={onSwitchChat} />);
    const history = screen.getByRole("button", { name: "Session history" });
    expect(history.querySelector(".dot")).not.toBeNull();
    fireEvent.click(history);
    const open = await screen.findByRole("listbox", { name: "Open chats" });
    expect(open).toHaveTextContent("Add retriesRunning");
    // The same session isn't listed again under past sessions.
    expect(await screen.findByRole("listbox", { name: "Past sessions" })).not.toHaveTextContent("Add retries");
    fireEvent.click(screen.getByRole("button", { name: /Add retries/ }));
    expect(onSwitchChat).toHaveBeenCalledWith("s2");
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("shows a blue dot for a chat that finished in the background until it's opened", async () => {
    const props = { ...base, folder: "/p", reviewCollapsed: false, onToggleReview: () => {}, loadSessions: async () => [], onOpenSession: () => {} };
    const chat = { slot: "s2", title: "Add retries", state: "done" as const, sessionId: "abc", elsewhere: null };
    const { rerender } = render(<TopBar {...props} openChats={[{ ...chat, unread: true }]} />);
    const history = screen.getByRole("button", { name: "Session history" });
    expect(history.querySelector(".dot.unread")).not.toBeNull();
    fireEvent.click(history);
    expect(await screen.findByLabelText("Unread")).toBeInTheDocument();
    // Seen: no dot at all, since nothing runs.
    rerender(<TopBar {...props} openChats={[chat]} />);
    expect(history.querySelector(".dot")).toBeNull();
    expect(screen.queryByLabelText("Unread")).toBeNull();
    // Running elsewhere stays orange.
    rerender(<TopBar {...props} openChats={[{ ...chat, state: "running" }]} />);
    expect(history.querySelector(".dot:not(.unread)")).not.toBeNull();
  });

  it("counts what still runs in the background and lists it", () => {
    const background = [
      { id: "b1", taskType: "local_bash", description: "npm run dev", since: Date.now() - 125_000 },
      { id: "a2", taskType: "local_agent", description: "Search the docs", since: Date.now() - 5_000 },
    ];
    const { rerender } = render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} background={background} />);
    fireEvent.click(screen.getByRole("button", { name: "2 running in the background" }));
    const list = screen.getByRole("dialog", { name: "Background tasks" });
    expect(list).toHaveTextContent("Commandnpm run dev2m");
    expect(list).toHaveTextContent("AgentSearch the docs5s");
    // When they've all ended, the count and the list go.
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} background={[]} />);
    expect(screen.queryByRole("button", { name: /in the background/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Background tasks" })).toBeNull();
  });

  it("stops one background task, and says so when it can't", async () => {
    const background = [{ id: "b1", taskType: "local_bash", description: "npm run dev", since: Date.now() }];
    const onStopTask = vi.fn().mockRejectedValueOnce("Claude isn't running.").mockResolvedValue(undefined);
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} background={background} onStopTask={onStopTask} />);
    fireEvent.click(screen.getByRole("button", { name: "1 running in the background" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    expect(onStopTask).toHaveBeenCalledWith("b1");
    expect(await screen.findByText("Couldn't stop it: Claude isn't running.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    expect(screen.getByRole("button", { name: "Stop npm run dev" })).toHaveTextContent("Stopping…");
  });

  it("hides an open review panel", () => {
    const onToggleReview = vi.fn();
    render(<TopBar {...base} reviewCollapsed={false} onToggleReview={onToggleReview} />);
    const toggle = screen.getByRole("button", { name: "Hide changes" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onToggleReview).toHaveBeenCalled();
  });
});
