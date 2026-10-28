/** Every tab the side panel has. Only the pinned ones sit in its strip; the rest are in the ⋯ menu. */
export type Tab = "changes" | "files" | "plan" | "tests" | "checks" | "network" | "dashboard";
export const TABS: { id: Tab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "plan", label: "Plan" },
  { id: "tests", label: "Tests" },
  { id: "checks", label: "Checks" },
  { id: "network", label: "Network" },
  { id: "dashboard", label: "Dashboard" },
];
export const DEFAULT_PINNED: Tab[] = ["changes", "files", "plan"];

const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/** The tab a saved name stands for: Summary and Map became Plan; Activity, Agents and Storage left the pane for Changes; anything unknown is Changes. */
export function migrateTab(saved: string): Tab {
  if (saved === "summary" || saved === "map") return "plan";
  return isTab(saved) ? saved : "changes";
}

/** The pinned tabs from whatever was saved: unknown names and repeats dropped, in the saved order; the default when none is left. */
export function validPinned(saved: unknown): Tab[] {
  const pinned = Array.isArray(saved) ? saved.filter(isTab).filter((t, i, all) => all.indexOf(t) === i) : [];
  return pinned.length > 0 ? pinned : DEFAULT_PINNED;
}
