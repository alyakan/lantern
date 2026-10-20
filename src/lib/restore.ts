import { chatTitle, type AgentMeta } from "../sessions";
import type { AgentRole } from "./roles";
import type { ReviewSetting } from "./reviewChain";
import type { State } from "../store";
import type { RelocationEntry } from "../types";
import { savedModeOf } from "./workflow";

/**
 * What a saved chat was in an orchestra. A worker names its main agent by that chat's session, which is still the same
 * after a restart (slots are not), so the team can be put back together.
 */
export type SavedTeamRole =
  | { role: "main"; review?: ReviewSetting }
  | { role: "worker"; name: string; parentSession: string; branch: string | null; base: string | null; isolation: "worktree" | "shared"; agentRole?: AgentRole; hidden?: boolean; model?: string };

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

/**
 * One open chat as it is saved for the next launch, or null when it isn't worth bringing back: it has no conversation and
 * nothing typed, or it is an agent that can't come back inside its team.
 */
export function savedChatOf(slot: string, slots: Record<string, State>, active: string, drafts: Record<string, string>, titles: Record<string, string>, agents: Record<string, AgentMeta> = {}): SavedChat | null {
  const s = slots[slot];
  if (!s) return null;
  const draft = drafts[slot]?.trim() ? drafts[slot] : "";
  // A chat with no messages in memory that went to sleep is saved as it was then (a team member keeps its part in the team):
  // asleep, waking (its history is on its way), or one that failed to wake.
  if (s.asleepSaved && s.items.length === 0 && s.sessionId) return { ...s.asleepSaved, draft, active: slot === active };
  // An asleep chat has no messages in memory, but it has its conversation.
  const sessionId = s.items.length > 0 || s.status === "asleep" ? s.sessionId : null;
  if (!s.folder || (!sessionId && !draft)) return null;
  const meta = agents[slot];
  const parentSession = meta ? (slots[meta.parent]?.sessionId ?? null) : null;
  // An agent only comes back inside its team: one the Lead stopped, or whose Lead has no conversation to come back to,
  // is left out (saved as it was, it would return as an ordinary chat).
  if (meta && (!parentSession || s.leadStopped)) return null;
  const orchestra: SavedTeamRole | undefined = s.orchestrator
    ? { role: "main", ...(s.review.on ? { review: s.review } : {}) }
    : meta && parentSession
      ? { role: "worker", name: meta.name, parentSession, branch: meta.branch, base: meta.base, isolation: meta.isolation, ...(meta.role ? { agentRole: meta.role } : {}), ...(meta.hidden ? { hidden: true } : {}), ...(s.model ? { model: s.model } : {}) }
      : undefined;
  return { sessionId, folder: s.folder, title: meta?.name ?? chatTitle(s, titles), draft, active: slot === active, ...(orchestra ? { orchestra } : {}) };
}

/** The open chats worth bringing back: those with a conversation or with text typed in their box. */
export function chatsToSave(slots: Record<string, State>, active: string, drafts: Record<string, string>, titles: Record<string, string>, agents: Record<string, AgentMeta> = {}): SavedChat[] {
  return Object.keys(slots).flatMap((slot) => savedChatOf(slot, slots, active, drafts, titles, agents) ?? []);
}

/**
 * `saved` (each session's mode, Step by step's Permissions included: see `savedModeOf`) with the mode every open chat that has a session is in now, or null when that changes
 * nothing. Every chat, not just the one on screen: a worker takes its mode from its main agent in the background, and
 * one the user never opens would otherwise come back on Ask.
 */
