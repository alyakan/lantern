import type { ReactNode } from "react";
import { COMPOSER_FILL, Glass } from "./Glass";
import { radius, space } from "./theme";

/** How far a floating bar's content is from the screen's top edge, below the status bar. */
export const TOP_BAR_GAP = 8;
/** The bar's own height, which a page that scrolls under it keeps its first row clear of until the bar has been measured. */
export const TOP_BAR_HEIGHT = 48;

/**
 * The bar across the top of Chats, the Desk and Your work (and a tablet's page header): one capsule of Liquid Glass (a solid card
 * with a shadow before iOS 26) held off the screen's sides, with room inside it all round. Its row goes inside; it has no padding of
 * its own to take away. A page that scrolls under it (Your work) draws it over the list, so the list blurs behind it and meets no
 * hard edge. It keeps the stronger fill the message box does: its words (the Mac's name, the switch) must read over the list.
 */
export function TopBar({ children }: { children: ReactNode }) {
  return (
    <Glass lift={0.08} fill={COMPOSER_FILL} style={{ marginHorizontal: space.lg, minHeight: TOP_BAR_HEIGHT, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: 6, justifyContent: "center" }}>
      {children}
    </Glass>
  );
}
