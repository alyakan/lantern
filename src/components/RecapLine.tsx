import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { wantsRecap, type RecapChat } from "../lib/recap";
import { onWindowFocus } from "../lib/windowFocus";

/**
 * The recap for the chat on screen (see lib/recap.ts), or null. A chat is away from the moment it leaves the screen (another
 * chat is opened, or the window loses focus) until it's back; coming back after long enough asks Claude for a recap, which
 * shows until the chat changes (the user sends, or a turn starts).
 */
export function useRecap(slot: string, chat: RecapChat, folder: string | null, claudePath: string | null): string | null {
  // When each chat last left the screen.
  const leftAt = useRef(new Map<string, number>());
  // Each chat's recap, by the item count it was asked for at; text is null while it's being made.
  const [recaps, setRecaps] = useState<Record<string, { at: number; text: string | null }>>({});
  const recapsRef = useRef(recaps);
  recapsRef.current = recaps;
  const latest = useRef({ slot, chat, folder, claudePath });
  latest.current = { slot, chat, folder, claudePath };

  const back = useCallback(() => {
    const { slot, chat, folder, claudePath } = latest.current;
    const left = leftAt.current.get(slot);
    leftAt.current.delete(slot);
    if (left === undefined || !folder || !claudePath || !chat.sessionId) return;
    if (!wantsRecap(chat, Date.now() - left, recapsRef.current[slot]?.at)) return;
    const at = chat.items;
    setRecaps((all) => ({ ...all, [slot]: { at, text: null } }));
    api.recapSession(claudePath, folder, chat.sessionId).then(
      (text) => setRecaps((all) => (all[slot]?.at === at ? { ...all, [slot]: { at, text } } : all)),
      () => {},
    );
  }, []);

  // Another chat opened: this one left the screen. Coming back to it is checked when it opens again.
  useEffect(() => {
    back();
    return () => {
      leftAt.current.set(slot, Date.now());
    };
  }, [slot, back]);

  // The app's own idea of focus (the page's focus and blur aren't reliable in its web view; see lib/windowFocus.ts).
  useEffect(() => onWindowFocus((focused) => (focused ? back() : leftAt.current.set(latest.current.slot, Date.now()))), [back]);

  const mine = recaps[slot];
  return mine && mine.at === chat.items && chat.idle ? mine.text : null;
}

/** The recap as the terminal shows it: one quiet line above the box. */
export function RecapLine({ text }: { text: string }) {
  return (
    <div className="recap-line" role="status">
      <span className="recap-label">recap:</span> {text}
    </div>
  );
}
