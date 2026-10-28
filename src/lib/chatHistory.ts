import { useEffect, useRef, useState } from "react";

/** How many chats Back remembers. */
export const HISTORY_MAX = 50;

/** The history after moving from `from` to another chat: `from` on top (once, the newest kept). */
export function pushed(history: string[], from: string): string[] {
  return [...history.filter((s) => s !== from), from].slice(-HISTORY_MAX);
}

/** Where Back goes from `current`: the newest chat still open that isn't it, and the history left below it. */
export function backOf(history: string[], current: string, open: (slot: string) => boolean): { to: string; rest: string[] } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] !== current && open(history[i])) return { to: history[i], rest: history.slice(0, i) };
  }
  return null;
}

/**
 * Back, like a browser's, through the chats the window showed: every time the chat on screen changes (a banner, the
 * sidebar, the canvas, a new chat) the one left is remembered, and Back goes to the newest still open. Going back
 * doesn't remember the chat it left, so pressing it again goes further back.
 */
export function useChatHistory(active: string, isOpen: (slot: string) => boolean, show: (slot: string) => void) {
  const [history, setHistory] = useState<string[]>([]);
  const last = useRef(active);
  const goingBack = useRef(false);
  useEffect(() => {
    const from = last.current;
    last.current = active;
    if (from === active) return;
    if (goingBack.current) {
      goingBack.current = false;
      return;
    }
    setHistory((h) => pushed(h, from));
  }, [active]);
  const target = backOf(history, active, isOpen);
  const goBack = () => {
    if (!target) return;
    goingBack.current = true;
    setHistory(target.rest);
    show(target.to);
  };
  return { canGoBack: target !== null, goBack };
}
