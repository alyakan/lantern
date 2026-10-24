import type { ChatItem } from "../store";

/**
 * What a chat's items are without its post-hooks: each hook item, and what Claude did for it (everything after it up to the
 * turn's end, or the next prompt). The hook's own work isn't the answer to anything: a notification, an agent's card or an
 * export that quotes the last reply wants the reply before it.
 */
export function outsideHooks(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let inHook = false;
  for (const it of items) {
    if (it.type === "hook") inHook = true;
    else if (it.type === "turn" || it.type === "user") inHook = false;
    if (!inHook) out.push(it);
  }
  return out;
}
