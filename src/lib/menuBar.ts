import { useEffect, useState } from "react";
import { api } from "../api";
import type { MenuBarChat, RecentFolder } from "../types";
import { basename } from "./diff";
import { readStored } from "./layout";
import type { ProjectOpen } from "./sidebar";

/** How much of the menu bar item shows: nothing, the lantern alone, or the lantern with a readout beside it. */
export type MenuBarMode = "off" | "icon" | "full";

/** What the panel that opens from the lantern has in it. */
export interface MenuBarPanelSections {
  memory: boolean;
  disk: boolean;
  chats: boolean;
  newChat: boolean;
}

export interface MenuBarSettings {
  mode: MenuBarMode;
  /** The readout shows memory used, and the lantern watches it. */
  ram: boolean;
  /** The readout shows free disk, and the lantern watches it. */
  disk: boolean;
  /** The lantern turns amber or red when what it watches runs low. */
  alerts: boolean;
  panel: MenuBarPanelSections;
}

export const MENU_BAR_DEFAULT: MenuBarSettings = { mode: "full", ram: true, disk: true, alerts: true, panel: { memory: true, disk: true, chats: true, newChat: true } };

/** Where it is saved (Settings → General → Menu bar): one value, read by the main window and by the panel. */
const KEY = "lantern.menuBar";
const CHANGED = "lantern-menu-bar";

const MODES: MenuBarMode[] = ["off", "icon", "full"];

/** What is saved, checked: anything unknown (storage is editable) falls back to the default for that part. */
export function readMenuBar(): MenuBarSettings {
  const saved = readStored<unknown>(KEY, null);
  const o = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const panel = o.panel && typeof o.panel === "object" ? (o.panel as Record<string, unknown>) : {};
  const d = MENU_BAR_DEFAULT;
  return {
    mode: MODES.includes(o.mode as MenuBarMode) ? (o.mode as MenuBarMode) : d.mode,
    ram: flag(o.ram, d.ram),
    disk: flag(o.disk, d.disk),
    alerts: flag(o.alerts, d.alerts),
    panel: { memory: flag(panel.memory, d.panel.memory), disk: flag(panel.disk, d.panel.disk), chats: flag(panel.chats, d.panel.chats), newChat: flag(panel.newChat, d.panel.newChat) },
  };
}

/** The part of the choice the backend needs: what the item shows and watches (the panel's sections are the page's own). */
export const backendConfig = (s: MenuBarSettings) => ({ mode: s.mode, ram: s.ram, disk: s.disk, alerts: s.alerts });

/** Tells the backend the choice, which is where the menu bar item is built. Done when the window starts and on every change. */
export function pushMenuBar(): Promise<void> {
  return api.setMenuBar(backendConfig(readMenuBar())).catch(() => {});
}

/** Saves a change and tells the backend and every window (the panel is another window: it hears of it through storage). */
export function setMenuBar(patch: Partial<Omit<MenuBarSettings, "panel">> & { panel?: Partial<MenuBarPanelSections> }): void {
  const now = readMenuBar();
  const next: MenuBarSettings = { ...now, ...patch, panel: { ...now.panel, ...patch.panel } };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
  void api.setMenuBar(backendConfig(next)).catch(() => {});
}

/** The choice, kept in step with every place that changes it, in this window or in the other one. */
export function useMenuBar(): MenuBarSettings {
  const [s, setS] = useState(readMenuBar);
  useEffect(() => {
    const sync = () => setS(readMenuBar());
    window.addEventListener(CHANGED, sync);
    // Another window of the app saved it: the browser tells this one through `storage`.
    const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && sync();
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return s;
}

/** Every open chat and team (its Lead) as the panel lists them: the sidebar's own rows, flattened, with their project's name. */
export function menuBarChats(open: Record<string, ProjectOpen>): MenuBarChat[] {
  // What needs you comes first here (the sidebar orders by recent activity instead); a stable sort keeps the rest as listed.
  return Object.entries(open).flatMap(([folder, project]) =>
    project.items
      .map((i) => ({ slot: i.slot, title: i.title, project: basename(folder), state: i.state, team: i.kind === "team" }))
      .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting")),
  );
}

/**
 * Whether the main window starts a chat the panel asked for: only in a project it knows (a recent one, or one with a chat open),
 * so nothing but what the user already works in can be named, whatever reached the window.
 */
export function knownProject(folder: string, recent: RecentFolder[], openFolders: (string | null)[]): boolean {
  return recent.some((f) => f.path === folder) || openFolders.includes(folder);
}

/** The longest first message the panel may start a chat with (the backend refuses more, and so does the main window). */
export const MENU_BAR_MAX_TEXT = 20_000;

/**
 * Whether the main window sends this as a new chat's first message: written, and not enormous. The backend checks it too, but
 * any window can emit the event the main window listens for, so the window that acts on it checks for itself.
 */
export function validChatText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0 && [...text].length <= MENU_BAR_MAX_TEXT;
}

/** "62%": a part of a whole, as a whole number. */
export const percent = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

/** The state of the lantern's worry: the same lines as the menu bar item draws (see menu_bar.rs). */
export const WARN_FREE_BYTES = 15_000_000_000;
export const CRITICAL_FREE_BYTES = 5_000_000_000;

export type Level = "ok" | "warn" | "critical";

/** How low free disk is: amber under 15 GB, red under 5 GB. */
export function diskLevel(free: number | null): Level {
  if (free === null) return "ok";
  return free < CRITICAL_FREE_BYTES ? "critical" : free < WARN_FREE_BYTES ? "warn" : "ok";
}

export function pressureLevel(pressure: "normal" | "warning" | "critical" | undefined): Level {
  return pressure === "critical" ? "critical" : pressure === "warning" ? "warn" : "ok";
}
