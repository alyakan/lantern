import { createContext, useContext } from "react";
import type { Mode } from "../types";

/** Opens "How the modes work" on a mode's page. Null where the app doesn't provide it (component tests). */
export const ModeGuideContext = createContext<((mode: Mode) => void) | null>(null);
export const useModeGuide = () => useContext(ModeGuideContext);
