import type { StorageItem, StorageKind, StorageOutcome } from "../types";

/** Sizes as the backend writes them (decimal, like Finder): "12.3 GB". */
export function sizeText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
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
  { kind: "cache", title: "Caches and logs", hint: "Apps and package managers make them again" },
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
  permanent: number;
  toTrash: number;
}

export function selection(items: StorageItem[], touched: ReadonlyMap<string, boolean>): Selection {
  const ticked = items.filter((i) => isTicked(i, touched));
  const holders = new Set(ticked.map((i) => i.id));
  const sel: Selection = { ids: ticked.map((i) => i.id), bytes: 0, toTrashBytes: 0, permanent: 0, toTrash: 0 };
  for (const i of ticked) {
    if (i.removal === "trash") {
      sel.toTrash++;
      sel.toTrashBytes += i.bytes;
    } else sel.permanent++;
    if (i.within && holders.has(i.within)) continue;
    sel.bytes += i.bytes;
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
