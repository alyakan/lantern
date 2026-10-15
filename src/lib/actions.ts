import { useEffect, useRef } from "react";
import { sentenceCase, type PaletteEntry } from "./palette";

/**
 * Every action Lantern offers by name: the macOS menu bar, the keyboard shortcuts, the command palette and the cheat
 * sheet all read this list. Each line is one action, so src-tauri's tests can check the menu against it line by line.
 *
 * `key` (with `shift`, and `ctrl` for ⌃⌘ ones) is the ⌘ shortcut. `menu`: the action is in the menu bar. `native`: the menu bar owns the key
 * (its accelerator runs the action even when the webview has focus); otherwise the webview's keydown does, and the menu
 * item shows the shortcut as its label. `skipInEditor`: while focus is in Monaco, the key is Monaco's (⌘/ comments,
 * ⌘K starts its chords), so the action doesn't run.
 */
const CATALOGUE = [
  { id: "new-session", title: "New Chat", group: "File", key: "n", menu: true, native: true },
  { id: "open-folder", title: "Open Folder…", group: "File", key: "o", menu: true, native: true },
  // In the palette (and the folder menu and a project's ⋯ menu): no shortcut and no native menu item.
  { id: "relocate-folder", title: "Bring old chats here…", group: "File" },
  // The left sidebar of every project, hidden or shown: macOS's own ⌃⌘S (⌘0 is the canvas's Fit). Collapsed is the slim
  // column of open chats; both say what they do now (Hide or Show, Collapse or Expand) in the palette and the menu.
  { id: "toggle-sidebar", title: "Hide Sidebar", group: "View", key: "s", ctrl: true, menu: true, native: true },
  // The title bar's inbox of what waits on you, across every project and team.
  { id: "show-inbox", title: "What Needs You…", group: "View" },
  { id: "toggle-compact", title: "Collapse Sidebar", group: "View", menu: true },
  // Only while there is a team: switches between its canvas and the chat view.
  { id: "toggle-canvas", title: "Switch Canvas and Chat View", group: "View", key: "c", shift: true },
  // Only while the canvas has focus (see Canvas.tsx).
  { id: "canvas-zoom-in", title: "Zoom In on the Canvas", group: "View", key: "=" },
  { id: "canvas-zoom-out", title: "Zoom Out on the Canvas", group: "View", key: "-" },
  { id: "canvas-fit", title: "Fit the Canvas to Everyone", group: "View", key: "0" },
  { id: "canvas-next-agent", title: "Next Agent on the Canvas", group: "View", key: "]" },
  { id: "canvas-previous-agent", title: "Previous Agent on the Canvas", group: "View", key: "[" },
  { id: "session-history", title: "Chat History", group: "View", key: "k", menu: true, skipInEditor: true },
  { id: "find-file", title: "Find File…", group: "Search", key: "p", menu: true, native: true },
  { id: "search-files", title: "Search in Files…", group: "Search", key: "f", shift: true, menu: true, native: true },
  { id: "find-in-file", title: "Find in File", group: "Search", key: "f", menu: true },
  { id: "toggle-changes", title: "Show/Hide Side Panel", group: "View", key: "\\", menu: true, native: true },
  { id: "command-palette", title: "Command Palette…", group: "View", key: "p", shift: true, menu: true, native: true },
  { id: "settings", title: "Settings…", group: "View", key: ",", menu: true, native: true },
  // Ways to start work (the Work menu): Build, Debug and Design are Step by step in that flavour, Review a PR lists the
  // open pull requests, and Start a team makes a chat a team's Lead.
  { id: "work-build", title: "Build", group: "Work", menu: true },
  { id: "work-review-pr", title: "Review a PR…", group: "Work", menu: true },
  { id: "work-debug", title: "Debug", group: "Work", menu: true },
  { id: "work-design", title: "Design", group: "Work", menu: true },
  { id: "work-team", title: "Start a Team", group: "Work", key: "n", shift: true, menu: true, native: true },
  { id: "keyboard-shortcuts", title: "Keyboard Shortcuts", group: "Help", key: "/", menu: true, skipInEditor: true },
  { id: "report-bug", title: "Report a Bug…", group: "Help", menu: true },
  { id: "focus-input", title: "Focus the Message Box", group: "Chat", key: "l" },
  { id: "stop", title: "Stop Claude", group: "Chat", key: "." },
] as const satisfies readonly ActionDef[];

/** The catalogue, typed as plain entries (the ids are checked against the literal list above). */
export const ACTIONS: readonly ActionDef[] = CATALOGUE;

export type ActionGroup = "File" | "View" | "Search" | "Chat" | "Work" | "Help" | "Mode" | "Models" | "Settings";

export interface ActionDef {
  id: string;
  title: string;
  group: ActionGroup;
  key?: string;
  shift?: boolean;
  /** ⌃ as well as ⌘. */
  ctrl?: boolean;
  menu?: boolean;
  native?: boolean;
  skipInEditor?: boolean;
}

export type ActionId = (typeof CATALOGUE)[number]["id"];

/** The shortcut as macOS writes it: ⌃ and ⇧ before ⌘, the key in capitals. */
export function shortcutLabel(def: Pick<ActionDef, "key" | "shift" | "ctrl">): string | null {
  if (!def.key) return null;
  return `${def.ctrl ? "⌃" : ""}${def.shift ? "⇧" : ""}⌘${def.key.length === 1 && /[a-z]/.test(def.key) ? def.key.toUpperCase() : def.key}`;
}

interface Handler {
  run: () => void;
  enabled: () => boolean;
  /** What the palette calls it now, when that changes (Hide Sidebar, then Show Sidebar). */
  title: () => string | undefined;
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

/** The catalogue action a ⌘ keystroke names, if any. Option keys are left to the page, and so is Ctrl unless the action is a ⌃⌘ one. */
export function actionForKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): ActionDef | undefined {
  if (!e.metaKey || e.altKey) return undefined;
  const key = e.key.toLowerCase();
  return ACTIONS.find((a) => a.key === key && !!a.shift === !!e.shiftKey && !!a.ctrl === !!e.ctrlKey);
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
 * and only while `enabled`. The latest `run`, `enabled` and `title` (the palette's wording, if it changes) are the ones used,
 * so no effect needs to re-register it.
 */
export function useAction(id: ActionId, run: () => void, enabled = true, title?: string): void {
  const latest = useRef({ run, enabled, title });
  latest.current = { run, enabled, title };
  useEffect(() => {
    if (!listening) {
      listening = true;
      window.addEventListener("keydown", onKeyDown);
    }
    const handler: Handler = { run: () => latest.current.run(), enabled: () => latest.current.enabled, title: () => latest.current.title };
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
    return [{ id: def.id, title: sentenceCase(handler.title() ?? def.title), group: def.group, shortcut: shortcutLabel(def), run: () => runAction(def.id) }];
  });
}

/** The catalogue entry for a shortcut of a component (`useShortcut`), by its key. */
export function actionIdForKey(key: string, shift = false): ActionId {
  const def = ACTIONS.find((a) => a.key === key && !!a.shift === shift && !a.ctrl);
  if (!def) throw new Error(`No action has the shortcut ${shortcutLabel({ key, shift })}`);
  return def.id as ActionId;
}

/** Test support: forgets every owner and the last run. */
export function resetActionsForTest(): void {
  owners.clear();
  lastRun = { id: "", at: 0 };
}