export function sessionModesToSave(slots: Record<string, State>, saved: Record<string, string>): Record<string, string> | null {
  // Not an asleep chat's: its state is only a name, with the mode of whichever chat was open when it was made, and it wakes on what was saved.
  const now = Object.values(slots).flatMap((s) => (s.sessionId && s.status !== "asleep" ? [[s.sessionId, savedModeOf(s)] as const] : []));
  if (now.every(([id, mode]) => saved[id] === mode)) return null;
  return { ...saved, ...Object.fromEntries(now) };
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

/** Whether a folder is one an agent worked in (its worktree), not one the user opened: see `is_agent_folder` in history.rs. */
export function isAgentFolder(path: string): boolean {
  const parts = path.split("/");
  return parts.some((p, i) => p === "worktrees" && (parts[i - 1] === "io.github.alyakan.lantern" || parts[i - 1] === ".claude"));
}

/** The conversations of the agents in `saved`: what the past chats leave out, so an agent's is never listed as the user's. */
export function agentSessionsOf(saved: SavedChat[]): string[] {
  return saved.flatMap((c) => (c.sessionId && (c.orchestra?.role === "worker" || (!c.orchestra && isAgentFolder(c.folder))) ? [c.sessionId] : []));
}

/**
 * The saved chats that are worth offering: an agent only with its team (a worker whose main agent isn't saved is dropped,
 * and one an older version saved as an ordinary chat, which sits in an agent's worktree or is a known agent's
 * conversation, too). Agents are only ever part of their team, never a chat of their own.
 */
export function restorable(chats: SavedChat[], agentSessions: ReadonlySet<string> = new Set()): SavedChat[] {
  const mains = new Set(chats.filter((c) => c.orchestra?.role === "main" && c.sessionId).map((c) => c.sessionId));
  return chats.filter((c) => {
    if (c.orchestra?.role === "worker") return mains.has(c.orchestra.parentSession);
    if (c.orchestra?.role === "main") return true;
    return !isAgentFolder(c.folder) && !(c.sessionId && agentSessions.has(c.sessionId));
  });
}

/** `chats` without the workers whose folders (a worktree removed after its merge) are gone. */
export function withoutGone(chats: SavedChat[], gone: ReadonlySet<string>): SavedChat[] {
  return chats.filter((c) => c.orchestra?.role !== "worker" || !gone.has(c.folder));
}

/** The session a saved chat is in a team by: a Lead's own, or its Lead's for an agent (null: not in a team). */
export function teamOf(c: SavedChat): string | null {
  return c.orchestra?.role === "main" ? c.sessionId : c.orchestra?.role === "worker" ? c.orchestra.parentSession : null;
}

/**
 * Whether Restore all starts `c` now, rather than leaving it asleep in the sidebar until it is opened: the chat that was on
 * screen, and the team it was in (a team sleeps and wakes as one). An agent whose Lead is already open (`openLeads`: the
 * sessions of Leads that are awake) comes back under it now: asleep it would be an ordinary chat. A chat with no
 * conversation yet (typed in, never sent) has nothing to put to sleep.
 */
export function startsNow(c: SavedChat, first: SavedChat, openLeads: ReadonlySet<string>): boolean {
  if (c === first || !c.sessionId) return true;
  if (c.orchestra?.role === "worker" && openLeads.has(c.orchestra.parentSession)) return true;
  const team = teamOf(c);
  return team !== null && team === teamOf(first);
}

/** The one that was on screen first, then the rest as they were. */
export function screenFirst(chats: SavedChat[]): SavedChat[] {
  const i = Math.max(chats.findIndex((c) => c.active), 0);
  return chats.length ? [chats[i], ...chats.slice(0, i), ...chats.slice(i + 1)] : [];
}

/** Where `folder` is now: the folder it was recorded as moving to, else itself. */
export function currentFolder(folder: string, moves: RelocationEntry[]): string {
  const trimmed = folder.replace(/\/+$/, "");
  return moves.find((m) => m.aliases.some((a) => a.replace(/\/+$/, "") === trimmed))?.folder ?? folder;
}

/**
 * The saved chats with each folder that has moved named as it is now (a chat open in the old place when it moved is
 * saved with that place). One saved in both places is the same chat, so it's kept once, under the new one.
 */
export function toCurrentFolders(chats: SavedChat[], moves: RelocationEntry[]): SavedChat[] {
  if (moves.length === 0) return chats;
  const moved = chats.map((c) => ({ c, folder: currentFolder(c.folder, moves) }));
  const here = new Set(moved.filter(({ c, folder }) => c.folder === folder && c.sessionId).map(({ c }) => `${c.folder}\n${c.sessionId}`));
  return moved
    .filter(({ c, folder }) => c.folder === folder || !c.sessionId || !here.has(`${folder}\n${c.sessionId}`))
    .map(({ c, folder }) => (c.folder === folder ? c : { ...c, folder }));
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
