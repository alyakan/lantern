import type { MemoryApp, MemorySnapshot } from "../types";
import { layout } from "./storage";

/** Memory sizes the way Activity Monitor writes them: 1024-based, so a 16 GB Mac reads "16.0 GB" and not "17.2 GB". */
export function memoryText(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb < 1000) return `${Math.max(0, Math.round(mb))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A share of the RAM as the list writes it: something small never reads "0%". */
export const memoryShare = (share: number): string => (share <= 0 ? "0%" : share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

export const PRESSURE_LABEL = { normal: "normal", warning: "warning", critical: "critical" } as const;

/** The line under the bar: "About 11.8 GB used of 16.0 GB, pressure: normal, swap 8.3 GB". */
export function summaryLine(s: MemorySnapshot): string {
  const swap = s.swap_used_bytes === null ? "" : `, swap ${memoryText(s.swap_used_bytes)}`;
  return `About ${memoryText(s.used_bytes)} used of ${memoryText(s.total_bytes)}, pressure: ${PRESSURE_LABEL[s.pressure]}${swap}`;
}

/** Where the pressure level came from, for its tooltip. */
export const pressureSource = (s: MemorySnapshot): string => (s.pressure_source === "kernel" ? "macOS's own memory pressure level" : "Estimated from how much memory is free, cached and compressed");

/** "1 process", "11 processes". */
export const processText = (n: number): string => `${n} ${n === 1 ? "process" : "processes"}`;

/** How long ago the numbers were read: "just now" until it has been a while. */
export function updatedText(at: number | null, now: number): string {
  if (at === null) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 5 ? "Updated just now" : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
}

/** An app that moves this many rows or fewer from where it sits keeps its row: the list doesn't jump on every refresh. */
export const ROW_SLACK = 3;

/**
 * The list in the order to draw it: the order of the last refresh, except that an app which belongs more than `slack` rows
 * from where it sits is moved to where it belongs. Apps that appeared take their place by size; those gone are dropped; "Other apps"
 * is always last. `ideal` is by size, biggest first.
 */
export function stableOrder(previous: string[], apps: MemoryApp[], slack = ROW_SLACK): MemoryApp[] {
  const byName = new Map(apps.map((a) => [a.name, a]));
  const ideal = [...apps].filter((a) => a.kind !== "other").sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).map((a) => a.name);
  const other = apps.filter((a) => a.kind === "other");
  const order = previous.filter((n) => byName.has(n) && byName.get(n)!.kind !== "other");
  for (const n of ideal) if (!order.includes(n)) order.splice(Math.min(ideal.indexOf(n), order.length), 0, n);
  // Moving one app shifts the rows between, so go again until none is further from its place than the slack (it takes at most one move each).
  for (let moves = 0; moves < ideal.length; moves++) {
    const far = order.findIndex((n, i) => Math.abs(i - ideal.indexOf(n)) > slack);
    if (far < 0) break;
    const [name] = order.splice(far, 1);
    order.splice(ideal.indexOf(name), 0, name);
  }
  return [...order.map((n) => byName.get(n)!), ...other];
}

/** How many of the biggest apps get a colour of their own in the bar; the rest share "Other apps". */
export const COLOURED_APPS = 4;

export type PartKey = "lantern" | "macos" | "other" | "cached" | "free" | `app:${string}`;

export interface MemoryPart {
  key: PartKey;
  title: string;
  bytes: number;
  /** Whole percent of the RAM; the parts add up to exactly 100. */
  share: number;
  /** How wide it is drawn, in percent. */
  width: number;
  /** A CSS colour (a theme token). */
  colour: string;
}

// The Storage panel's own tokens, so every theme already has them at a readable contrast: the biggest apps one each, Lantern's green,
// the rest in a muted pair. Cached and free are the quiet end of the bar.
const APP_COLOURS = ["var(--storage-1)", "var(--storage-2)", "var(--storage-4)", "var(--storage-5)"];
const COLOUR = { lantern: "var(--storage-3)", macos: "var(--storage-7)", other: "var(--storage-6)", cached: "color-mix(in srgb, var(--text) 28%, transparent)", free: "transparent" } as const;

/** The colour an app's swatch and row bar have: its bar piece's, which for an app past the biggest few is the one of "Other apps". */
export function appColours(apps: MemoryApp[]): Map<string, string> {
  const out = new Map<string, string>();
  let rank = 0;
  for (const a of apps) {
    if (a.kind === "lantern") out.set(a.name, COLOUR.lantern);
    else if (a.kind === "macos") out.set(a.name, COLOUR.macos);
    else if (a.kind === "other") out.set(a.name, COLOUR.other);
    else out.set(a.name, rank < COLOURED_APPS ? APP_COLOURS[rank] : COLOUR.other);
    if (a.kind === "app") rank++;
  }
  return out;
}

/** The whole RAM as one stacked bar: the biggest apps, Lantern, macOS, the other apps, then cached and free. `apps` in the order drawn. */
export function memoryParts(s: MemorySnapshot, apps: MemoryApp[]): MemoryPart[] {
  const colours = appColours(apps);
  const named = apps.filter((a) => a.kind === "app");
  const parts: Omit<MemoryPart, "share" | "width">[] = [
    ...named.slice(0, COLOURED_APPS).map((a) => ({ key: `app:${a.name}` as PartKey, title: a.name, bytes: a.bytes, colour: colours.get(a.name)! })),
    ...apps.filter((a) => a.kind === "lantern").map((a) => ({ key: "lantern" as PartKey, title: a.name, bytes: a.bytes, colour: COLOUR.lantern })),
    ...apps.filter((a) => a.kind === "macos").map((a) => ({ key: "macos" as PartKey, title: a.name, bytes: a.bytes, colour: COLOUR.macos })),
    { key: "other", title: "Other apps", bytes: named.slice(COLOURED_APPS).reduce((n, a) => n + a.bytes, 0) + apps.filter((a) => a.kind === "other").reduce((n, a) => n + a.bytes, 0), colour: COLOUR.other },
    { key: "cached", title: "Cached", bytes: s.cached_bytes, colour: COLOUR.cached },
    { key: "free", title: "Free", bytes: s.free_bytes, colour: COLOUR.free },
  ];
  const present = parts.filter((p) => p.bytes > 0);
  const laid = layout(present.map((p) => p.bytes));
  return present.map((p, i) => ({ ...p, ...laid[i] }));
}

/** What a part says in the legend, the tooltip and the bar's text alternative. */
export const partText = (p: MemoryPart): string => `${p.title}: ${memoryText(p.bytes)} (${p.share === 0 ? "<1%" : `${p.share}%`})`;

const KEY = "lantern.storageTab";
export type StorageTabName = "disk" | "memory";

/** The Storage panel's tab as it was left: Disk until the user picks Memory. */
export function lastStorageTab(): StorageTabName {
  try {
    return localStorage.getItem(KEY) === "memory" ? "memory" : "disk";
  } catch {
    return "disk";
  }
}

export function rememberStorageTab(tab: StorageTabName): void {
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // storage unavailable: it lasts until the panel is closed
  }
}
