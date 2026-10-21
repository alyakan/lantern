import { createContext, useContext } from "react";
import { colors } from "./theme";

/** The accent a regular (a monthly or yearly pledge) gets in place of the cobalt: a warm orange that still reads as text on paper and under white. */
export const EMBER = "#d9480f";

/** The colour of links and quiet actions ("Expand", "New ideas", the send button, the working bar). Cobalt, or Ember for a regular. */
export const AccentContext = createContext<string>(colors.cobalt);

export const useAccent = () => useContext(AccentContext);
