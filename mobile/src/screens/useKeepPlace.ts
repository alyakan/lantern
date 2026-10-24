import { useCallback, useEffect, useRef, type RefObject } from "react";

/** The bits of the list this needs. */
export interface PlaceList {
  getFirstVisibleIndex: () => number;
  scrollToEnd: (p: { animated: boolean }) => void;
  scrollToIndex: (p: { index: number; animated: boolean }) => unknown;
}

/** When, after the width changed, the place is put back: the text re-wraps over a few frames, so it is done again as it settles. */
export const RESTORE_AT_MS = [80, 250, 600];
/** For this long after a width change, the list's own movement is not the reader's: the remembered place is left alone. */
export const FREEZE_MS = 700;

/**
 * Keeps the reader's place when the chat gets narrower or wider (the chats pinned beside it or put away, the tablet turned).
 * The list keeps its offset in points, but the text re-wraps to another height, so that same offset is other messages: a reader
 * at the bottom is suddenly far above it. This remembers the first message on screen, and whether the end was in view, and
 * once the width has changed puts that back.
 *
 * `remember(atEnd)` goes in the list's onScroll, `widthChanged(width)` in the onLayout of the view around the list.
 */
export function useKeepPlace(list: RefObject<PlaceList | null>) {
  // A chat opens at its end, so that is the place until the reader has moved.
  const place = useRef<{ index: number; atEnd: boolean }>({ index: 0, atEnd: true });
  const width = useRef<number | null>(null);
  const frozenUntil = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const remember = useCallback(
    (atEnd: boolean) => {
      if (Date.now() < frozenUntil.current) return;
      // (A list that can't say, such as the one in the screens' tests, leaves the last place as it was.)
      const first = list.current?.getFirstVisibleIndex?.();
      place.current = { index: typeof first === "number" && first >= 0 ? first : place.current.index, atEnd };
    },
    [list],
  );

  const widthChanged = useCallback(
    (now: number) => {
      const before = width.current;
      width.current = now;
      // The first layout is not a change, and a few points either way are not a re-wrap.
      if (before === null || Math.abs(before - now) < 1) return;
      const { index, atEnd } = place.current;
      frozenUntil.current = Date.now() + FREEZE_MS;
      timers.current.forEach(clearTimeout);
      timers.current = RESTORE_AT_MS.map((ms) =>
        setTimeout(() => {
          if (atEnd) list.current?.scrollToEnd({ animated: false });
          else void list.current?.scrollToIndex({ index, animated: false });
        }, ms),
      );
    },
    [list],
  );

  return { remember, widthChanged };
}
