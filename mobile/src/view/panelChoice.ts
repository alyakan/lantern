/**
 * Which panel each chat's sheet (or a tablet's pane) was left on: Changes, Artifacts or To-dos. A chat opened again shows the
 * one picked in it, not the one picked in the chat before. Kept in memory while the app runs, never on the phone: a Mac's
 * chats are numbered afresh when it restarts, so a kept one could land on another chat.
 */
import type { Panel } from "../screens/PanelMenu";

const panels = new Map<string, Panel>();

/** The panel picked in a chat; Changes when none was. */
export const panelOf = (slot: string | null | undefined): Panel => (slot ? (panels.get(slot) ?? "changes") : "changes");

export function keepPanel(slot: string | null | undefined, panel: Panel) {
  if (slot) panels.set(slot, panel);
}

/** For tests, and a phone unpaired from its Mac: forget every chat's panel. */
export function forgetPanels() {
  panels.clear();
}
