/** What the Home screen says: its headline, its stack of cards, and each chat's row. */
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { Waiting } from "../protocol/generated/Waiting";
import { promptView, type PromptView } from "./prompts";

/** "2 things" and "waiting on you"; with nothing waiting, "Nothing" and "waiting on you". */
export function headline(waiting: number): { big: string; small: string } {
  if (waiting === 0) return { big: "Nothing", small: "waiting on you" };
  return { big: waiting === 1 ? "1 thing" : `${waiting} things`, small: "waiting on you" };
}

/** A relative time in a few words: "now", "4 min", "2 h", "3 days". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

export interface Card {
  waiting: Waiting;
  view: PromptView;
  /** "Release 0.1.53, in lantern" */
  from: string;
  chat: RemoteChat | undefined;
}

/** The stack, oldest first: each waiting prompt with what it says and the chat it is in. */
export function cards(waiting: Waiting[], chats: RemoteChat[]): Card[] {
  return [...waiting]
    .sort((a, b) => a.at - b.at)
    .map((w) => {
      const chat = chats.find((c) => c.slot === w.slot);
      const title = w.chat_title ?? chat?.title ?? "A chat";
      const project = chat?.project;
      return { waiting: w, view: promptView(w.tool_name, w.input), from: project ? `${title}, in ${project}` : title, chat };
    });
}

/** A colour the Mac sent for a project, if it is a plain "#rrggbb": what the phone shows is only ever that or nothing. */
export function projectColorOf(color: unknown): string | null {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

/** A project's colour as a quiet fill behind its name (the colour at about 15%), and the colour itself for the words; plain ones for a project the Mac gave no colour. */
export function projectTint(color: string | null, plain: { bg: string; fg: string } = { bg: "#dce2e8", fg: "#566272" }): { bg: string; fg: string } {
  return color ? { bg: `${color}26`, fg: color } : plain;
}

export interface Row {
  slot: string;
  title: string;
  project: string;
  /** The colour the Mac's window gives the project ("#rrggbb"), when it said. */
  projectColor: string | null;
  /** The first letter of the title, for the tile. */
  initial: string;
  status: RemoteChat["status"];
  /** When the chat was last active, for ordering groups. */
  activeAt: number;
  /** What is said at the right: "Asleep", "4 min", "Needs you", "Stopped"; null while working (a moving bar shows). */
  note: string | null;
  /** Claude has gone on in it since it was last shown on this phone, and it is waiting (not working, asleep or asking: those say so already). */
  unread: boolean;
  /** Where the chat stands in the list: 0 needs you, 1 working, 2 the rest (idle, asleep, stopped). */
  rank: number;
  /** What the chat is ordered by within its rank, newest first: when it started (working), else when it was last active. */
  sortAt: number;
  /** Pinned to the top of the list on this phone. */
  pinned?: boolean;
}

const STATUS_NOTE: Record<RemoteChat["status"], (c: RemoteChat, now: number) => string | null> = {
  needs_you: () => "Needs you",
  working: () => null,
  idle: (c, now) => ago(c.active_at, now),
  asleep: () => "Asleep",
  ended: () => "Stopped",
};

/** Whether a chat has something new: it is waiting, and has moved on since `seen` (where this phone last showed it; null while that isn't known). */
export function isUnread(c: RemoteChat, seen: Record<string, number> | null): boolean {
  return seen !== null && c.status === "idle" && c.active_at > (seen[c.slot] ?? 0);
}

const RANK: Record<RemoteChat["status"], number> = { needs_you: 0, working: 1, idle: 2, asleep: 2, ended: 2 };

/**
 * The list's order: what needs you first, then what is working, then the rest, each the newest first. A working chat is
 * ordered by when it started (`workingSince`), not by its last event, which moves all the time and would shuffle the list
 * under the finger while several work. Ties fall to the slot, so the order is always the same one.
 */
export function byOrder(a: Row, b: Row): number {
  // A pinned chat is at the top, whatever it is doing; the pinned ones are in the list's usual order among themselves.
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.rank - b.rank || b.sortAt - a.sortAt || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);
}

/** Every chat as a row, in the list's order (see `byOrder`). `workingSince` is when each working chat was first seen working. */
export function rows(chats: RemoteChat[], now: number, seen: Record<string, number> | null = null, workingSince: Record<string, number> = {}, pins: string[] = []): Row[] {
  return chats
    .map((c): Row => {
      const title = c.title?.trim() || "New chat";
      return { rank: RANK[c.status], sortAt: c.status === "working" ? workingSince[c.slot] ?? c.active_at : c.active_at, slot: c.slot, title, project: c.project ?? "", projectColor: projectColorOf(c.project_color), initial: ([...title][0] ?? "?").toUpperCase(), status: c.status, activeAt: c.active_at, note: STATUS_NOTE[c.status](c, now), unread: isUnread(c, seen), ...(pins.includes(c.slot) ? { pinned: true } : {}) };
    })
    .sort(byOrder);
}

/** How Home lists the chats: all of them, the most recent first, or under their project. */
export type Grouping = "recent" | "project";

export interface Group {
  /** The project's name; "" for chats with none. */
  project: string;
  rows: Row[];
  /** Where the card stands among the cards: 0 if a chat in it needs you, 1 if one is working, else 2. */
  rank: number;
  /** How many of them need you. */
  needsYou: number;
  /** How many of them are unread. */
  unread: number;
}

/** The projects by name, those with none last: the order the quiet ones stay in. */
const byName = (a: Group, b: Group) => (a.project === "" ? 1 : b.project === "" ? -1 : a.project.localeCompare(b.project, undefined, { sensitivity: "base" }) || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));

/**
 * The rows under their projects, in the list's order inside each. The projects follow what is in them: those with a chat that
 * needs you first, then those with one working, each the newest first (by the chat that put it there), and then the rest by
 * name (chats with no project last), so the quiet ones stay where they are however their chats move. Projects are told apart
 * by name, which is all a phone is told of a folder.
 */
export function groups(list: Row[]): Group[] {
  const byProject = new Map<string, Row[]>();
  for (const r of list) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  return [...byProject]
    .map(([project, rs]): Group => {
      const sorted = [...rs].sort(byOrder);
      return { project, rows: sorted, rank: sorted[0]?.rank ?? 2, needsYou: rs.filter((r) => r.status === "needs_you").length, unread: rs.filter((r) => r.unread).length };
    })
    .sort((a, b) => a.rank - b.rank || (a.rank < 2 ? b.rows[0].sortAt - a.rows[0].sortAt : 0) || byName(a, b));
}
