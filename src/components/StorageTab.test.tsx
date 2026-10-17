import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StorageTab, suggestedCount } from "./StorageTab";
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

const GB = 1_000_000_000;
// A spread of the kinds: 50 / 30 / 15 / 5 percent of 20 GB.
const spread = [
  item("wt", { kind: "worktree", removal: "worktree", name: "app/wt-1", bytes: 10 * GB }),
  item("nm", { kind: "build_output", name: "web/node_modules", bytes: 6 * GB, ticked: true }),
  item("c", { kind: "cache", name: "Xcode DerivedData", bytes: 3 * GB }),
  item("t", { kind: "trash", name: "Trash", bytes: 1 * GB, ticked: true }),
];

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
    expect(screen.getByText(/Total scanned 6\.0 GB, selected to delete 4\.0 GB \(frees 4\.0 GB\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 ticked/)).toBeInTheDocument();
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

  describe("the distribution bar", () => {
    const seg = (kind: string) => document.querySelector(`.storage-seg[data-kind="${kind}"]`) as HTMLElement;

    it("splits the whole scan by kind, each with its own colour, and says it in words too", () => {
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      const bar = screen.getByRole("img", { name: /^Storage by kind\./ });
      expect(bar).toHaveAccessibleName("Storage by kind. Git worktrees: 10.0 GB (50%). Build output: 6.0 GB (30%). Caches and logs: 3.0 GB (15%). Trash: 1.0 GB (5%)");
      expect([...document.querySelectorAll(".storage-seg")].map((e) => (e as HTMLElement).dataset.kind)).toEqual(["worktree", "build_output", "cache", "trash"]);
      expect(seg("worktree").style.getPropertyValue("--kind")).toBe("var(--storage-1)");
      expect(seg("build_output").style.getPropertyValue("--kind")).toBe("var(--storage-3)");
      expect(seg("trash").style.getPropertyValue("--kind")).toBe("var(--storage-7)");
      expect(parseFloat(seg("worktree").style.width)).toBeCloseTo(50, 5);
      expect(parseFloat(seg("trash").style.width)).toBeCloseTo(5, 5);
    });

    it("has a legend with a swatch, the kind, its size and its share", () => {
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      const legend = screen.getByRole("list", { name: "Storage kinds" });
      const entry = within(legend).getByRole("button", { name: /Build output/ });
      expect(entry).toHaveTextContent("Build output6.0 GB30%");
      expect(entry.querySelector(".storage-swatch")).not.toBeNull();
      expect(within(legend).getAllByRole("button")).toHaveLength(4);
    });

    it("reads a kind out when the pointer or the keyboard is on its segment or its legend entry, and dims the others", () => {
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      expect(screen.getByText(/Hover a colour/)).toBeInTheDocument();
      fireEvent.pointerEnter(seg("build_output"));
      expect(screen.getByText("Build output: 6.0 GB (30%)")).toBeInTheDocument();
      expect(seg("build_output")).toHaveClass("hot");
      expect(seg("cache")).toHaveClass("dim");
      expect(screen.getByRole("region", { name: "Build output" })).toHaveClass("hot");
      fireEvent.pointerLeave(document.querySelector(".storage-chart")!);
      expect(screen.getByText(/Hover a colour/)).toBeInTheDocument();
      expect(seg("cache")).not.toHaveClass("dim");
      act(() => screen.getByRole("button", { name: /Caches and logs/ }).focus());
      expect(screen.getByText("Caches and logs: 3.0 GB (15%)")).toBeInTheDocument();
      expect(seg("cache")).toHaveClass("hot");
      act(() => screen.getByRole("button", { name: /Caches and logs/ }).blur());
      expect(screen.getByText(/Hover a colour/)).toBeInTheDocument();
    });

    it("goes to the kind's list when its segment or legend entry is pressed", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      fireEvent.click(seg("cache"));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("region", { name: "Caches and logs" }));
      fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
      expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole("region", { name: "Trash" }));
      // The group stays in the list whether or not anything scrolls (jsdom has no scrollIntoView).
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      fireEvent.click(seg("cache"));
    });

    it("gives a kind that is a hair of the scan a segment you can still see, and no bar when nothing was found", () => {
      const { unmount } = render(<StorageTab view={view({ items: [item("big", { kind: "worktree", removal: "worktree", bytes: 900 * GB }), item("t", { kind: "trash", bytes: 1_000_000 })] })} onAsk={null} />);
      expect(parseFloat(seg("trash").style.width)).toBe(2);
      expect(screen.getByRole("button", { name: /Trash/ })).toHaveTextContent("<1%");
      unmount();
      render(<StorageTab view={view({ items: [] })} onAsk={null} />);
      expect(screen.queryByRole("img", { name: /Storage by kind/ })).toBeNull();
    });
  });

  describe("each item's own bar", () => {
    const fill = (name: string) => screen.getByRole("checkbox", { name: `Delete ${name}` }).closest("li")!.querySelector(".storage-rowbar span") as HTMLElement;

    it("is sized against the biggest item of the scan and tinted with its kind's colour", () => {
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      expect(fill("app/wt-1").style.width).toBe("100%");
      expect(fill("web/node_modules").style.width).toBe("60%");
      expect(fill("Xcode DerivedData").style.width).toBe("30%");
      expect(fill("Trash").style.width).toBe("10%");
      expect(screen.getByRole("region", { name: "Build output" }).style.getPropertyValue("--kind")).toBe("var(--storage-3)");
    });

    it("is hidden from a screen reader, which reads the size beside it, and is stronger on a ticked row", () => {
      render(<StorageTab view={view({ items: spread })} onAsk={null} />);
      const row = screen.getByRole("checkbox", { name: "Delete web/node_modules" }).closest("li")!;
      expect(row.querySelector(".storage-rowbar")).toHaveAttribute("aria-hidden", "true");
      expect(within(row).getByText("6.0 GB")).toBeInTheDocument();
      expect(row).toHaveClass("ticked");
      expect(screen.getByRole("checkbox", { name: "Delete app/wt-1" }).closest("li")).not.toHaveClass("ticked");
    });
  });

  it("totals the scan from what is not inside another item, and says what is selected and what goes to the Trash first", () => {
    const items = [
      item("wt", { kind: "worktree", removal: "worktree", bytes: 10 * GB }),
      item("inner", { kind: "build_output", bytes: 4 * GB, within: "wt" }),
      item("r", { kind: "repo", removal: "trash", bytes: 3 * GB, ticked: true }),
      item("c", { kind: "cache", bytes: 2 * GB, ticked: true }),
    ];
    render(<StorageTab view={view({ items })} onAsk={null} />);
    expect(screen.getByText(/Total scanned 15\.0 GB, selected to delete 5\.0 GB \(frees 2\.0 GB; 3\.0 GB goes to Trash first\)/)).toBeInTheDocument();
  });

  it("counts what Claude suggested for the title bar's dot", () => {
    expect(suggestedCount(null)).toBe(0);
    expect(suggestedCount(view({ items: [item("a"), item("b", { suggestion: "idle" }), item("c", { suggestion: "old" })] }))).toBe(2);
  });
});
