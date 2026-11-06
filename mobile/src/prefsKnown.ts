/**
 * What the phone's prefs said when last read or written, while the app is open (prefs.ts fills it): a screen drawn again starts
 * as it was left, instead of on the default and then jumping to what was kept (Home went Recent, then Projects, every time it
 * came back, with its folded cards flashing open).
 */
import type { Tab } from "./prefs";
import type { Grouping } from "./view/home";

export const known: { grouping?: Grouping; folded?: string[]; tab?: Tab } = {};

/** For tests: forgets what was read. */
export function resetKnown() {
  delete known.grouping;
  delete known.folded;
  delete known.tab;
}
