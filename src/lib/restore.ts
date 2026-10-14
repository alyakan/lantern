import { chatTitle, type AgentMeta } from "../sessions";
import type { State } from "../store";

/**
 * What a saved chat was in an orchestra. A worker names its main agent by that chat's session, which is still the same
 * after a restart (slots are not), so the team can be put back together.
 */
export type SavedTeamRole =
  | { role: "main" }
  | { role: "worker"; name: string; parentSession: string; branch: string | null; base: string | null; isolation: "worktree" | "shared"; hidden?: boolean };

/** An open chat as saved for the next launch: its conversation (if it has one), where, and what was typed in its box. */
export interface SavedChat {
  sessionId: string | null;
  folder: string;
  title: string;
  draft: string;
  /** The one on screen. */
  active: boolean;
  /** Absent for a chat that was not part of an orchestra. */
  orchestra?: SavedTeamRole;
}

const KEY = "session.openChats";

/** The open chats worth bringing back: those with a conversation or with text typed in their box. */
export function chatsToSave(slots: Record<string, State>, active: string, drafts: Record<string, string>, titles: Record<string, string>, agents: Record<string, AgentMeta> = {}): SavedChat[] {
  return Object.entries(slots).flatMap(([slot, s]) => {
    const draft = drafts[slot]?.trim() ? drafts[slot] : "";
    const sessionId = s.items.length > 0 ? s.sessionId : null;
    if (!s.folder || (!sessionId && !draft)) return [];
    const meta = agents[slot];
    const parentSession = meta ? (slots[meta.parent]?.sessionId ?? null) : null;
    const orchestra: SavedTeamRole | undefined = s.orchestrator
      ? { role: "main" }
      : meta && parentSession
        ? { role: "worker", name: meta.name, parentSession, branch: meta.branch, base: meta.base, isolation: meta.isolation, ...(meta.hidden ? { hidden: true } : {}) }
        : undefined;
    return [{ sessionId, folder: s.folder, title: meta?.name ?? chatTitle(s, titles), draft, active: slot === active, ...(orchestra ? { orchestra } : {}) }];
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
