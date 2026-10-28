/**
 * Lantern's own state for a folder, which follows the folder when it moves. These keys hold an object keyed by the
 * folder's path (what usePersistentState saved for it); migrateFolderState gives the new path the old one's entry.
 */
export const FOLDER_RECORDS = [
  "settings.permissionsByFolder",
  "settings.workflowByFolder",
  "settings.subagentsByFolder",
  "settings.promptHistory",
  "settings.harnessByFolder",
  "settings.providerByFolder",
  "review.collapsedByFolder",
  "settings.pinnedSessions",
  // The command typed for a project's tests, when Lantern can't tell how it is tested (the merge card's Run tests).
  "merge.testCommandByFolder",
  // The project's colour in the sidebar.
  "sidebar.projectColors",
  // The project's own agent roles and team templates.
  "settings.rolesByFolder",
  "settings.teamTemplatesByFolder",
  // Which of Ship it's steps (commit, push, pull request) were ticked last.
  "ship.ticksByFolder",
  // The text every new chat in the project starts with (Project notes in the project's ⋯ menu).
  "settings.projectNotes",
  // The project's setup lines for new worktrees, and its Run command.
  "settings.projectSetupByFolder",
  // What to do once a pull request's checks run (Off, Tell me, Fix it myself), and how far each pull request's fixing has got.
  "prChecks.byFolder",
  "prChecks.loopByFolder",
  // The project's own pre- and post-hook, in place of the workspace's (Settings → Hooks).
  "settings.chatHooksByFolder",
] as const;

/** Lantern's lists of folders that name the folder itself: the moved folder takes the old one's place in them. */
export const FOLDER_LISTS = [
  // The user's order of the sidebar's projects.
  "sidebar.projectOrder",
] as const;

/** Lantern's lists of things that each name their folder (routines): the moved folder takes the old one's place in each. */
export const FOLDER_ITEMS = ["settings.routines"] as const;

/** The folder that was open last, reopened at launch. */
export const LAST_FOLDER = "settings.lastFolder";
/** The chats open when Lantern last closed, each with the folder it was in. */
export const OPEN_CHATS = "session.openChats";

/** Every key the app saves that isn't about one folder (a session, a model, a setting). Listed so a new key is a decision. */
export const NOT_FOLDER_KEYED = [
  "settings.modeBySession",
  "settings.harnessBySession",
  // The conversations of agents (a list of session ids): what the past chats leave out.
  "session.agentIds",
  // The provider a session runs on (set only for one that isn't Claude's), and each other provider's model and effort.
  "settings.providerBySession",
  "settings.providerPrefs",
  "settings.model",
  "settings.effort",
  "settings.defaultModel",
  "settings.modelIds",
  "settings.contextWindows",
  // The folders whose "moved?" notice was dismissed: a list of old paths, not any one folder's state.
  "relocate.dismissed",
  "settings.harnessPresets",
  // Keep the Mac awake while Claude works (Settings → General).
  "settings.keepAwake",
  // The pre- and post-hook for every project (Settings → Hooks).
  "settings.chatHooks",
  "settings.theme",
  "settings.customTheme",
  "settings.textSize",
  // Asking before a team starts while another is working.
  "settings.warnSecondTeam",
  "review.collapsed",
  "review.canvasPanel",
  "review.ratio",
  "review.scope",
  "review.tab",
  "review.tabs",
  "review.diffLayout",
  "review.commitsOpen",
  "files.markdownView",
  "summary.exportResults",
  // The sidebar: hidden (once minimized to a rail), compact, its width, and which projects were folded or opened by hand or removed from the
  // recents (lists of paths, not any one folder's state: a moved folder is simply a new project there).
  "sidebar.collapsed",
  "sidebar.compact",
  "sidebar.width",
  "sidebar.expanded",
  "sidebar.hidden",
] as const;

/**
 * The note Claude gets once, in front of the first message sent in a chat opened from a place the folder moved from:
 * the paths in the earlier messages are the old ones. It's the same kind of block as the revert note.
 */
export function movedNote(from: string, to: string): string {
  return `[Lantern note: This project moved from ${from} to ${to}: paths in earlier messages are the old ones.]`;
}

/** The message with the moved note in front of it (a slash command goes to Claude as it is, so it gets none). */
export function withMovedNote(text: string, from: string | null, to: string | null): string {
  if (!from || !to || text.startsWith("/")) return text;
  return `${movedNote(from, to)}\n\n${text}`;
}

/** A path as its folder and its last name (`["/Users/you/dev/", "app"]`): the last name is the part a long path keeps. */
export function splitPath(path: string): [string, string] {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? ["", trimmed] : [trimmed.slice(0, i + 1), trimmed.slice(i + 1)];
}

/** What the migration changed: each key's new value, as it was written. */
export type Migrated = Record<string, unknown>;

/** The part of localStorage the migration uses, so a test can pass its own. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function readJson(store: KeyValueStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Carries a folder's saved state over from `old` to `next` when the folder moves. Each per-folder entry is copied to the
 * new path, unless the new path already has one (which is kept). The last folder and the saved chats in the old folder
 * name the new one. Returns what was written, so the caller can update the state it keeps in memory: without that, the
 * next save would write the old values back.
 */
export function migrateFolderState(store: KeyValueStore, old: string, next: string): Migrated {
  const changed: Migrated = {};
  for (const key of FOLDER_RECORDS) {
    const saved = readJson(store, key);
    if (!isRecord(saved) || !(old in saved) || next in saved) continue;
    changed[key] = { ...saved, [next]: saved[old] };
  }
  for (const key of FOLDER_LISTS) {
    const saved = readJson(store, key);
    if (!Array.isArray(saved) || !saved.includes(old) || saved.includes(next)) continue;
    changed[key] = saved.map((f) => (f === old ? next : f));
  }
  for (const key of FOLDER_ITEMS) {
    const saved = readJson(store, key);
    if (Array.isArray(saved) && saved.some((x) => isRecord(x) && x.folder === old)) changed[key] = saved.map((x) => (isRecord(x) && x.folder === old ? { ...x, folder: next } : x));
  }
  if (readJson(store, LAST_FOLDER) === old) changed[LAST_FOLDER] = next;
  const chats = readJson(store, OPEN_CHATS);
  if (Array.isArray(chats) && chats.some((c) => isRecord(c) && c.folder === old)) {
    // A chat from the old folder is the same chat now (its session, or its unsent text), so it's kept once.
    const sessions = new Set(chats.filter((c) => isRecord(c) && c.folder === next && c.sessionId).map((c) => (c as { sessionId: string }).sessionId));
    const moved = chats
      .filter((c) => !(isRecord(c) && c.folder === old && typeof c.sessionId === "string" && sessions.has(c.sessionId)))
      .map((c) => (isRecord(c) && c.folder === old ? { ...c, folder: next } : c));
    changed[OPEN_CHATS] = moved;
  }
  for (const [key, value] of Object.entries(changed)) {
    try {
      store.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: the in-memory state still has the move
    }
  }
  return changed;
}
