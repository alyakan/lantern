/**
 * Messages sent while Claude is still working: they wait for it to reach the next step, and the chat should say so instead of
 * leaving a message sitting there with nothing after it.
 */
import type { Item } from "../sync/reducer";

/**
 * The ids of the user messages that came in while a turn was already running and that Claude has not acted on yet: nothing of
 * Claude's (words or a step) follows them. Only while the chat is `working`; an idle chat has nothing waiting.
 */
export function queuedIds(items: Item[], working: boolean): Set<string> {
  const queued = new Set<string>();
  if (!working) return queued;
  let open = false;
  let pending: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "turn":
        open = false;
        pending = [];
        break;
      case "user":
        // The first message of a turn begins it; one that comes while it runs waits its turn.
        if (open) pending.push(it.id);
        else open = true;
        break;
      case "assistant":
      case "step":
        // Claude went on: what was waiting has been read.
        open = true;
        pending = [];
        break;
      default:
        break;
    }
  }
  for (const id of pending) queued.add(id);
  return queued;
}
