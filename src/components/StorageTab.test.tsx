import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StorageTab } from "./StorageTab";
import { api } from "../api";
import type { StorageItem, StorageView } from "../types";

vi.mock("../api", () => ({ api: { storageScan: vi.fn(), storageCancel: vi.fn(), storageDelete: vi.fn() } }));

const item = (id: string, over: Partial<StorageItem> = {}): StorageItem => ({
  id, kind: "cache", name: id, path: `/p/${id}`, bytes: 2_000_000_000, risk: "safe", removal: "permanent", note: "regenerates", warning: null, ticked: false, idle_days: 12, within: null, suggestion: null, ...over,
});
const view = (over: Partial<StorageView> = {}): StorageView => ({ items: [], scanning: false, progress: "", scanned_at: Date.now() - 60_000, free_bytes: 8_300_000_000, snapshots: 0, notes: [], deleting: false, ...over });

beforeEach(() => {
  vi.mocked(api.storageScan).mockResolvedValue(true);
  vi.mocked(api.storageDelete).mockResolvedValue([]);
});

describe("StorageTab", () => {
  it("offers a first scan, and says nothing is deleted until you tick it", () => {
    render(<StorageTab view={view({ scanned_at: null })} onAsk={null} />);
    expect(screen.getByText(/8\.3 GB free/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted until you tick it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan this Mac" }));
    expect(api.storageScan).toHaveBeenCalled();
  });

  it("lists items by group with what the scan ticked, Claude's reason, and a blocked one that can't be ticked", () => {
    const items = [
      item("wt", { kind: "worktree", removal: "worktree", name: "app/wt-1", ticked: true }),
      item("busy", { kind: "worktree", removal: "worktree", risk: "blocked", warning: "2 uncommitted changes that exist nowhere else." }),
      item("nm", { kind: "build_output", name: "web/node_modules", suggestion: "old project, 40 days idle" }),
    ];
    render(<StorageTab view={view({ items })} onAsk={null} />);
    expect(screen.getByRole("region", { name: "Git worktrees" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Build output" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Delete app/wt-1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Delete web/node_modules" })).toBeChecked();
    expect(screen.getByText("Claude: old project, 40 days idle")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Delete busy" })).toBeDisabled();
    expect(screen.getByText(/Can't be deleted: 2 uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText(/2 ticked · frees up to 4\.0 GB/)).toBeInTheDocument();
  });

  it("deletes the ticked ids after a confirmation, and says what was freed and what was refused", async () => {
    const items = [item("a", { ticked: true }), item("b"), item("r", { kind: "repo", removal: "trash", ticked: true, bytes: 1_000_000_000 })];
    vi.mocked(api.storageDelete).mockResolvedValue([
      { id: "a", name: "a", ok: true, freed: 2_000_000_000, error: null },
      { id: "r", name: "r", ok: false, freed: 0, error: "It has stashed changes." },
    ]);
    render(<StorageTab view={view({ items })} onAsk={null} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete b" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete a" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/1 will be deleted for good/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 \(1\.0 GB\) will be moved to the Trash/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.storageDelete).toHaveBeenCalledWith(["b", "r"]));
    expect(await screen.findByText("Freed 2.0 GB.")).toBeInTheDocument();
    expect(screen.getByText("r: It has stashed changes.")).toBeInTheDocument();
  });

  it("names, in the confirmation, what Claude suggested and what needs a judgement, but not plain regenerable files", () => {
    const items = [
      item("plain", { ticked: true }),
      item("rt", { kind: "simulator", name: "iOS 16.4 simulator runtime", risk: "review", warning: "Last used 50 day(s) ago; downloading it again takes a while." }),
      item("pick", { name: "web/node_modules", suggestion: "idle 40 days" }),
    ];
    render(<StorageTab view={view({ items })} onAsk={null} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete iOS 16.4 simulator runtime" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Look at these first/)).toBeInTheDocument();
    expect(within(dialog).getByText("iOS 16.4 simulator runtime")).toBeInTheDocument();
    expect(within(dialog).getByText("web/node_modules")).toBeInTheDocument();
    expect(within(dialog).queryByText("plain")).toBeNull();
  });

  it("keeps the user's choices over what the scan ticked, and Claude's picks tick only those", () => {
    const items = [item("a", { ticked: true }), item("b", { suggestion: "idle" })];
    render(<StorageTab view={view({ items })} onAsk={null} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete a" }));
    expect(screen.getByRole("checkbox", { name: "Delete a" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Claude's picks \(1\)/ }));
    expect(screen.getByRole("checkbox", { name: "Delete b" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Delete a" })).not.toBeChecked();
  });

  it("explains local snapshots, and Ask Claude waits while a turn is running", () => {
    const onAsk = vi.fn();
    const { rerender } = render(<StorageTab view={view({ snapshots: 2, items: [item("a")] })} onAsk={onAsk} />);
    expect(screen.getByText(/2 local Time Machine snapshots exist/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(onAsk).toHaveBeenCalled();
    rerender(<StorageTab view={view({ items: [item("a")] })} onAsk={onAsk} busy />);
    expect(screen.getByRole("button", { name: "Ask Claude" })).toBeDisabled();
  });

  it("shows scan progress and offers Stop instead of Rescan while it runs", () => {
    render(<StorageTab view={view({ scanning: true, progress: "Measured 10 of 40 places", items: [item("a")] })} onAsk={null} />);
    expect(screen.getByText("Measured 10 of 40 places")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rescan" })).toBeNull();
  });
});
