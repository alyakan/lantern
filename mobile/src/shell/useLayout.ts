import { useWindowDimensions } from "react-native";
import { layoutAfter, type Layout } from "../view/layout";

/** The layout last given: one for the whole app, so a screen drawn just now agrees with the rest near the phone's line. */
let last: Layout | null = null;

/** The layout for the window as it is now: it follows rotating and resizing (Split View, Slide Over, Stage Manager). */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  last = layoutAfter(last, width, height);
  return last;
}

/** Tests only: forget the layout last given. */
export function resetLayout() {
  last = null;
}
