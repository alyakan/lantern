import { useEffect, useRef } from "react";
import type { PaletteEntry } from "./palette";

/**
 * Every action Lantern offers by name: the macOS menu bar, the keyboard shortcuts, the command palette and the cheat
 * sheet all read this list. Each line is one action, so src-tauri's tests can check the menu against it line by line.
 *
 * `key` (with `shift`) is the ⌘ shortcut. `menu`: the action is in the menu bar. `native`: the menu bar owns the key
 * (its accelerator runs the action even when the webview has focus); otherwise the webview's keydown does, and the menu
 * item shows the shortcut as its label. `skipInEditor`: while focus is in Monaco, the key is Monaco's (⌘/ comments,
 * ⌘K starts its chords), so the action doesn't run.
 */
const CATALOGUE = [
  { id: "new-session", title: "New Session", group: "File", key: "n", menu: true, native: true },
  { id: "open-folder", title: "Open Folder…", group: "File", key: "o", menu: true, native: true },
  // In the palette and the shortcut sheet only: no native menu item, so the webview's keydown runs it.
  { id: "relocate-folder", title: "Bring old sessions here…", group: "File", key: "r", shift: true },
  { id: "session-history", title: "Session History", group: "View", key: "k", menu: true, skipInEditor: true },
  { id: "find-file", title: "Find File…", group: "Search", key: "p", menu: true, native: true },
  { id: "search-files", title: "Search in Files…", group: "Search", key: "f", shift: true, menu: true, native: true },
  { id: "find-in-file", title: "Find in File", group: "Search", key: "f", menu: true },
  { id: "toggle-changes", title: "Toggle Changes Pane", group: "View", key: "\\", menu: true, native: true },
  { id: "command-palette", title: "Command Palette…", group: "View", key: "p", shift: true, menu: true, native: true },
  { id: "settings", title: "Settings…", group: "View", key: ",", menu: true, native: true },
  { id: "keyboard-shortcuts", title: "Keyboard Shortcuts", group: "Help", key: "/", menu: true, skipInEditor: true },
  { id: "report-bug", title: "Report a Bug…", group: "Help", menu: true },
  { id: "focus-input", title: "Focus the Message Box", group: "Chat", key: "l" },
  { id: "stop", title: "Stop Claude", group: "Chat", key: "." },
] as const satisfies readonly ActionDef[];

/** The catalogue, typed as plain entries (the ids are checked against the literal list above). */
export const ACTIONS: readonly ActionDef[] = CATALOGUE;

export type ActionGroup = "File" | "View" | "Search" | "Chat" | "Help" | "Mode" | "Harness" | "Settings";

export interface ActionDef {
  id: string;
  title: string;
  group: ActionGroup;
  key?: string;
  shift?: boolean;
  menu?: boolean;
  native?: boolean;
  skipInEditor?: boolean;
}

export type ActionId = (typeof CATALOGUE)[number]["id"];

/** The shortcut as macOS writes it: ⇧ before ⌘, the key in capitals. */
export function shortcutLabel(def: Pick<ActionDef, "key" | "shift">): string | null {
  if (!def.key) return null;
  return `${def.shift ? "⇧" : ""}⌘${def.key.length === 1 && /[a-z]/.test(def.key) ? def.key.toUpperCase() : def.key}`;
}

interface Handler {
  run: () => void;
  enabled: () => boolean;
}

// The components that own each action, in the order they mounted. The newest owner wins, so one action has one handler.
const owners = new Map<string, Handler[]>();

// Within this long, a second run of the same action is the same keystroke arriving twice (the webview's keydown and the
// menu's event), so it's dropped.
const SAME_RUN_MS = 150;
let lastRun = { id: "", at: 0 };

/** Runs an action if an owner has it enabled. True when it's enabled (so the key it came from is used up). */
export function runAction(id: string): boolean {
  const list = owners.get(id);
  const handler = list?.[list.length - 1];
  if (!handler?.enabled()) return false;
  const now = Date.now();
  if (lastRun.id === id && now - lastRun.at < SAME_RUN_MS) return true;
  lastRun = { id, at: now };
  handler.run();
  return true;
}

/** The catalogue action a ⌘ keystroke names, if any. Ctrl and Option keys are left to the page. */
export function actionForKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): ActionDef | undefined {
  if (!e.metaKey || e.ctrlKey || e.altKey) return undefined;
  const key = e.key.toLowerCase();
  return ACTIONS.find((a) => a.key === key && !!a.shift === !!e.shiftKey);
}

function onKeyDown(e: KeyboardEvent) {
  const def = actionForKey(e);
  if (!def) return;
  if (def.skipInEditor && document.activeElement?.closest(".monaco-editor")) return;
  if (runAction(def.id)) e.preventDefault();
}

let listening = false;

/**
 * Makes an action available while the calling component is mounted: `run` when its shortcut or menu item is chosen,
 * and only while `enabled`. The latest `run` and `enabled` are the ones used, so no effect needs to re-register it.
 */
export function useAction(id: ActionId, run: () => void, enabled = true): void {
  const latest = useRef({ run, enabled });
  latest.current = { run, enabled };
  useEffect(() => {
    if (!listening) {
      listening = true;
      window.addEventListener("keydown", onKeyDown);
    }
    const handler: Handler = { run: () => latest.current.run(), enabled: () => latest.current.enabled };
    const list = owners.get(id) ?? [];
    owners.set(id, [...list, handler]);
    return () => {
      const rest = (owners.get(id) ?? []).filter((h) => h !== handler);
      if (rest.length) owners.set(id, rest);
      else owners.delete(id);
    };
  }, [id]);
}

/** The actions that can run now, with their shortcuts, for the palette. */
export function availableActions(): PaletteEntry[] {
  return ACTIONS.flatMap((def) => {
    const list = owners.get(def.id);
    const handler = list?.[list.length - 1];
    if (!handler?.enabled()) return [];
    return [{ id: def.id, title: def.title, group: def.group, shortcut: shortcutLabel(def), run: () => runAction(def.id) }];
  });
}

/** The catalogue entry for a shortcut of a component (`useShortcut`), by its key. */
export function actionIdForKey(key: string, shift = false): ActionId {
  const def = ACTIONS.find((a) => a.key === key && !!a.shift === shift);
  if (!def) throw new Error(`No action has the shortcut ${shortcutLabel({ key, shift })}`);
  return def.id as ActionId;
}

/** Test support: forgets every owner and the last run. */
export function resetActionsForTest(): void {
  owners.clear();
  lastRun = { id: "", at: 0 };
}
