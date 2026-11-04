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
