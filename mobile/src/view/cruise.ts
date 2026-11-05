/** Cruise's logic, tested alone: when to ask the Mac for the next step in a chat, and which draft to show. */
import type { ChatStatus } from "../protocol/generated/ChatStatus";
import type { Suggestion } from "../protocol/generated/Suggestion";

/**
 * Whether Cruise should ask for a next step now: it is on, the chat is idle (not working, not waiting on you, not asleep),
 * there is at least one turn, and it hasn't already asked for the turn that is showing (`asked` is the key of the turn it
 * last asked for). That makes it ask once each time a turn ends, and again only when the chat moves on.
 */
export function shouldAsk(o: { on: boolean; status: ChatStatus | undefined; asked: string | null; turnKey: string }): boolean {
  return o.on && o.status === "idle" && o.turnKey !== "" && o.asked !== o.turnKey;
}

/** The draft to show: the one at `at`, wrapping round, so "Another" can go round the ones already made; none when there are none. */
export function draftAt(items: Suggestion[], at: number): Suggestion | null {
  if (items.length === 0) return null;
  const n = items.length;
  return items[((at % n) + n) % n];
}
