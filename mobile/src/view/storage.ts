/** What the Mac's storage sheet says: sizes in the Mac's own way, how full the disk is, and how fresh the scan is. */
import type { RemoteStorage } from "../protocol/generated/RemoteStorage";
import type { RemoteStorageItem } from "../protocol/generated/RemoteStorageItem";

/** A size as Finder writes it (powers of ten): "840 MB", "12.3 GB". */
export function bytesText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** How full the disk is, 0 to 1; null when the Mac didn't say. */
export function usedShare(storage: Pick<RemoteStorage, "free_bytes" | "total_bytes">): number | null {
  const { free_bytes: free, total_bytes: total } = storage;
  if (free === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, (total - free) / total));
}

/** The bar's colour: calm until the disk is nearly full (a disk that is 80% full is ordinary, so not yellow yet). */
export function diskTone(used: number | null): "ok" | "warn" | "stop" {
  if (used === null) return "ok";
  return used >= 0.95 ? "stop" : used >= 0.9 ? "warn" : "ok";
}

/** How long ago the scan finished, in a few words; the Mac refuses to clear from a scan older than an hour. */
export const SCAN_FRESH_MS = 60 * 60 * 1000;

export function scanState(scannedAt: number | null, now: number): { fresh: boolean; text: string } {
  if (scannedAt === null) return { fresh: false, text: "Not scanned yet" };
  const minutes = Math.max(0, Math.round((now - scannedAt) / 60_000));
  const text = minutes < 1 ? "Scanned just now" : minutes < 60 ? `Scanned ${minutes} min ago` : `Scanned ${Math.round(minutes / 60)} h ago`;
  return { fresh: now - scannedAt <= SCAN_FRESH_MS, text };
}

/** What clearing these would free, and how much of it only moves to the Trash (which frees nothing until it is emptied). */
export function clearTotals(items: RemoteStorageItem[]): { count: number; bytes: number; trashBytes: number } {
  let bytes = 0;
  let trashBytes = 0;
  for (const i of items) {
    bytes += i.bytes;
    if (i.to_trash) trashBytes += i.bytes;
  }
  return { count: items.length, bytes, trashBytes };
}

/** The kind of an item in plain words. */
export function kindText(kind: string): string {
  switch (kind) {
    case "worktree":
      return "Worktree";
    case "build_output":
      return "Build output";
    case "cache":
      return "Cache";
    case "simulator":
      return "Simulator";
    default:
      return "Item";
  }
}
