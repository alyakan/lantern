import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StoragePanel } from "./StoragePanel";
import { api } from "../api";
import type { MemorySnapshot, StorageItem, StorageView } from "../types";

vi.mock("../api", () => ({ api: { storageScan: vi.fn(), storageCancel: vi.fn(), storageDelete: vi.fn(), memorySnapshot: vi.fn() } }));

const item = (id: string, over: Partial<StorageItem> = {}): StorageItem => ({
  id, kind: "cache", name: id, path: `/p/${id}`, bytes: 2_000_000_000, risk: "safe", removal: "permanent", note: "regenerates", warning: null, ticked: false, idle_days: 12, within: null, suggestion: null, ...over,
});
const view = (over: Partial<StorageView> = {}): StorageView => ({ items: [], scanning: false, progress: "", scanned_at: Date.now() - 60_000, free_bytes: 8_300_000_000, snapshots: 0, notes: [], deleting: false, ...over });

const memory: MemorySnapshot = {
  total_bytes: 16 * 1024 ** 3, used_bytes: 8 * 1024 ** 3, cached_bytes: 4 * 1024 ** 3, free_bytes: 4 * 1024 ** 3, compressed_bytes: 1024 ** 3, swap_used_bytes: 0, pressure: "normal", pressure_source: "kernel", scaled: false,
  apps: [{ name: "Google Chrome", bytes: 3 * 1024 ** 3, processes: 11, share: 3 / 16, kind: "app" }, { name: "macOS", bytes: 5 * 1024 ** 3, processes: 300, share: 5 / 16, kind: "macos" }],
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.storageScan).mockResolvedValue(true);
  vi.mocked(api.storageDelete).mockResolvedValue([]);
  vi.mocked(api.memorySnapshot).mockReset();
  vi.mocked(api.memorySnapshot).mockResolvedValue(memory);
});

