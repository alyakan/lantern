import { useRef } from "react";
import { useWindowDimensions } from "react-native";
import { layoutAfter, type Layout } from "../view/layout";

/** The layout for the window as it is now: it follows rotating and resizing (Split View, Slide Over, Stage Manager). */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const last = useRef<Layout | null>(null);
  last.current = layoutAfter(last.current, width, height);
  return last.current;
}
