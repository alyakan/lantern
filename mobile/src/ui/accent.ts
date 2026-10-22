import { createContext, useContext } from "react";
import { useColors } from "./theme";

/** The accent a regular (a monthly or yearly pledge) gets in place of the cobalt: a warm orange that still reads as text on paper and under white. */
export const EMBER = "#d9480f";
/** Ember on Night's page: the same orange, lighter, so it reads as text there. */
export const EMBER_NIGHT = "#ff7a3d";

/** Ember for a regular, or null for the palette's cobalt (which is lighter on Night). */
export const AccentContext = createContext<string | null>(null);

/** Whether this is a regular: their main buttons are Ember with white words. */
export const useRegular = () => useContext(AccentContext) === EMBER;

/** The colour of links and quiet actions ("Expand", "New ideas", the send button, the working bar). Cobalt, or Ember for a regular. */
export function useAccent(): string {
  const set = useContext(AccentContext);
  const colors = useColors();
  if (set === EMBER) return colors.isDark ? EMBER_NIGHT : EMBER;
  return set ?? colors.cobalt;
}
