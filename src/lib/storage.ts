import type { StorageItem, StorageKind, StorageOutcome } from "../types";

/** Sizes as the backend writes them (decimal, like Finder): "12.3 GB". */
export function sizeText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  // Round first, so a value that would print as "1000.0 KB" rolls over to "1.0 MB".
  const shown = (v: number, u: number) => (u === 0 ? Math.round(v) : Number(v.toFixed(1)));
  while (shown(value, unit) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The groups the tab lists, in this order: what is usually biggest and safest to clear first. */
export const GROUPS: { kind: StorageKind; title: string; hint: string }[] = [
  { kind: "worktree", title: "Git worktrees", hint: "Removed through git; the branch stays in its repository" },
  { kind: "repo", title: "Stale projects", hint: "Nothing changed in 60 days and everything is pushed; they go to the Trash" },
  { kind: "build_output", title: "Build output", hint: "node_modules, target and the like: they come back with a build or install" },
  { kind: "simulator", title: "Simulators", hint: "Runtimes and devices Xcode can download or make again" },
  { kind: "archive", title: "Xcode archives", hint: "One per upload to App Store Connect; each keeps that build's debug symbols" },
  { kind: "cache", title: "Caches and logs", hint: "Apps and package managers make them again" },
  { kind: "temp", title: "Temporary folder", hint: "Chrome's leftover copies of itself, app caches, and what builds, downloads and Claude sessions left in /tmp" },
  { kind: "download", title: "Downloads", hint: "Yours: they go to the Trash" },
  { kind: "trash", title: "Trash", hint: "Deleting these gives the space back" },
];

/** Whether the item is ticked: what the user chose, else what the scan or Claude ticked. A blocked item never is. */
export function isTicked(item: StorageItem, touched: ReadonlyMap<string, boolean>): boolean {
  if (item.risk === "blocked") return false;
  return touched.get(item.id) ?? (item.ticked || item.suggestion !== null);
}

export interface Selection {
  ids: string[];
  /** What deleting them frees at most, counting what sits inside a ticked worktree or project only once. */
  bytes: number;
  /** What of that goes to the Trash instead, which frees nothing until the Trash is emptied. */
  toTrashBytes: number;
  /** What of that may be shared with something that stays (an APFS copy of an app), so it may free less. */
  sharedBytes: number;
  permanent: number;
  toTrash: number;
}

export function selection(items: StorageItem[], touched: ReadonlyMap<string, boolean>): Selection {
  const ticked = items.filter((i) => isTicked(i, touched));
  const holders = new Set(ticked.map((i) => i.id));
  const sel: Selection = { ids: ticked.map((i) => i.id), bytes: 0, toTrashBytes: 0, sharedBytes: 0, permanent: 0, toTrash: 0 };
  for (const i of ticked) {
    if (i.removal === "trash") {
      sel.toTrash++;
      sel.toTrashBytes += i.bytes;
    } else sel.permanent++;
    if (i.within && holders.has(i.within)) continue;
    sel.bytes += i.bytes;
    if (i.shared) sel.sharedBytes += i.bytes;
  }
  return sel;
}

/** The items of one kind, with their total (inside-another-item ones left out of it). */
export function groupOf(items: StorageItem[], kind: StorageKind): { items: StorageItem[]; bytes: number } {
  const own = items.filter((i) => i.kind === kind);
  return { items: own, bytes: own.filter((i) => !i.within).reduce((n, i) => n + i.bytes, 0) };
}

/** "3 days", "today": how long ago something changed. */
export function idleText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "changed today";
  if (days < 60) return `idle ${days} day${days === 1 ? "" : "s"}`;
  if (days < 730) return `idle ${Math.round(days / 30)} months`;
  return `idle ${Math.round(days / 365)} years`;
}

