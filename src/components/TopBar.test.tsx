import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TopBar } from "./TopBar";

const base = { folder: null, status: "idle" as const, changeCount: 0, onOpenFolder: () => {} };

describe("TopBar", () => {
  it("can reopen a collapsed review panel, even before a folder is open", () => {
    const onToggleReview = vi.fn();
    render(<TopBar {...base} reviewCollapsed onToggleReview={onToggleReview} />);
    const toggle = screen.getByRole("button", { name: "Show side panel" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onToggleReview).toHaveBeenCalled();
  });

  it("shows the folder, branch and status like Xcode's activity viewer, with a progress bar while working", () => {
    const { rerender } = render(<TopBar {...base} folder="/work/acme-api" branch="main" reviewCollapsed={false} onToggleReview={() => {}} activity={{ text: "Working", detail: null, working: true }} />);
    expect(screen.getByRole("button", { name: /acme-api/ })).toHaveTextContent("acme-apimain");
    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(document.querySelector(".viewer-progress")).not.toBeNull();
    rerender(<TopBar {...base} folder="/work/acme-api" branch="main" reviewCollapsed={false} onToggleReview={() => {}} activity={{ text: "Done", detail: "Today at 7:22 PM", working: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Done | Today at 7:22 PM");
    expect(document.querySelector(".viewer-progress")).toBeNull();
  });

  it("puts a warning dot on the Settings gear while an MCP server is down, and says which", () => {
    const { rerender } = render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByRole("button", { name: "Settings" }).querySelector(".dot")).toBeNull();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenSettings={() => {}} mcpIssues={["sentry needs you to log in", "postgres couldn't connect"]} />);
    const gear = screen.getByRole("button", { name: "Settings, sentry needs you to log in, postgres couldn't connect" });
    expect(gear.querySelector(".dot.warn")).not.toBeNull();
    expect(gear).toHaveAttribute("title", "Settings (⌘,): sentry needs you to log in · postgres couldn't connect");
  });

  it("counts failed steps in the viewer, and the count shows the failure; there is no waiting badge (the sidebar has it)", () => {
    const onShowFailure = vi.fn();
    const { rerender } = render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 0 }} />);
    expect(screen.queryByTitle(/failed/)).toBeNull();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 2 }} onShowFailure={onShowFailure} />);
    expect(screen.queryByTitle(/waiting for you/)).toBeNull();
    fireEvent.click(screen.getByTitle(/2 steps failed/));
    expect(onShowFailure).toHaveBeenCalled();
    const onClearFailures = vi.fn();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} issues={{ failed: 2 }} onClearFailures={onClearFailures} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear failures" }));
    expect(onClearFailures).toHaveBeenCalled();
  });

  it("is slimmer: no History clock, New chat or Start a team buttons (the sidebar has them)", () => {
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenSettings={() => {}} orchestra={{ view: "chat", exists: false, attention: 0, onView: () => {} }} />);
    expect(screen.queryByRole("button", { name: "Chat history" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start a team" })).toBeNull();
    // What stays: the folder and branch, Settings and the side panel.
    expect(screen.getByRole("button", { name: /^p$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
  });

  it("has a Show sidebar button only while the sidebar is hidden, badged with how many chats need you", () => {
    const onShow = vi.fn();
    const { rerender } = render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Show sidebar/ })).toBeNull();
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} sidebar={{ needs: 0, onShow }} />);
    const plain = screen.getByRole("button", { name: "Show sidebar" });
    expect(plain).toHaveTextContent("");
    fireEvent.click(plain);
    expect(onShow).toHaveBeenCalledTimes(1);
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} sidebar={{ needs: 1, onShow }} />);
    expect(screen.getByRole("button", { name: "Show sidebar, 1 chat needs you" })).toHaveTextContent("1");
    rerender(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} sidebar={{ needs: 2, onShow }} />);
    expect(screen.getByRole("button", { name: "Show sidebar, 2 chats need you" })).toHaveTextContent("2");
  });

  it("opens a folder menu without the Recent list: Open folder… and Bring old chats here…", () => {
    const onOpenFolder = vi.fn();
    const onBringOld = vi.fn();
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenFolder={onOpenFolder} onBringOld={onBringOld} />);
    fireEvent.click(screen.getByRole("button", { name: /^p$/ }));
    const menu = screen.getByRole("menu", { name: "Folders" });
    expect(menu).not.toHaveTextContent("Recent");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open folder…", "Bring old chats here…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Bring old chats here…" }));
    expect(onBringOld).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Folders" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^p$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open folder…" }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("with no folder, the folder button opens the folder dialog straight away", () => {
    const onOpenFolder = vi.fn();
    render(<TopBar {...base} reviewCollapsed={false} onToggleReview={() => {}} onOpenFolder={onOpenFolder} />);
    fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves through the menu with the arrow keys, and gives focus back to the folder button", () => {
    render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onBringOld={() => {}} />);
    const pill = screen.getByRole("button", { name: /^p$/ });
    fireEvent.click(pill);
    const first = screen.getByRole("menuitem", { name: "Open folder…" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Bring old chats here…" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Bring old chats here…" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Folders" })).toBeNull();
    expect(pill).toHaveFocus();
  });

  it("has ⌘O, which is off while a chat is starting (⌘N and ⌘K are the app's now)", () => {
    const onOpenFolder = vi.fn();
    const props = { ...base, folder: "/p", reviewCollapsed: false, onToggleReview: () => {}, onOpenFolder };
    const { rerender } = render(<TopBar {...props} />);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    expect(onOpenFolder).toHaveBeenCalledOnce();
    rerender(<TopBar {...props} status="starting" />);
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    expect(onOpenFolder).toHaveBeenCalledOnce();
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

  it("brings Stop back for a task that's still listed a while after it was asked to stop", async () => {
    vi.useFakeTimers();
    try {
      const background = [{ id: "b1", taskType: "local_bash", description: "npm run dev", since: Date.now() }];
      const onStopTask = vi.fn().mockResolvedValue(undefined);
      render(<TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} background={background} onStopTask={onStopTask} />);
      fireEvent.click(screen.getByRole("button", { name: "1 running in the background" }));
      fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Stop npm run dev" })).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(screen.getByRole("button", { name: "Stop npm run dev" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Stop npm run dev" })).toHaveTextContent("Stop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("has a canvas toggle that is always called Canvas, says whether it is on, and counts the agents that need you", () => {
    const onView = vi.fn();
    const orchestra = { view: "chat" as const, exists: true, attention: 0, onView };
    const { rerender } = render(<TopBar {...base} reviewCollapsed={false} onToggleReview={() => {}} orchestra={orchestra} />);
    const toggle = screen.getByRole("button", { name: "Canvas" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onView).toHaveBeenCalledWith("canvas");
    rerender(<TopBar {...base} reviewCollapsed={false} onToggleReview={() => {}} orchestra={{ ...orchestra, attention: 2 }} />);
    expect(screen.getByRole("button", { name: "Canvas, 2 agents need you" })).toBeInTheDocument();
    rerender(<TopBar {...base} reviewCollapsed={false} onToggleReview={() => {}} orchestra={{ ...orchestra, view: "canvas", attention: 1 }} />);
    const on = screen.getByRole("button", { name: "Canvas, 1 agent needs you" });
    expect(on).toHaveAttribute("aria-pressed", "true");
  });

  it("hides an open review panel", () => {
    const onToggleReview = vi.fn();
    render(<TopBar {...base} reviewCollapsed={false} onToggleReview={onToggleReview} />);
    const toggle = screen.getByRole("button", { name: "Hide side panel" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(onToggleReview).toHaveBeenCalled();
  });
});

describe("TopBar's Storage button", () => {
  const bar = (storage?: { onOpen: () => void; suggested: number; open?: boolean }) => <TopBar {...base} folder="/p" reviewCollapsed={false} onToggleReview={() => {}} onOpenSettings={() => {}} storage={storage} />;

  it("opens the Storage panel, sits just before the Settings gear, and can be reached by keyboard", () => {
    const onOpen = vi.fn();
    render(bar({ onOpen, suggested: 0 }));
    const button = screen.getByRole("button", { name: "Storage" });
    expect(button).toHaveAttribute("title", "Storage");
    expect(button.nextElementSibling).toBe(screen.getByRole("button", { name: "Settings" }));
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });

  it("wears a dot, and says how many deletions Claude suggested, only when it suggested some", () => {
    const { rerender } = render(bar({ onOpen: () => {}, suggested: 0 }));
    expect(screen.getByRole("button", { name: "Storage" }).querySelector(".dot")).toBeNull();
    rerender(bar({ onOpen: () => {}, suggested: 1 }));
    expect(screen.getByRole("button", { name: "Storage, Claude suggested 1 deletion" }).querySelector(".dot")).not.toBeNull();
    rerender(bar({ onOpen: () => {}, suggested: 3 }));
    expect(screen.getByRole("button", { name: "Storage, Claude suggested 3 deletions" })).toHaveAttribute("title", "Storage: Claude suggested 3 deletions");
  });

  it("says whether its panel is open", () => {
    const { rerender } = render(bar({ onOpen: () => {}, suggested: 0, open: false }));
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-expanded", "false");
    rerender(bar({ onOpen: () => {}, suggested: 0, open: true }));
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-expanded", "true");
  });

  it("isn't there when the app gives it nothing to open", () => {
    render(bar(undefined));
    expect(screen.queryByRole("button", { name: /^Storage/ })).toBeNull();
  });
});
