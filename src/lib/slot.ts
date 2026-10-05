import { createContext, useContext } from "react";

/** The chat on screen, for components that talk to the backend about it (diffs, file browsing). */
export const SlotContext = createContext("s1");

export const useSlot = () => useContext(SlotContext);
