import { createContext, useContext } from "react";
import type { GuideKey } from "../components/ModeGuide";

/** Opens "How the modes work" on a mode's or flavour's page. Null where the app doesn't provide it (component tests). */
export const ModeGuideContext = createContext<((key: GuideKey) => void) | null>(null);
export const useModeGuide = () => useContext(ModeGuideContext);
