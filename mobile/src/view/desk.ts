/**
 * The Desk on the phone: every open chat at once, as the Mac's Desk shows it (its cards come from the Mac), and a box whose
 * messages go to the right chat. Where a message goes is decided on the Mac (Request::DeskRoute); the phone sends it there itself,
 * as it would from the chat. What was typed here, and where it went, is kept on this phone.
 */
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import type { RemoteDeskCard } from "../protocol/generated/RemoteDeskCard";
import type { RemoteDeskHit } from "../protocol/generated/RemoteDeskHit";
import type { RemoteDeskInfo } from "../protocol/generated/RemoteDeskInfo";

/** What happened to a message typed on the Desk. */
export type DeskOutcome =
  | { kind: "routing" }
  /** Sent to a chat (`started`: a new one; `queued`: it was working, so it waits for its turn). */
  | { kind: "sent"; slot: string; title: string; started: boolean; queued: boolean }
  /** Which chat? The likeliest of the Desk's (`unsure`: a new chat is offered too). */
  | { kind: "ask"; slots: string[]; unsure: boolean }
  | { kind: "search"; terms: string; hits: RemoteDeskHit[]; failed: boolean }
  /** The Desk's own answer (Markdown citing `sources` as [1], [2]); "" with no sources: no chat talks about it. */
  | { kind: "answer"; terms: string; text: string; sources: RemoteDeskHit[]; error: string | null }
  /** The Desk only replied (a Mac whose Desk talks): nothing was sent anywhere. */
  | { kind: "talk" }
  | { kind: "failed"; why: string };

/**
 * What came back from the chat a Desk message went to (a Mac whose Desk talks): `waiting` until its turn finishes after the chat's
 * event `after`, then a sentence or two from the Mac. `full`, Claude's own words, is only kept until the app closes. `off`: the chat
 * runs on another provider, so the Mac doesn't read it. `lost`: the chat isn't the one it went to any more (the Mac restarted).
 */
export type DeskReply =
  | { status: "waiting"; after: number }
  | { status: "done"; failed: boolean; summary: string; full?: string }
  | { status: "failed"; why: string; full?: string }
  | { status: "off" }
  | { status: "lost" };

export interface DeskEntry {
  id: string;
  desk: string;
  at: number;
  text: string;
  outcome: DeskOutcome;
  /** Only the start of a long message was kept on the phone: it can't be sent from here again. */
  cut?: boolean;
  /** What the Desk said back, as plain text (a Mac whose Desk talks). */
  say?: string;
  reply?: DeskReply;
}

/** How many Desk messages the phone keeps (the newest), and how much of each. */
export const LOG_MAX = 30;
export const TEXT_KEPT = 2000;

/** One thing in the feed, in time order: a card from the Mac, or a message typed here. */
export type FeedItem = { kind: "card"; card: RemoteDeskCard } | { kind: "entry"; entry: DeskEntry };

/** The Desk on screen: the one chosen, else the first (home), else none (a Mac that hasn't said). */
export function deskShown(desk: RemoteDesk | null, chosen: string | null): RemoteDeskInfo | null {
  if (!desk || desk.desks.length === 0) return null;
  return desk.desks.find((d) => d.id === chosen) ?? desk.desks[0];
}

/**
 * The feed of one Desk: its cards and the messages typed on it, oldest first. A card whose time isn't known (a chat reopened on the
 * Mac) goes before the rest, in the Mac's order.
 */
