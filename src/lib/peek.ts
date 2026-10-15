import { useCallback, useEffect, useRef, useState } from "react";

/** How long the pointer rests on the window's left edge (hidden) or on the compact column before the full sidebar slides in. */
export const PEEK_DELAY_MS = 250;
/** The slide, in and out (the same in the stylesheet). */
export const PEEK_SLIDE_MS = 160;

/** "in": showing; "out": sliding away, still on screen for the length of the slide. */
export type PeekPhase = "off" | "in" | "out";

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The peek of a sidebar that is not shown in full (`away`: hidden, or compact): the full sidebar slides in over the chat
 * once the pointer has rested on the window's left edge or on the compact column, and goes again on `close` (the pointer
 * left it, Escape, a row was picked). Showing the sidebar in full (`away` false) ends it at once.
 */
export function usePeek(away: boolean) {
  const [phase, setPhase] = useState<PeekPhase>("off");
  const delay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => {
    clearTimeout(delay.current);
    clearTimeout(leaving.current);
  };

  /** The pointer rests on the edge: it opens after a moment, unless the pointer moves off again first. */
  const hover = useCallback(() => {
    clearTimeout(delay.current);
    delay.current = setTimeout(() => {
      clearTimeout(leaving.current);
      setPhase("in");
    }, PEEK_DELAY_MS);
  }, []);
  const unhover = useCallback(() => clearTimeout(delay.current), []);

  const close = useCallback(() => {
    clearTimeout(delay.current);
    setPhase((p) => (p === "in" ? "out" : p));
    clearTimeout(leaving.current);
    leaving.current = setTimeout(() => setPhase((p) => (p === "out" ? "off" : p)), reducedMotion() ? 0 : PEEK_SLIDE_MS);
  }, []);

  useEffect(() => {
    if (away) return;
    stop();
    setPhase("off");
  }, [away]);
  useEffect(() => stop, []);

  // Escape closes it.
  useEffect(() => {
    if (phase !== "in") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, close]);

  return { phase, hover, unhover, close };
}
