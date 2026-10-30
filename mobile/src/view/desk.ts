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
  | { kind: "failed"; why: string };

export interface DeskEntry {
  id: string;
  desk: string;
  at: number;
  text: string;
  outcome: DeskOutcome;
  /** Only the start of a long message was kept on the phone: it can't be sent from here again. */
  cut?: boolean;
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

/** An entry as it is kept on the phone: a long message only in part, marked so. */
export function toKeep(e: DeskEntry): DeskEntry {
  return e.text.length > TEXT_KEPT ? { ...e, text: e.text.slice(0, TEXT_KEPT), cut: true } : e;
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
    .slice(-LOG_MAX);
}