export function deskFeed(desk: RemoteDesk | null, id: string, entries: DeskEntry[]): FeedItem[] {
  const cards: FeedItem[] = (desk?.cards ?? []).filter((c) => c.desk === id).map((card) => ({ kind: "card", card }));
  const typed: FeedItem[] = entries.filter((e) => e.desk === id).map((entry) => ({ kind: "entry", entry }));
  const time = (f: FeedItem) => (f.kind === "card" ? (f.card.at ?? -1) : f.entry.at);
  return [...cards, ...typed]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => time(a.f) - time(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

/** The Desk's chats working or waiting on you now, the waiting first, with what each is doing. */
export function deskLive(chats: RemoteChat[], slots: string[]): { chat: RemoteChat; waiting: boolean; line: string }[] {
  return chats
    .filter((c) => slots.includes(c.slot) && (c.status === "working" || c.status === "needs_you"))
    .map((chat) => ({ chat, waiting: chat.status === "needs_you", line: chat.status === "needs_you" ? "Needs you" : (chat.preview ?? "Working") }))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

/** How many chats wait on you on each Desk (the tabs say it for the Desks not on screen). */
export function waitingBy(desk: RemoteDesk | null, chats: RemoteChat[]): Record<string, number> {
  const waiting = new Set(chats.filter((c) => c.status === "needs_you").map((c) => c.slot));
  return Object.fromEntries((desk?.desks ?? []).map((d) => [d.id, d.slots.filter((s) => waiting.has(s)).length]));
}

/** A chat's name as the Desk says it. */
export const chatName = (chats: RemoteChat[], slot: string) => chats.find((c) => c.slot === slot)?.title ?? "A chat";

/** Why a message can't go to this chat now, or null: it is closed, asleep or stopped. */
export function cantSend(chat: RemoteChat | undefined): string | null {
  if (!chat) return "That chat is closed.";
  if (chat.status === "asleep") return "That chat is asleep. Open it to wake it, then send it again.";
  if (chat.status === "ended") return "That chat has stopped.";
  return null;
}

/** `text` on one line, cut at a word to at most `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** An entry as it is kept on the phone: a long message only in part, marked so, and a reply without Claude's whole words. */
export function toKeep(e: DeskEntry): DeskEntry {
  const reply = e.reply && "full" in e.reply ? (({ full: _full, ...rest }) => rest)(e.reply) : e.reply;
  const kept = { ...e, ...(reply ? { reply } : {}) };
  return kept.text.length > TEXT_KEPT ? { ...kept, text: kept.text.slice(0, TEXT_KEPT), cut: true } : kept;
}

/** How many earlier exchanges the Desk is told of. */
export const HISTORY_MAX = 8;

/**
 * The Desk's last few exchanges on one Desk, for it to follow the conversation: your words, and what it said and did in a few
 * words (what came back too). A chat on another provider is named by nothing: nothing said there is put to Claude.
 */
export function deskHistory(entries: DeskEntry[], desk: string, chats: RemoteChat[]): { you: string; desk: string }[] {
  const off = (slot: string) => !!chats.find((c) => c.slot === slot)?.provider;
  return entries
    .filter((e) => e.desk === desk && e.outcome.kind !== "routing")
    .slice(-HISTORY_MAX)
    .map((e) => {
      const o = e.outcome;
      const hidden = o.kind === "sent" && off(o.slot);
      const did =
        o.kind === "sent"
          ? `(${o.started ? "started a chat" : "sent to"}${hidden ? "" : ` "${o.title}"`}${e.reply?.status === "done" && !hidden ? `; it replied: ${e.reply.summary}` : ""})`
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

/** How long (ms) before a Desk message a card may say its turn started, for leaving it out of Just finished (the Mac's clock). */
const LINKED_SLACK_MS = 120_000;

/**
 * The Mac's cards of one Desk as Just finished lists them: newest first, without those that are the reply to a message typed
 * here (that shows under the message): same chat, at about the time or after, and opened by the message's words.
 */
export function finished(desk: RemoteDesk | null, id: string, entries: DeskEntry[]): RemoteDeskCard[] {
  const sent = entries.filter((e) => e.desk === id && e.reply && e.reply.status !== "lost" && e.outcome.kind === "sent");
  // A card's line is the start of its opening message, on one line (Lantern's notes may come first).
  const opens = (c: RemoteDeskCard, text: string) => c.asked.includes(clip(text, 80).replace(/…$/, ""));
  const linked = (c: RemoteDeskCard) => sent.some((e) => e.outcome.kind === "sent" && e.outcome.slot === c.slot && (c.at ?? 0) >= e.at - LINKED_SLACK_MS && opens(c, e.text));
  return (desk?.cards ?? [])
    .filter((c) => c.desk === id && !linked(c))
    .sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
}

/** The first sentence of what Claude said, or the first item of a list, for a finished answer's one line. */
export function firstSentence(said: string): string {
  const first = said.replace(/^\s*•\s*/, "").split(" • ")[0];
  const end = first.search(/[.!?](\s|$)/);
  return end > 0 && end < first.length - 1 ? first.slice(0, end + 1) : first;
}

/** The Desk's answer laid out: one sentence that answers, then its points by part (done, open, blocked), in that order. */
export type AnswerPart = "done" | "open" | "blocked";
export interface AnswerShape {
  lead: string;
  parts: { part: AnswerPart; points: string[] }[];
}

const PART_ORDER: AnswerPart[] = ["done", "open", "blocked"];
const PART_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(done|open|blocked)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const marks = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/**
 * The Desk's answer as the Mac asks Claude for it (one sentence, then `**Done**`, `**Open**`, `**Blocked**` with bullets), or null
 * when it isn't in that shape: then it is shown as it came. As the Mac's (src/lib/desk.ts answerShape).
 */
export function answerShape(text: string): AnswerShape | null {
  const lead: string[] = [];
  const found = new Map<AnswerPart, string[]>();
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
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
    else if (current.length) current[current.length - 1] = marks(`${current[current.length - 1]} ${line}`);
    else current.push(marks(line));
  }
  const first = marks(lead.join(" "));
  if (!first) return null;
  const parts = PART_ORDER.filter((p) => found.get(p)?.some(Boolean)).map((part) => ({ part, points: found.get(part)!.filter(Boolean) }));
  if (!parts.length && lead.length > 2) return null;
  return { lead: first, parts };
}

/**
 * The Desk's messages read back from the phone: anything malformed left out. One the app closed on before it went anywhere, or whose
 * question can't be answered now (only part of it was kept), says so.
 */
export function readEntries(raw: unknown): DeskEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is DeskEntry => !!e && typeof e === "object" && typeof e.id === "string" && typeof e.desk === "string" && typeof e.text === "string" && typeof e.at === "number" && !!e.outcome && typeof e.outcome.kind === "string")
    .map((e) => (e.outcome.kind === "routing" ? { ...e, outcome: { kind: "failed" as const, why: "Lantern closed before it was sent anywhere." } } : e.cut && e.outcome.kind === "ask" ? { ...e, outcome: { kind: "failed" as const, why: "Only the start of this message was kept. Send it again." } } : e))
    .map((e) => ({ ...e, say: typeof e.say === "string" ? e.say : undefined, reply: readReply(e.reply) }))
    .slice(-LOG_MAX);
}

function readReply(r: unknown): DeskReply | undefined {
  if (!r || typeof r !== "object") return undefined;
  const reply = r as DeskReply;
  if (reply.status === "waiting") return typeof reply.after === "number" ? reply : undefined;
  return ["done", "failed", "off", "lost"].includes(reply.status) ? reply : undefined;
}

/**
 * Whether to ask the Mac what came back for a message still waiting: the chat it went to has moved on past the message and isn't
 * working any more. `lost` when that chat's events start over below where the message was sent (the Mac restarted: the place may
 * be another chat's now).
 */
export function replyCheck(reply: DeskReply | undefined, chat: RemoteChat | undefined): "ask" | "wait" | "lost" {
  if (!reply || reply.status !== "waiting") return "wait";
  if (!chat) return "wait";
  if (chat.last_seq < reply.after) return "lost";
  return chat.last_seq > reply.after && (chat.status === "idle" || chat.status === "ended") ? "ask" : "wait";
}
