import type { ChatItem } from "../store";

/**
 * How many times Claude has finished an `enter_worktree` call, finished meaning Lantern has answered it: the chat's worktree
 * is set by then, so the Changes pane reads which one it is again when this number changes.
 */
export function worktreeCalls(items: ChatItem[]): number {
  let n = 0;
  for (const it of items) if (it.type === "tool" && it.name === "mcp__lantern__enter_worktree" && it.status !== "running") n++;
  return n;
}

/**
 * The worktree Claude last put the chat in with `enter_worktree`, read from the transcript (its card header is the path it
 * named, see stream_parser::summarize): null when that call left the worktree, undefined when it never made one. Only for
 * a chat reopened from disk, where nothing else remembers it.
 */
export function worktreeOf(items: ChatItem[]): string | null | undefined {
  let found: string | null | undefined;
  for (const it of items) if (it.type === "tool" && it.name === "mcp__lantern__enter_worktree" && it.status === "done") found = it.summary.trim() || null;
  return found;
}

/**
 * The worktree to put a chat back in when it wakes or reopens: the one it was last in, as Lantern saved it for its
 * session ("" when the user picked none in the Changes pane, which the transcript doesn't show), else the one its
 * transcript says. Closing a chat's claude (a sleep, a restart) loses its slot, and with it the worktree; a review edits
 * nothing, so its latest edit can't find the worktree again.
 */
export const worktreeToRestore = (saved: string | undefined, items: ChatItem[]): string | null => (saved !== undefined ? saved || null : (worktreeOf(items) ?? null));

/** The saved worktrees without session `sid`'s. */
export function forgetWorktree(saved: Record<string, string>, sid: string): Record<string, string> {
  const { [sid]: _gone, ...rest } = saved;
  return rest;
}

/** Whether the backend refused a worktree because it isn't one of the project's any more (see workdir.rs `resolve`). */
export const isGoneWorktree = (error: string) => /is not a linked worktree|has no linked worktrees/.test(error);
