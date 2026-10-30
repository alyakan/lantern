/** Every tab the side panel has. Only the pinned ones sit in its strip; the rest are in the ⋯ menu. */
export type Tab = "changes" | "files" | "plan" | "tests" | "checks" | "network" | "dashboard" | "artifacts" | "todos";
export const TABS: { id: Tab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "plan", label: "Plan" },
  { id: "tests", label: "Tests" },
  { id: "checks", label: "Checks" },
  { id: "network", label: "Network" },
  { id: "dashboard", label: "Dashboard" },
  { id: "artifacts", label: "Artifacts" },
  { id: "todos", label: "Todos" },
];
export const DEFAULT_PINNED: Tab[] = ["changes", "files", "plan"];

const isTab = (v: unknown): v is Tab => TABS.some((t) => t.id === v);

/** The tab a saved name stands for: Summary and Map became Plan; Activity, Agents and Storage left the pane for Changes; anything unknown is Changes. */
export function migrateTab(saved: string): Tab {
  if (saved === "summary" || saved === "map") return "plan";
  return isTab(saved) ? saved : "changes";
}

/** A chat, as the side panel knows it: its slot (for this run of the app) and its Claude session, once it has one. */
export interface ChatKey {
  slot: string;
  session: string | null;
}

/** How many chats' tabs are kept (the newest picked): the stored value stays small. */
export const CHAT_TABS_KEPT = 200;
const CHAT_TABS_KEY = "review.chatTabs";

// A chat's tab by its session, kept across restarts, and by its slot, for a chat with no session yet. Slots are numbered
// afresh each run, so those are kept only while the app runs: a kept one could land on another chat.
const bySlot = new Map<string, Tab>();

function readBySession(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CHAT_TABS_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The tab picked in a chat the last time it was on screen; Changes when none was. */
export function chatTabOf(chat: ChatKey | undefined): Tab {
  if (!chat) return "changes";
  const saved = chat.session ? readBySession()[chat.session] : undefined;
  return saved !== undefined ? migrateTab(saved) : (bySlot.get(chat.slot) ?? "changes");
}

/** Keeps the tab picked in a chat: for this run by its slot, and across restarts by its session. */
export function keepChatTab(chat: ChatKey | undefined, tab: Tab) {
  if (!chat) return;
  bySlot.set(chat.slot, tab);
  if (!chat.session) return;
  const all = readBySession();
  // Picked again moves it to the newest end; the oldest beyond the limit are forgotten.
  delete all[chat.session];
  all[chat.session] = tab;
  const kept = Object.entries(all).slice(-CHAT_TABS_KEPT);
  try {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage unavailable: the tab holds until the app closes.
  }
}

/** For tests: forget the tabs kept by slot. */
export function forgetChatTabs() {
  bySlot.clear();
}

/** The pinned tabs from whatever was saved: unknown names and repeats dropped, in the saved order; the default when none is left. */
export function validPinned(saved: unknown): Tab[] {
  const pinned = Array.isArray(saved) ? saved.filter(isTab).filter((t, i, all) => all.indexOf(t) === i) : [];
  return pinned.length > 0 ? pinned : DEFAULT_PINNED;
}