describe("StoragePanel", () => {
  it("draws nothing until it is opened, then a dialog named Storage the size of Settings", () => {
    const { rerender } = render(<StoragePanel open={false} onClose={() => {}} view={view()} onAsk={null} />);
    expect(screen.queryByRole("dialog", { name: "Storage" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Storage" })).toBeNull();
    rerender(<StoragePanel open onClose={() => {}} view={view({ items: [item("a")] })} onAsk={null} />);
    const dialog = screen.getByRole("dialog", { name: "Storage" });
    expect(dialog).toHaveClass("mode-guide");
    expect(within(dialog).getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Caches and logs" })).toBeInTheDocument();
    rerender(<StoragePanel open={false} onClose={() => {}} view={view()} onAsk={null} />);
    expect(screen.queryByRole("dialog", { name: "Storage" })).toBeNull();
  });

  it("closes from its Close button, from a press on the backdrop and from the dialog's own close (Escape), but not from a press inside", () => {
    const onClose = vi.fn();
    render(<StoragePanel open onClose={onClose} view={view({ items: [item("a")] })} onAsk={null} />);
    const dialog = screen.getByRole("dialog", { name: "Storage" });
    fireEvent.click(within(dialog).getByRole("heading", { name: "Storage" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent(dialog, new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps the panel open when Escape answers the delete question, which asks to be cancelled on its own", () => {
    const onClose = vi.fn();
    render(<StoragePanel open onClose={onClose} view={view({ items: [item("a", { ticked: true })] })} onAsk={null} />);
    const dialog = screen.getByRole("dialog", { name: "Storage" });
    // A browser closes a dialog on Escape unless that keydown's default is prevented (fireEvent says false then).
    const escape = (on: Element) => fireEvent.keyDown(on, { key: "Escape" });
    expect(escape(dialog)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete…" }));
    const alert = within(dialog).getByRole("alertdialog");
    expect(alert).toBeInTheDocument();
    expect(escape(alert)).toBe(false);
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    // With the question gone, Escape closes the panel as it does anywhere else.
    expect(escape(dialog)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("scans, asks Claude and deletes with the same safeguards as before: a confirmation first, naming how many go to the Trash", async () => {
    const onAsk = vi.fn();
    render(<StoragePanel open onClose={() => {}} view={view({ items: [item("a", { ticked: true }), item("r", { kind: "repo", removal: "trash", ticked: true, bytes: 1_000_000_000 })] })} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
    expect(onAsk).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(api.storageScan).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(api.storageDelete).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText(/1 will be deleted for good/)).toBeInTheDocument();
    expect(within(confirm).getByText(/1 \(1\.0 GB\) will be moved to the Trash/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(api.storageDelete).toHaveBeenCalledWith(["a", "r"]);
  });

  it("offers the first scan before there is one, and says it while the disk is being looked at", () => {
    const { rerender } = render(<StoragePanel open onClose={() => {}} view={null} onAsk={null} />);
    expect(screen.getByText("Looking at the disk…")).toBeInTheDocument();
    rerender(<StoragePanel open onClose={() => {}} view={view({ scanned_at: null })} onAsk={null} />);
    expect(screen.getByRole("button", { name: "Scan this Mac" })).toBeInTheDocument();
  });

  describe("the Disk and Memory tabs", () => {
    const open = (over: Partial<Parameters<typeof StoragePanel>[0]> = {}) => render(<StoragePanel open onClose={() => {}} view={view({ items: [item("a")] })} onAsk={null} {...over} />);
    const tab = (name: string) => screen.getByRole("tab", { name });

    it("opens on Disk, with a tab list named for what it switches", () => {
      open();
      expect(screen.getByRole("tablist", { name: "Storage view" })).toBeInTheDocument();
      expect(tab("Disk")).toHaveAttribute("aria-selected", "true");
      expect(tab("Memory")).toHaveAttribute("aria-selected", "false");
      expect(screen.getByRole("tabpanel")).toContainElement(screen.getByRole("region", { name: "Caches and logs" }));
      expect(api.memorySnapshot).not.toHaveBeenCalled();
    });

    it("switches to Memory and back, reading memory only while Memory is showing", async () => {
      vi.useFakeTimers();
      try {
        open();
        fireEvent.click(tab("Memory"));
        await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
        expect(tab("Memory")).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByRole("region", { name: "Caches and logs" })).toBeNull();
        expect(screen.getByRole("img", { name: /^Memory by app\./ })).toBeInTheDocument();
        expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
        fireEvent.click(tab("Disk"));
        await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
        expect(screen.getByRole("region", { name: "Caches and logs" })).toBeInTheDocument();
        expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops reading memory when the panel is closed", async () => {
      vi.useFakeTimers();
      try {
        const { rerender } = open();
        fireEvent.click(tab("Memory"));
        await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
        rerender(<StoragePanel open={false} onClose={() => {}} view={view()} onAsk={null} />);
        await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
        expect(api.memorySnapshot).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("remembers the last tab: the panel opens on Memory next time", async () => {
      const first = open();
      fireEvent.click(tab("Memory"));
      expect(localStorage.getItem("lantern.storageTab")).toBe("memory");
      first.unmount();
      open();
      expect(tab("Memory")).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByText("Hover a colour to read it")).toBeInTheDocument();
      fireEvent.click(tab("Disk"));
      expect(localStorage.getItem("lantern.storageTab")).toBe("disk");
    });

    it("moves between the tabs with the arrow keys, keeping only the selected tab in the tab order", async () => {
      open();
      expect(tab("Disk")).toHaveAttribute("tabindex", "0");
      expect(tab("Memory")).toHaveAttribute("tabindex", "-1");
      tab("Disk").focus();
      fireEvent.keyDown(tab("Disk"), { key: "ArrowRight" });
      expect(tab("Memory")).toHaveAttribute("aria-selected", "true");
      expect(tab("Memory")).toHaveFocus();
      fireEvent.keyDown(tab("Memory"), { key: "ArrowLeft" });
      expect(tab("Disk")).toHaveAttribute("aria-selected", "true");
      expect(tab("Disk")).toHaveFocus();
    });
  });
});
