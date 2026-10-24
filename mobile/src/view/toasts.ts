/** Which chats have just finished or just started needing the user, from one chat list to the next. Pure, so it is tested without a screen. */
import type { ChatStatus } from "../protocol/generated/ChatStatus";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import { atRoot, shownSlot, type Nav } from "../shell/nav";

export type StatusMap = Record<string, ChatStatus>;

export interface ToastNote {
  slot: string;
  kind: "done" | "needs";
}

export const statusMap = (chats: RemoteChat[]): StatusMap => Object.fromEntries(chats.map((c) => [c.slot, c.status]));

/**
 * What changed in `chats` since `before` that is worth a toast: a chat that was working and is now idle (it finished), or one
 * that now needs you and did not. `before` is null until the first list has been seen, so a phone that has just connected
 * doesn't toast for everything the Mac was already in the middle of; a chat that wasn't in `before` is new, not changed.
 */
export function toastNotes(before: StatusMap | null, chats: RemoteChat[]): ToastNote[] {
  if (!before) return [];
  const notes: ToastNote[] = [];
  for (const c of chats) {
    const was = before[c.slot];
    if (!was) continue;
    if (c.status === "needs_you" && was !== "needs_you") notes.push({ slot: c.slot, kind: "needs" });
    else if (c.status === "idle" && was === "working") notes.push({ slot: c.slot, kind: "done" });
  }
  return notes;
}

/**
 * Whether a toast about `slot` would only repeat what is on the screen: the chat is the one being looked at, or the list of
 * chats is showing (a tablet's column held sideways or slid in, a phone's Home), where its row says it already.
 */
export function toastIsRedundant(slot: string, stack: Nav, tablet: boolean, columnShown: boolean): boolean {
  if (shownSlot(stack) === slot) return true;
  return tablet ? columnShown : atRoot(stack);
}
