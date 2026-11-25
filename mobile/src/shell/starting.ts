/** What the New chat sheet sent: a message to a chat it carried on (its slot), or a new chat asked of the Mac (its start's id, see ChatStart). */
export type Started = { slot: string } | { start: string };

let next = 0;
/**
 * An id for a start: the Mac makes one chat for it however often it is asked by it, so it is unique beyond this run of the app
 * (the time it was made, and a count). Letters, digits and dashes, as the Mac takes them.
 */
export const newStartId = () => `start-${Date.now().toString(36)}-${(next++).toString(36)}`;