/** What a finished delete says: what was freed, what went to the Trash, and what was refused and why. */
export function outcomeText(outcomes: StorageOutcome[], items: StorageItem[]): { text: string; failures: { name: string; error: string }[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const done = outcomes.filter((o) => o.ok);
  const freed = done.filter((o) => byId.get(o.id)?.removal !== "trash").reduce((n, o) => n + o.freed, 0);
  const trashed = done.filter((o) => byId.get(o.id)?.removal === "trash").reduce((n, o) => n + o.freed, 0);
  const parts: string[] = [];
  if (freed > 0) parts.push(`Freed ${sizeText(freed)}.`);
  if (trashed > 0) parts.push(`${sizeText(trashed)} went to the Trash: delete the Trash items below to get that space back.`);
  if (parts.length === 0) parts.push(done.length > 0 ? "Those were already gone." : "Nothing was deleted.");
  return { text: parts.join(" "), failures: outcomes.filter((o) => !o.ok).map((o) => ({ name: o.name, error: o.error ?? "It couldn't be deleted." })) };
}

/** The theme colour of a kind: the same everywhere that kind is drawn. The first seven have a theme token each
 * (--storage-1 … 7); the two added later mix two of them, so every theme has them without a new token. */
const COLOURS: Record<StorageKind, string> = {
  worktree: "var(--storage-1)",
  repo: "var(--storage-2)",
  build_output: "var(--storage-3)",
  simulator: "var(--storage-4)",
  cache: "var(--storage-5)",
  download: "var(--storage-6)",
  trash: "var(--storage-7)",
  archive: "color-mix(in srgb, var(--storage-4) 45%, var(--storage-2))",
  temp: "color-mix(in srgb, var(--storage-5) 45%, var(--storage-6))",
};
export const kindColour = (kind: StorageKind): string => COLOURS[kind];

/** The narrowest a kind's piece of the stacked bar is drawn, in percent of its width, so a tiny kind can still be seen and pointed at. */
export const MIN_SEGMENT = 2;

export interface Segment {
  kind: StorageKind;
  title: string;
  bytes: number;
  /** Whole percent of the total, the ones shown; they add up to exactly 100. */
  share: number;
  /** How wide its piece of the bar is drawn, in percent: its share, but at least MIN_SEGMENT, the rest narrowed to make room. */
  width: number;
}

/** What each piece of a stacked bar is: whole percents that add up to 100, and the width each is drawn at (at least MIN_SEGMENT). */
export function layout(sizes: number[]): { share: number; width: number }[] {
  const total = sizes.reduce((n, s) => n + s, 0);
  if (total === 0) return sizes.map(() => ({ share: 0, width: 0 }));
  // Whole percents by the largest remainder, so they add up to 100 and no rounding makes one kind vanish or the sum drift.
  const exact = sizes.map((s) => (s / total) * 100);
  const share = exact.map(Math.floor);
  let left = 100 - share.reduce((n, s) => n + s, 0);
  [...exact.keys()].sort((a, b) => exact[b] - share[b] - (exact[a] - share[a]) || a - b).forEach((i) => left-- > 0 && share[i]++);
  // Widths: a kind that would come out under the minimum is drawn at the minimum, and the others give up the room in proportion to their size.
  const small = exact.map(() => false);
  let widths: number[] = [];
  for (let again = true; again; ) {
    const room = 100 - small.filter(Boolean).length * MIN_SEGMENT;
    const bigTotal = exact.reduce((n, e, i) => n + (small[i] ? 0 : e), 0);
    widths = exact.map((e, i) => (small[i] ? MIN_SEGMENT : (e / bigTotal) * room));
    again = false;
    widths.forEach((w, i) => {
      if (!small[i] && w < MIN_SEGMENT) again = small[i] = true;
    });
  }
  return sizes.map((_, i) => ({ share: share[i], width: widths[i] }));
}

/** What each kind is of the scan, for the stacked bar and its legend: kinds with something in them, in GROUPS' order. */
export function segments(items: StorageItem[]): Segment[] {
  const kinds = GROUPS.map(({ kind, title }) => ({ kind, title, bytes: groupOf(items, kind).bytes })).filter((k) => k.bytes > 0);
  const laid = layout(kinds.map((k) => k.bytes));
  return kinds.map((k, i) => ({ ...k, ...laid[i] }));
}

/** How wide an item's own bar is, in percent: its size against the biggest item of the scan, but never so thin it can't be seen. */
export function rowWidth(bytes: number, biggest: number): number {
  return biggest <= 0 ? 0 : Math.min(100, Math.max(MIN_SEGMENT, (bytes / biggest) * 100));
}

/** "Total scanned 41.2 GB, selected to delete 5.0 GB (frees 3.0 GB; 2.0 GB goes to Trash first)". */
export function summaryText(totalBytes: number, sel: Selection): string {
  const scanned = `Total scanned ${sizeText(totalBytes)}`;
  if (sel.ids.length === 0) return `${scanned}, nothing selected to delete`;
  const frees = `frees ${sel.sharedBytes > 0 ? "up to " : ""}${sizeText(sel.bytes - sel.toTrashBytes)}`;
  return `${scanned}, selected to delete ${sizeText(sel.bytes)} (${sel.toTrashBytes > 0 ? `${frees}; ${sizeText(sel.toTrashBytes)} goes to Trash first` : frees})`;
}

/** A share as the legend writes it: a kind with something in it never reads "0%". */
export const shareText = (share: number) => (share === 0 ? "<1%" : `${share}%`);

/** The disk at a glance, for the numbers at the top of the tab: what is used, free, purgeable, and what the selection frees. */
export interface DiskFigures {
  total: number;
  /** Used by everything, purgeable included (as Finder counts it before macOS purges). */
  used: number;
  free: number;
  /** What macOS frees by itself when it needs the room; 0 when unknown. */
  purgeable: number;
  /** What deleting the selection frees now (what goes to the Trash doesn't), never more than is used. */
  frees: number;
  /** Free space once the selection is deleted. */
  freeAfter: number;
  /** Whether `frees` is an upper bound (some of it may be shared with what stays). */
  upTo: boolean;
}

/** The disk's figures, or null when the disk's size or free space is unknown. */
export function diskFigures(view: { total_bytes: number | null; free_bytes: number | null; purgeable_bytes: number | null }, sel: Selection): DiskFigures | null {
  if (view.total_bytes === null || view.free_bytes === null || view.total_bytes <= 0) return null;
  const total = view.total_bytes;
  const free = Math.min(view.free_bytes, total);
  const used = total - free;
  const purgeable = Math.min(view.purgeable_bytes ?? 0, used);
  const frees = Math.min(Math.max(0, sel.bytes - sel.toTrashBytes), used);
  return { total, used, free, purgeable, frees, freeAfter: free + frees, upTo: sel.sharedBytes > 0 };
}

/** The disk bar's pieces, in percent of the disk, left to right: used (what stays), selected to delete, purgeable, free. */
export function diskBar(f: DiskFigures): { stays: number; selected: number; purgeable: number; free: number } {
  const pct = (n: number) => (n / f.total) * 100;
  // What is selected and what is purgeable are both inside "used"; when they would overlap, the selection wins.
  const purgeable = Math.min(f.purgeable, f.used - f.frees);
  return { stays: pct(f.used - f.frees - purgeable), selected: pct(f.frees), purgeable: pct(purgeable), free: pct(f.free) };
}
