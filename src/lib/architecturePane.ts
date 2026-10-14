import { createContext, useContext } from "react";

/**
 * Brings the right pane's Architecture tab up: what the Overview page's map offers ("Open in the pane"). Null where there
 * is no pane to open (a chat with no folder, a test).
 */
export const ArchitecturePane = createContext<(() => void) | null>(null);

export const useArchitecturePane = () => useContext(ArchitecturePane);
