import { createContext, useContext } from "react";

/**
 * What a chat can ask of the right pane's Architecture tab: to come up ("Open in the pane" on the Overview's map), with a
 * box lit when one is named (a part's "On the map" chips), and what a box is called on the map (the pages name boxes by
 * id). Null where there is no pane to open (a chat with no folder, a test).
 */
export interface ArchitecturePaneControls {
  open: (box?: string) => void;
  label: (id: string) => string;
}

export const ArchitecturePane = createContext<ArchitecturePaneControls | null>(null);

export const useArchitecturePane = () => useContext(ArchitecturePane);
