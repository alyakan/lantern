/**
 * The Desk as a board: an inbox with a row for every open chat (its last message, newest first, the unread ones marked) and a
 * table with a row for every project on the Desk. All of it is read from what the window already holds: nothing here asks
 * Claude anything, so nothing on the board is a guess.
 */

import type { State } from "../store";
import { chatState, type Chats } from "../sessions";
import { clip, doing, plain } from "./desk";
import { projectLabels, type ProjectOpen } from "./sidebar";
import type { TodoCount } from "./todos";
import { WORKFLOW_LABEL, workflowOf } from "./workflow";

/** Where a chat stands, as its inbox row says it. */
export type RowState = "working" | "waiting" | "done" | "asleep";

/** One open chat (or a team's Lead), as the Desk's inbox lists it. */
export interface InboxRow {
  slot: string;
  title: string;
  folder: string;
  /** The project's name, with the team's after it for a team's Lead. */
  where: string;
  /** Chat, Step by step or Team. */
  workflow: string;
  state: RowState;
  /** It finished while you were elsewhere and you haven't opened it since (the sidebar's blue dot). */
  unread: boolean;
  /** When something last happened in it (ms), when known. */
  at: number | null;
  /** Its last message, on one line: what it is doing while it works, else the start of what Claude last said. */
  line: string;
}

/** How much of a chat's last message its row shows. */
export const LINE_CHARS = 160;

/**
 * Claude's last words in a chat's last turn, on one line, or what was asked when it said nothing yet. What it said to the
 * post-hook ("Nothing new to save") isn't the answer: the words before the hook are.
 */
function lastLine(s: State): string {
  let said: string | null = null;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.type === "assistant" && it.text.trim()) said ??= it.text;
    else if (it.type === "hook") said = null;
    else if (it.type === "user") return clip(said !== null ? plain(said) : it.text, LINE_CHARS);
  }
  return said !== null ? clip(plain(said), LINE_CHARS) : "";
}

// Each chat's last line, kept while its state is the same object: the Desk draws again with every streamed event of every chat.
const lines = new WeakMap<State, string>();
function lineOf(s: State): string {
  let line = lines.get(s);
  if (line === undefined) {
    line = lastLine(s);
    lines.set(s, line);
  }
  return line;
}

/** Every chat open on the Desk (`open`: its projects only), the one where something happened last first. */
export function deskInbox(chats: Chats, open: Record<string, ProjectOpen>): InboxRow[] {
  const folders = Object.keys(open);
  const labels = projectLabels(folders);
  const rows = folders.flatMap((folder, i) =>
    open[folder].items.flatMap((item): InboxRow[] => {
      const s = chats.slots[item.slot];
      if (!s) return [];
      const asleep = s.status === "asleep";
      const st = chatState(s);
      const state: RowState = st === "waiting" ? "waiting" : asleep ? "asleep" : st === "running" ? "working" : "done";
      return [
        {
          slot: item.slot,
          title: item.title,
          folder,
          where: item.kind === "team" ? `${labels[i]} · team` : labels[i],
          workflow: WORKFLOW_LABEL[workflowOf(s)],
          state,
          unread: item.unread || item.kind === "team" && item.agents.some((a) => a.unread),
          at: s.activityAt,
          line: state === "working" ? doing(s) : lineOf(s),
        },
      ];
    }),
  );
  return rows.sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
}

/** A project on the Desk, as its table's row says it: only what Lantern knows for sure. */
export interface ProjectRow {
  folder: string;
  label: string;
  chats: number;
  working: number;
  waiting: number;
  asleep: number;
  unread: number;
  /** Chats, agents, merges and failed checks waiting on you here. */
  needs: number;
  /** When something last happened in any of its chats (ms), when known. */
  at: number | null;
  /** Its to-do list's open and overdue counts, once read. */
  todos: TodoCount | null;
}

/**
 * One row for each project on the Desk: the ones open on it (`open`), counted from the inbox's rows, and the ones only given to
 * it (`folders`), with nothing open. The ones that need you first, then the last active.
 */
export function deskProjects(rows: InboxRow[], open: Record<string, ProjectOpen>, folders: string[], todos: Record<string, TodoCount>, needs: Record<string, number> = {}): ProjectRow[] {
  const all = [...new Set([...Object.keys(open), ...folders])];
  const labels = projectLabels(all);
  return all
    .map((folder, i): ProjectRow => {
      const mine = rows.filter((r) => r.folder === folder);
      const count = (state: RowState) => mine.filter((r) => r.state === state).length;
      const at = mine.reduce<number | null>((max, r) => (r.at !== null && (max === null || r.at > max) ? r.at : max), null);
      return { folder, label: labels[i], chats: mine.length, working: count("working"), waiting: count("waiting"), asleep: count("asleep"), unread: mine.filter((r) => r.unread).length, needs: needs[folder] ?? 0, at, todos: todos[folder] ?? null };
    })
    .sort((a, b) => b.needs - a.needs || (b.at ?? -1) - (a.at ?? -1));
}
