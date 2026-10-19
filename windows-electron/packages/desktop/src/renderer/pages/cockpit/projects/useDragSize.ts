/**
 * A drag handle that resizes one element and remembers the size. While the
 * pointer moves, the size is written straight to the element's style once per
 * frame (no React render per move); React state and localStorage are updated
 * when the drag ends.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Options = {
  storageKey: string;
  initial: number;
  min: number;
  /** Upper bound in px, read at drag time (it can depend on the window size). */
  max: () => number;
  axis: 'x' | 'y';
  /** True when dragging towards smaller coordinates grows the element (a panel on the right edge). */
  invert?: boolean;
  onDragChange?: (dragging: boolean) => void;
};

const readStored = (key: string, fallback: number): number => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export function useDragSize<T extends HTMLElement>({
  storageKey,
  initial,
  min,
  max,
  axis,
  invert,
  onDragChange,
}: Options) {
  const [size, setSize] = useState(() => readStored(storageKey, initial));
  const targetRef = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const clamp = useCallback(
    (value: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max()))),
    [min, max]
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !targetRef.current) return;
      event.preventDefault();
      const el = targetRef.current;
      const start = axis === 'x' ? event.clientX : event.clientY;
      const startSize = axis === 'x' ? el.offsetWidth : el.offsetHeight;
      const prop = axis === 'x' ? 'width' : 'height';
      let next = startSize;
      let frame = 0;
      const body = document.body.style;
      const previous = { cursor: body.cursor, userSelect: body.userSelect };
      body.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      body.userSelect = 'none';
      onDragChange?.(true);

      const move = (e: PointerEvent) => {
        const delta = (axis === 'x' ? e.clientX : e.clientY) - start;
        next = clamp(startSize + (invert ? -delta : delta));
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          el.style[prop] = `${next}px`;
        });
      };
      const up = () => {
        cleanup.current?.();
        el.style[prop] = `${next}px`;
        setSize(next);
        try {
          localStorage.setItem(storageKey, String(next));
        } catch {
          /* noop */
        }
        onDragChange?.(false);
      };
      cleanup.current = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        body.cursor = previous.cursor;
        body.userSelect = previous.userSelect;
        cleanup.current = null;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [axis, clamp, invert, onDragChange, storageKey]
  );

  return { size, targetRef, onPointerDown };
}
