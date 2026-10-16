import { createContext } from "react";
import { api } from "../api";

/**
 * What the user saved for a project, in Lantern's own settings: the lines run in each new worktree before its agent starts
 * (`npm ci`), and the command its Run button starts (`npm run dev`). The backend only ever runs these (it gets them from
 * here, see `pushProjectSetups`), never a line from a file in the project or from anything an agent wrote.
 */
export interface ProjectSetup {
  commands: string[];
  run: string;
}

/** Every project's setup, by its folder. */
export type SetupByFolder = Record<string, ProjectSetup>;

/** The saved setups, for the cards and headers that offer Run. */
export const ProjectSetupContext = createContext<SetupByFolder>({});

/** The most lines a setup has, and the longest line: the backend refuses more (see setup.rs). */
export const MAX_SETUP_LINES = 20;
export const MAX_SETUP_LINE = 2000;

/** The command a project's Run button starts, or null when it has none. */
export function runCommandOf(all: SetupByFolder, folder: string | null | undefined): string | null {
  return (folder && all[folder]?.run.trim()) || null;
}

/** What was typed in the box as lines: trimmed, blank ones left out. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Why these lines can't be saved, or null. The backend checks the same. */
export function problemWith(commands: string[], run: string): string | null {
  if (commands.length > MAX_SETUP_LINES) return `A setup has at most ${MAX_SETUP_LINES} lines.`;
  if ([...commands, run].some((l) => l.length > MAX_SETUP_LINE)) return `A line is longer than ${MAX_SETUP_LINE} characters.`;
  // A pasted line break would have been split into two lines already; this is a stray control character.
  if ([...commands, run].some((l) => /[\u0000-\u0008\u000a-\u001f\u007f]/.test(l))) return "A line has a control character in it.";
  return null;
}

/** Sends every saved setup to the backend: when the window starts, and whenever one is saved. */
export function pushProjectSetups(all: SetupByFolder): Promise<unknown> {
  return Promise.all(Object.entries(all).map(([folder, s]) => api.setProjectSetup(folder, s.commands, s.run.trim() || null).catch(() => {})));
}
