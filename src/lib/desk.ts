/**
 * The Desk: one place that shows every open chat at once. What each chat is doing now (a line for each one working or
 * waiting on you), and a card for each answer that finished: what you said, in which chat, and the start of what Claude
 * answered. It is read from what the chats already hold; nothing here asks Claude anything.
 */

import type { State } from "../store";
import { chatState, type Chats } from "../sessions";
import { projectLabels, type ProjectOpen } from "./sidebar";
import { workflowOf } from "./workflow";
import type { ChatHit } from "../types";

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

/** Markdown's marks left out of a card's plain line: headings, emphasis, code ticks, link targets; a list's items keep a bullet, so they don't run together. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "• ")
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

/** A chat as the Desk's router is shown it (see desk.rs): never more than its name, project, settings and last line. */
export interface RouteCandidate {
  id: string;
  title: string;
  project: string;
  workflow: string;
  status: "working" | "waiting" | "idle";
  last: string;
}

/** The chats a Desk's message may go to, the ones last active first (the router's "ask" falls back to the first few). */
export function routeCandidates(chats: Chats, open: Record<string, ProjectOpen>): RouteCandidate[] {
  return deskChats(open)
    .map((c) => {
      const s = chats.slots[c.slot];
      if (!s || !s.folder) return null;
      const state = chatState(s);
      // What it was last asked and answered (its newest card), never the post-hook's reply.
      const cards = cardsOf(c.slot, c.title, c.where, s);
      const card = cards[cards.length - 1];
      const last = card ? clip(`Asked: ${card.asked}${card.said ? ` Answered: ${card.said}` : ""}`, 200) : "";
      return { at: s.activityAt ?? 0, c: { id: c.slot, title: c.title, project: c.where.split(" · ")[0], workflow: workflowOf(s), status: state === "waiting" ? "waiting" : state === "running" ? "working" : "idle", last } as RouteCandidate };
    })
    .filter((x): x is { at: number; c: RouteCandidate } => x !== null)
    .sort((a, b) => b.at - a.at)
    .map((x) => x.c);
}

/** What happened to a message typed on the Desk. */
export type DeskOutcome =
  | { kind: "routing" }
  /** Sent to a chat (`started`: a new one; `queued`: behind the turn it was working on). */
  | { kind: "sent"; slot: string; title: string; started: boolean; queued: boolean }
  /** The router couldn't tell (or couldn't be asked): the user picks a chat, or a project to start one in. */
  | { kind: "ask"; chats: { slot: string; title: string; where: string }[]; projects: { folder: string; label: string }[]; unsure: boolean }
  /** `hits`: null while it looks, "failed" when it couldn't; found once and kept with the message. */
  | { kind: "search"; terms: string; hits: ChatHit[] | null | "failed" }
  | { kind: "failed"; why: string };

/** A message typed on the Desk, with where it went. `also`: the chats it was sent to as well, by the user, after. */
export interface DeskEntry {
  id: string;
  /** The Desk it was typed on. */
  desk: string;
  at: number;
  text: string;
  outcome: DeskOutcome;
  also: { slot: string; title: string }[];
}

/** How many Desk messages are kept (the newest). */
export const LOG_MAX = 50;

/** The Desk's messages read back from storage: a message left "routing" when the app closed is said to have gone nowhere. */
export function readLog(raw: unknown): DeskEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is DeskEntry => !!e && typeof e === "object" && typeof (e as DeskEntry).id === "string" && typeof (e as DeskEntry).text === "string" && typeof (e as DeskEntry).at === "number" && !!(e as DeskEntry).outcome)
    .map((e) => ({ ...e, desk: typeof e.desk === "string" ? e.desk : "home", also: Array.isArray(e.also) ? e.also : [], outcome: e.outcome.kind === "routing" ? { kind: "failed" as const, why: "Lantern closed before it was sent anywhere." } : e.outcome.kind === "search" && !Array.isArray(e.outcome.hits) ? { ...e.outcome, hits: "failed" as const } : e.outcome }))
    .slice(-LOG_MAX);
}
