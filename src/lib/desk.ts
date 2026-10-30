/**
 * The Desk: one place that shows every open chat at once. What each chat is doing now (a line for each one working or
 * waiting on you), and a card for each answer that finished: what you said, in which chat, and the start of what Claude
 * answered. It is read from what the chats already hold; nothing here asks Claude anything.
 */

import type { State } from "../store";
import { chatState, type Chats } from "../sessions";
import { projectLabels, type ProjectOpen } from "./sidebar";

/** One answer that finished, in some chat. */
export interface DeskCard {
  /** The chat's slot and the turn's own key there. */
  key: string;
  slot: string;
  title: string;
  /** The project (and the team, for a team's Lead). */
  where: string;
  /** When what started it was sent (ms), when known. */
  at: number | null;
  /** What was said to start it, on one line: by you, or a note when Claude went on by itself. */
  asked: string;
  auto: boolean;
  /** The start of Claude's last words in the turn ("" when it said nothing). */
  said: string;
  outcome: "done" | "failed" | "stopped";
}

/** A chat working, or waiting on you, now. */
export interface DeskLive {
  slot: string;
  title: string;
  where: string;
  waiting: boolean;
  /** What it is doing, in a few words. */
  line: string;
}

/** How much of an answer a card shows, and of the message that started it. */
export const SAID_CHARS = 280;
export const ASKED_CHARS = 120;
/** The most cards the Desk keeps: the newest. */
export const MAX_CARDS = 60;

/** `text` on one line, cut at a word to at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Markdown's marks left out of a card's plain line: headings, emphasis, code ticks, link targets, list bullets. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "");
}

/** Every chat on the Desk: plain chats and teams' Leads (a team's agents are the Lead's business), with where each is. */
function deskChats(open: Record<string, ProjectOpen>): { slot: string; title: string; where: string }[] {
  const folders = Object.keys(open);
  const labels = projectLabels(folders);
  return folders.flatMap((folder, i) => open[folder].items.map((item) => ({ slot: item.slot, title: item.title, where: item.kind === "team" ? `${labels[i]} · team` : labels[i] })));
}

/**
 * A chat's finished turns, as cards: each from the message that started it up to its end. A turn ends at its `turn` item,
 * or (in a chat reopened from its transcript, which has none) where the post-hook starts, where the next message starts,
 * or at the end of a chat that isn't working.
 */
export function turnCards(slot: string, title: string, where: string, s: State): DeskCard[] {
  const cards: DeskCard[] = [];
  let start: Extract<State["items"][number], { type: "user" }> | null = null;
  let said = "";
  const close = (key: string, outcome: DeskCard["outcome"]) => {
    if (start) cards.push({ key: `${slot}:${key}`, slot, title, where, at: start.at ?? null, asked: clip(start.text, ASKED_CHARS), auto: !!start.auto, said: clip(plain(said), SAID_CHARS), outcome });
    start = null;
  };
  for (const it of s.items) {
    if (it.type === "user") {
      close(`end-${it.id}`, "done");
      start = it;
      said = "";
    } else if (it.type === "assistant" && it.text.trim()) said = it.text;
    else if (it.type === "hook") close(`end-${it.id}`, "done");
    else if (it.type === "turn") close(it.id, it.stopped ? "stopped" : it.isError ? "failed" : "done");
  }
  if (said && chatState(s) === "done") close("end", "done");
  return cards;
}

// Each chat's cards, kept while its state is the same object: the Desk draws again with every streamed event of every
// chat, and only the chats that changed are read again.
const cached = new WeakMap<State, { title: string; where: string; cards: DeskCard[] }>();
function cardsOf(slot: string, title: string, where: string, s: State): DeskCard[] {
  const hit = cached.get(s);
  if (hit && hit.title === title && hit.where === where) return hit.cards;
  const cards = turnCards(slot, title, where, s);
  cached.set(s, { title, where, cards });
  return cards;
}

/**
 * The Desk's feed: every open chat's finished answers, oldest first, the newest `MAX_CARDS`. One whose time isn't known
 * (a reopened chat's older turns) goes before the ones whose time is, in its chat's order.
 */
export function deskFeed(chats: Chats, open: Record<string, ProjectOpen>): DeskCard[] {
  const all = deskChats(open).flatMap((c) => {
    const s = chats.slots[c.slot];
    return s ? cardsOf(c.slot, c.title, c.where, s) : [];
  });
  const time = (c: DeskCard) => c.at ?? -1;
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => time(a.c) - time(b.c) || a.i - b.i)
    .map(({ c }) => c)
    .slice(-MAX_CARDS);
}

/** What a working chat is doing: the tool it is running ("Bash: npm test"), or "Working". */
function doing(s: State): string {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.type === "turn" || it.type === "user") break;
    if (it.type === "tool" && it.status === "running") return it.summary ? `${it.name}: ${clip(it.summary, 60)}` : it.name;
  }
  return s.status === "starting" ? "Starting…" : "Working";
}

/** The chats working or waiting on you now: the waiting ones first. */
export function deskLive(chats: Chats, open: Record<string, ProjectOpen>): DeskLive[] {
  const out: DeskLive[] = [];
  for (const c of deskChats(open)) {
    const s = chats.slots[c.slot];
    if (!s) continue;
    const state = chatState(s);
    if (state === "waiting") out.push({ ...c, waiting: true, line: "Needs you" });
    else if (state === "running") out.push({ ...c, waiting: false, line: doing(s) });
  }
  return out.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}
