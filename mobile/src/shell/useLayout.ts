import { useWindowDimensions } from "react-native";
import { layoutFor, type Layout } from "../view/layout";

/** The layout for the window as it is now: it follows rotating and resizing (Split View, Slide Over). */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return layoutFor(width, height);
}
