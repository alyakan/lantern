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
import { deskOf, HOME_ID, openOn, type Desks } from "./desks";

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
  return turns(slot, title, where, s).map((t) => t.card);
}

/** A finished turn: its card, and the whole of what started it and of Claude's last words, for the Desk's reply to a message. */
interface Turn {
  card: DeskCard;
  asked: string;
  said: string;
}

function turns(slot: string, title: string, where: string, s: State): Turn[] {
  const out: Turn[] = [];
  let start: Extract<State["items"][number], { type: "user" }> | null = null;
  let said = "";
  const close = (key: string, outcome: DeskCard["outcome"]) => {
    if (start) out.push({ card: { key: `${slot}:${key}`, slot, title, where, at: start.at ?? null, asked: clip(start.text, ASKED_CHARS), auto: !!start.auto, said: clip(plain(said), SAID_CHARS), outcome }, asked: start.text, said });
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
  return out;
}

/** How long before a Desk message was logged its turn may say it started (clocks and the order of state updates). */
const REPLY_SLACK_MS = 5_000;

/**
 * The turn a message sent from the Desk started in a chat, once it finished: the first turn there since the message, whose
 * opening message holds the message's words (a queued message goes with the others queued, joined; Lantern may add notes).
 * Null while it hasn't finished, or when no turn in that chat is it.
 */
export function replyOf(slot: string, s: State, text: string, at: number): { key: string; said: string; outcome: DeskCard["outcome"] } | null {
  const turn = turns(slot, "", "", s).find((t) => !t.card.auto && (t.card.at ?? 0) >= at - REPLY_SLACK_MS && carries(t.asked, text));
  return turn ? { key: turn.card.key, said: turn.said, outcome: turn.card.outcome } : null;
}

/**
 * Whether a turn's opening message is the Desk's message: the whole of it, after any notes Lantern put first, or one whole
 * part of messages queued together (joined by a blank line). Never a few of its words inside something else ("yes" in "yes,
 * and also…" typed in the chat).
 */
function carries(asked: string, text: string): boolean {
  const words = text.trim();
  const own = asked.replace(/^(?:\[Lantern:[\s\S]*?\]\n\n)+/, "").trim();
  return own === words || own.startsWith(`${words}\n\n`) || own.endsWith(`\n\n${words}`) || own.includes(`\n\n${words}\n\n`);
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

/**
 * The chats a Desk's message may go to, the ones last active first (the router's "ask" falls back to the first few). A chat that
 * runs on another provider than Claude (`offClaude`) is shown by its project only: nothing said in it is put to Claude.
 */
export function routeCandidates(chats: Chats, open: Record<string, ProjectOpen>, offClaude: (slot: string) => boolean = () => false): RouteCandidate[] {
  return deskChats(open)
    .map((c): { at: number; c: RouteCandidate } | null => {
      const s = chats.slots[c.slot];
      if (!s || !s.folder) return null;
      const state = chatState(s);
      const status: RouteCandidate["status"] = state === "waiting" ? "waiting" : state === "running" ? "working" : "idle";
      if (offClaude(c.slot)) return { at: s.activityAt ?? 0, c: { id: c.slot, title: "", project: c.where.split(" · ")[0], workflow: workflowOf(s), status, last: "" } };
      // What it was last asked and answered (its newest card), never the post-hook's reply.
      const cards = cardsOf(c.slot, c.title, c.where, s);
      const card = cards[cards.length - 1];
      const last = card ? clip(`Asked: ${card.asked}${card.said ? ` Answered: ${card.said}` : ""}`, 200) : "";
      return { at: s.activityAt ?? 0, c: { id: c.slot, title: c.title, project: c.where.split(" · ")[0], workflow: workflowOf(s), status, last } };
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
  /** The Desk's own answer, from the chats about `terms` (`hits`, found first, as for a search): `text` null while it is written. */
  | { kind: "answer"; terms: string; hits: ChatHit[] | null | "failed"; text: string | null; error?: string }
  /** The Desk only replied: nothing was sent anywhere. */
  | { kind: "talk" }
  | { kind: "failed"; why: string };

/**
 * What came back from the chat a Desk message was sent to: `waiting` until its turn finishes, then a short summary of Claude's
 * reply (`full`, the reply itself, for "Show full answer"). `off`: the chat runs on another provider, so nothing it said is
 * put to Claude to summarize.
 */
export type DeskReply =
  | { status: "waiting" }
  | { status: "summarizing"; key: string; full: string; outcome: DeskCard["outcome"] }
  | { status: "done"; key: string; full: string; outcome: DeskCard["outcome"]; summary: string }
  | { status: "failed"; key: string; full: string; outcome: DeskCard["outcome"]; why: string }
  | { status: "off"; key: string; outcome: DeskCard["outcome"] }
  /** Lantern restarted before the reply came: a chat may have its old place since, so it is never looked for again. */
  | { status: "lost" };

/** The most of a chat's reply kept with a Desk message, for "Show full answer". */
export const FULL_MAX = 8_000;

/** A message typed on the Desk, with where it went. `also`: the chats it was sent to as well, by the user, after. */
export interface DeskEntry {
  id: string;
  /** The Desk it was typed on. */
  desk: string;
  at: number;
  text: string;
  outcome: DeskOutcome;
  also: { slot: string; title: string }[];
  /** What the Desk said back, as plain text (only shown to you). */
  say?: string;
  /** What came back from the chat it was sent to. Only messages sent since the Desk talks have one: older ones are never summarized. */
  reply?: DeskReply;
}

/** How many Desk messages are kept (the newest). */
export const LOG_MAX = 50;

/** The Desk's messages read back from storage: a message left "routing" when the app closed is said to have gone nowhere. */
export function readLog(raw: unknown): DeskEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is DeskEntry => !!e && typeof e === "object" && typeof (e as DeskEntry).id === "string" && typeof (e as DeskEntry).text === "string" && typeof (e as DeskEntry).at === "number" && !!(e as DeskEntry).outcome)
    .map((e) => ({ ...e, desk: typeof e.desk === "string" ? e.desk : "home", also: Array.isArray(e.also) ? e.also : [], say: typeof e.say === "string" ? e.say : undefined, reply: readReply(e.reply), outcome: e.outcome.kind === "routing" ? { kind: "failed" as const, why: "Lantern closed before it was sent anywhere." } : e.outcome.kind === "search" && !Array.isArray(e.outcome.hits) ? { ...e.outcome, hits: "failed" as const } : e.outcome.kind === "answer" && (!Array.isArray(e.outcome.hits) || (e.outcome.text === null && !e.outcome.error)) ? { ...e.outcome, hits: Array.isArray(e.outcome.hits) ? e.outcome.hits : ("failed" as const), error: e.outcome.error ?? "Lantern closed before it answered." } : e.outcome }))
    .slice(-LOG_MAX);
}

/**
 * A reply read back: one being summarized when the app closed is kept as failed (it isn't asked for again by itself), and one
 * still waiting is lost: after a restart a chat's place (its slot) may be another chat's, whose reply isn't this one.
 */
function readReply(r: unknown): DeskReply | undefined {
  if (!r || typeof r !== "object") return undefined;
  const reply = r as DeskReply;
  if (reply.status === "summarizing") return { status: "failed", key: reply.key, full: reply.full, outcome: reply.outcome, why: "Lantern closed before it summarized the reply." };
  if (reply.status === "waiting") return { status: "lost" };
  return ["done", "failed", "off", "lost"].includes(reply.status) ? reply : undefined;
}

/** An earlier exchange as the Desk is shown it (see desk.rs `Exchange`). */
export interface Exchange {
  you: string;
  desk: string;
}

/**
 * The Desk's last few exchanges on one Desk, for it to follow the conversation: your words, and what it said and did in a few
 * words. A chat that ran on another provider is named by nothing, and its reply is left out: nothing said there is put to Claude.
 */
export function deskHistory(entries: DeskEntry[], desk: string, offClaude: (slot: string) => boolean = () => false, max = 8): Exchange[] {
  return entries
    .filter((e) => e.desk === desk && e.outcome.kind !== "routing")
    .slice(-max)
    .map((e) => {
      const o = e.outcome;
      const off = o.kind === "sent" && offClaude(o.slot);
      const did =
        o.kind === "sent"
          ? `(${o.started ? "started a chat" : "sent to"}${off ? "" : ` "${o.title}"`}${e.reply?.status === "done" && !off ? `; it replied: ${e.reply.summary}` : ""})`
          : o.kind === "ask"
            ? "(asked which chat)"
            : o.kind === "search"
              ? `(looked for chats about "${o.terms}")`
              : o.kind === "answer"
                ? `(answered from the chats about "${o.terms}")`
                : o.kind === "failed"
                  ? "(not sent)"
                  : "";
      return { you: clip(e.text, 300), desk: clip([e.say ?? "", did].filter(Boolean).join(" "), 400) };
    });
}

/** What the window tells the backend of its Desks, for a phone's Desk (see remote/desk.rs). */
export interface WindowDesk {
  desks: { id: string; name: string; projects: { folder: string; label: string }[]; chats: RouteCandidate[] }[];
  cards: (DeskCard & { desk: string })[];
  /** The sessions that ran on another provider than Claude: the Desk's answer never reads them. */
  off_claude: string[];
}

/**
 * Every Desk: its projects (the ones open on it and the ones given to it), its chats as the router is shown them, and the feed's
 * cards, each with the Desk it is on.
 */
export function windowDesk(chats: Chats, open: Record<string, ProjectOpen>, desks: Desks, offClaude: (slot: string) => boolean = () => false, offClaudeSessions: string[] = []): WindowDesk {
  const folderOf = new Map(Object.entries(open).flatMap(([folder, p]) => p.items.map((item) => [item.slot, folder] as const)));
  return {
    desks: desks.list.map((d) => {
      const on = openOn(desks, d.id, open);
      const folders = [...new Set([...Object.keys(on), ...(d.id === HOME_ID ? [] : d.projects)])];
      const labels = projectLabels(folders);
      return { id: d.id, name: d.name, projects: folders.map((folder, i) => ({ folder, label: labels[i] })), chats: routeCandidates(chats, on, offClaude) };
    }),
    cards: deskFeed(chats, open).map((c) => ({ ...c, desk: deskOf(desks, folderOf.get(c.slot) ?? "") })),
    off_claude: offClaudeSessions,
  };
}

/** A part of the Desk's answer: what is done, what is left, what is stuck. */
export type AnswerPart = "done" | "open" | "blocked";

/** The Desk's answer laid out: one sentence that answers, then its points by part, in that order. */
export interface AnswerShape {
  lead: string;
  parts: { part: AnswerPart; points: string[] }[];
}

const PART_ORDER: AnswerPart[] = ["done", "open", "blocked"];
const PART_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(done|open|blocked)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const marks = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/**
 * The Desk's answer as the Desk asks Claude for it (one sentence, then `**Done**`, `**Open**`, `**Blocked**` with bullets), or
 * null when it isn't in that shape: then it is shown as it came.
 */
export function answerShape(text: string): AnswerShape | null {
  const lines = text.split(/\r?\n/);
  const lead: string[] = [];
  const found = new Map<AnswerPart, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const head = PART_HEAD.exec(line);
    if (head) {
      const part = head[1].toLowerCase() as AnswerPart;
      current = found.get(part) ?? [];
      found.set(part, current);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (!current) {
      if (bullet) return null;
      lead.push(line);
    } else if (bullet) current.push(marks(bullet[1]));
    // A line under a part that isn't a bullet carries on its last point.
    else if (current.length) current[current.length - 1] = marks(`${current[current.length - 1]} ${line}`);
    else current.push(marks(line));
  }
  const first = marks(lead.join(" "));
  if (!first) return null;
  const parts = PART_ORDER.filter((p) => found.get(p)?.some(Boolean)).map((part) => ({ part, points: found.get(part)!.filter(Boolean) }));
  // Just a sentence (the chats didn't tell) is a shape too; a long block of prose with no parts isn't.
  if (!parts.length && lead.length > 2) return null;
  return { lead: first, parts };
}
