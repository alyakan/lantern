/**
 * Session recaps (see src-tauri/src/recap.rs): coming back to a chat after a while shows a line of what happened and
 * what's next, as Claude Code does in a terminal.
 */

/** How long a chat must have been off screen (another chat, another app) before coming back to it shows a recap. */
export const AWAY_MS = 5 * 60_000;

export interface RecapChat {
  /** Whether its provider can recap (Capabilities.supports_recap). */
  canRecap: boolean;
  idle: boolean;
  sessionId: string | null;
  /** How many items the chat shows: a recap is made again only once this changed. */
  items: number;
}

/**
 * Whether coming back to `chat` after `awayMs` off screen asks for a recap: it was away long enough, it's idle with a
 * session to read, it has something to recap, and it has changed since the recap it already has (`recappedAt`: the
 * item count it was made at).
 */
export function wantsRecap(chat: RecapChat, awayMs: number, recappedAt: number | undefined): boolean {
  return chat.canRecap && chat.idle && !!chat.sessionId && chat.items > 0 && awayMs >= AWAY_MS && recappedAt !== chat.items;
}
