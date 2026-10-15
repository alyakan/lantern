import { useFitMenu } from "./useFitMenu";
import { useMenuShift } from "./menuShift";

/**
 * Keeps an open dropdown from being cut off: sideways inside the column that clips it (or the window), and up or down
 * inside the window, capped to the room it has. Put `ref` and `style` on the menu's element; `deps` are what changes
 * its size (its contents loaded, another view of it).
 */
export function useMenuInside(open: boolean, deps: unknown[] = []) {
  const { ref, style } = useMenuShift(open, deps);
  // Measured again once the width is capped, since narrower rows can wrap and make it taller.
  useFitMenu(ref, [open, style?.maxWidth, ...deps]);
  return { ref, style };
}
