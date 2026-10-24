/**
 * Chat hooks: two prompts the user writes, which Lantern runs around the messages they send. The pre-hook goes in front of
 * a chat's first message and of the first one after a compaction; the post-hook is sent as a turn of its own once Claude
 * has answered a message. They are plain prompts ("Check the brain's summary about this project", "Update the brain if
 * needed"). Set for the whole workspace, and where a project wants its own, for that project. The backend applies them (see
 * hooks.rs); the window keeps what the user wrote and sends it there (`api.setChatHooks`, when it starts and on every change).
 */
export interface Hook {
  text: string;
  on: boolean;
}

export type HookKind = "pre" | "post";

/** A project's own choice for each hook: absent uses the workspace's, one that is off means none for the project. */
export interface ProjectHooks {
  pre?: Hook;
  post?: Hook;
}

export interface HookTable {
  pre: Hook;
  post: Hook;
  projects: Record<string, ProjectHooks>;
}

/** The most characters a hook holds: the backend cuts to it as well (hooks.rs MAX_HOOK_CHARS). */
export const HOOK_MAX = 2000;

/** What a post-hook's message to Claude starts with (hooks.rs POST_PREFIX): a replayed chat shows it as a hook, not a prompt. */
export const POST_PREFIX = "[Lantern post-hook]\n";

export const NO_HOOKS: HookTable = { pre: { text: "", on: false }, post: { text: "", on: false }, projects: {} };

/** The post-hook in a message, or null when it isn't one. */
export const postText = (message: string): string | null => (message.startsWith(POST_PREFIX) ? message.slice(POST_PREFIX.length) : null);

const readHook = (raw: unknown): Hook | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Partial<Hook>;
  return { text: typeof h.text === "string" ? h.text.slice(0, HOOK_MAX) : "", on: h.on === true };
};

/** What was saved, which may be anything (storage is editable): only well-formed hooks are used. */
export function readHooks(raw: unknown): HookTable {
  if (!raw || typeof raw !== "object") return NO_HOOKS;
  const t = raw as Record<string, unknown>;
  const projects: Record<string, ProjectHooks> = {};
  if (t.projects && typeof t.projects === "object") {
    for (const [folder, p] of Object.entries(t.projects as Record<string, unknown>)) {
      const own = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
      const [pre, post] = [readHook(own.pre), readHook(own.post)];
      if (pre || post) projects[folder] = { ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
    }
  }
  return { pre: readHook(t.pre) ?? NO_HOOKS.pre, post: readHook(t.post) ?? NO_HOOKS.post, projects };
}

/** How a project stands for one hook: on the workspace's, on its own words, or with none. */
export type HookChoice = "workspace" | "custom" | "off";

export function choiceOf(table: HookTable, folder: string, kind: HookKind): { choice: HookChoice; text: string } {
  const own = table.projects[folder]?.[kind];
  if (!own) return { choice: "workspace", text: "" };
  return { choice: own.on ? "custom" : "off", text: own.text };
}

/** The table with a project's hook set (`workspace` takes its own away); a project left with nothing of its own is dropped. */
export function withProjectHook(table: HookTable, folder: string, kind: HookKind, choice: HookChoice, text: string): HookTable {
  const { [folder]: before, ...others } = table.projects;
  const mine: ProjectHooks = { ...before };
  if (choice === "workspace") delete mine[kind];
  else mine[kind] = { text: text.slice(0, HOOK_MAX), on: choice === "custom" };
  return { ...table, projects: mine.pre || mine.post ? { ...others, [folder]: mine } : others };
}

/** What a chat in `folder` has for a hook: its words, or null when it has none (off, or empty). */
export function hookFor(table: HookTable, folder: string | null, kind: HookKind): string | null {
  const h = (folder && table.projects[folder]?.[kind]) || table[kind];
  const text = h.on ? h.text.trim() : "";
  return text || null;
}
