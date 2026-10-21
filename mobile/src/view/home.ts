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

export interface Row {
  slot: string;
  title: string;
  project: string;
  /** The first letter of the title, for the tile. */
  initial: string;
  status: RemoteChat["status"];
  /** What is said at the right: "Asleep", "4 min", "Needs you", "Stopped"; null while working (a moving bar shows). */
  note: string | null;
}

const STATUS_NOTE: Record<RemoteChat["status"], (c: RemoteChat, now: number) => string | null> = {
  needs_you: () => "Needs you",
  working: () => null,
  idle: (c, now) => ago(c.active_at, now),
  asleep: () => "Asleep",
  ended: () => "Stopped",
};

/** Every chat as a row, the most recently active first. */
export function rows(chats: RemoteChat[], now: number): Row[] {
  return [...chats]
    .sort((a, b) => b.active_at - a.active_at)
    .map((c) => {
      const title = c.title?.trim() || "New chat";
      return { slot: c.slot, title, project: c.project ?? "", initial: ([...title][0] ?? "?").toUpperCase(), status: c.status, note: STATUS_NOTE[c.status](c, now) };
    });
}

/** A tile colour from the title, one of a few soft pairs (background, letter), the same for the same title every time. */
const TILES: [string, string][] = [
  ["#dfe7ff", "#2f5bff"],
  ["#e3f3e8", "#1f9d55"],
  ["#fff1c7", "#8a6300"],
  ["#f3e3f0", "#9b2f86"],
  ["#e1f1f4", "#1b7385"],
];
export function tileColors(title: string): [string, string] {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length];
}
