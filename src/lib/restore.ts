import { chatTitle } from "../sessions";
import type { State } from "../store";

/** An open chat as saved for the next launch: its conversation (if it has one), where, and what was typed in its box. */
export interface SavedChat {
  sessionId: string | null;
  folder: string;
  title: string;
  draft: string;
  /** The one on screen. */
  active: boolean;
}

const KEY = "session.openChats";

/** The open chats worth bringing back: those with a conversation or with text typed in their box. */
export function chatsToSave(slots: Record<string, State>, active: string, drafts: Record<string, string>, titles: Record<string, string>): SavedChat[] {
  return Object.entries(slots).flatMap(([slot, s]) => {
    const draft = drafts[slot]?.trim() ? drafts[slot] : "";
    const sessionId = s.items.length > 0 ? s.sessionId : null;
    if (!s.folder || (!sessionId && !draft)) return [];
    return [{ sessionId, folder: s.folder, title: chatTitle(s, titles), draft, active: slot === active }];
  });
}

/**
 * What to save while chats from the last launch are still offered: the open chats, then the offered ones, so quitting
 * before choosing doesn't lose them. With nothing open yet, the offered ones are saved as they were.
 */
export function withOffered(open: SavedChat[], offered: SavedChat[]): SavedChat[] {
  if (open.length === 0) return offered;
  const ids = new Set(open.map((c) => c.sessionId).filter(Boolean));
  return [...open, ...offered.filter((c) => !c.sessionId || !ids.has(c.sessionId)).map((c) => ({ ...c, active: false }))];
}

/** The one that was on screen first, then the rest as they were. */
export function screenFirst(chats: SavedChat[]): SavedChat[] {
  const i = Math.max(chats.findIndex((c) => c.active), 0);
  return chats.length ? [chats[i], ...chats.slice(0, i), ...chats.slice(i + 1)] : [];
}

export function loadSaved(): SavedChat[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((c) => typeof c?.folder === "string") : [];
  } catch {
    return [];
  }
}

export function save(chats: SavedChat[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats));
  } catch {
    // storage unavailable; there'll just be nothing to restore
  }
}
