import type { ChatItem } from "../store";

/**
 * Whether a hook that comes after `prev` has its own work to show: it follows Claude's reply (or another hook's). One that
 * comes while the turn is still at work (after a tool, or right after the user's message) was sent into a message that was
 * already on its way (a message typed while a compaction ended, say): it did not wait for the answer, so what follows it
 * is the user's turn going on, not the hook's work.
 */
export function followsReply(prev: ChatItem | undefined): boolean {
  return prev?.type === "assistant" || prev?.type === "hook";
}

/**
 * What a chat's items are without its post-hooks: each hook item, and what Claude did for it (everything after it up to the
 * turn's end, or the next prompt). The hook's own work isn't the answer to anything: a notification, an agent's card or an
 * export that quotes the last reply wants the reply before it.
 */
export function outsideHooks(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let inHook = false;
  for (const [i, it] of items.entries()) {
    if (it.type === "hook") {
      if (followsReply(items[i - 1])) inHook = true;
      continue;
    } else if (it.type === "turn" || it.type === "user") inHook = false;
    if (!inHook) out.push(it);
  }
  return out;
}
