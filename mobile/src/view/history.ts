/**
 * A tablet's Timeline, as the Mac's sidebar has it: what happened in the chats, newest first. A chat waiting on you or working
 * now is at the top; under it each answer that finished, under the day it finished. Read from what the Mac already sends: the
 * chats' list and the Desk's finished answers.
 */
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteDesk } from "../protocol/generated/RemoteDesk";
import { finished, firstSentence } from "./desk";

export type HistoryKind = "waiting" | "working" | "done" | "failed" | "stopped";

export interface HistoryEvent {
  key: string;
  slot: string;
  title: string;
  project: string | null;
  /** When it happened (ms): when what was finished was asked, or since when a chat works or waits. */
  at: number | null;
  kind: HistoryKind;
  /** On one line: what Claude said, what it is doing, or that it needs you. */
  line: string;
}

/** The most entries listed. */
export const MAX_EVENTS = 120;

const live = (k: HistoryKind) => k === "waiting" || k === "working";
const kindOf = (outcome: string): HistoryKind => (outcome === "failed" ? "failed" : outcome === "stopped" ? "stopped" : "done");

/** Every chat's events, newest first, what is going on now before the rest; only one project's while the Mac shows one (`only`). */
export function historyEvents(chats: RemoteChat[], desk: RemoteDesk | null, workingSince: Record<string, number>, only: string | null = null): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const c of chats) {
    if (only !== null && c.project !== only) continue;
    if (c.status !== "needs_you" && c.status !== "working") continue;
    const waiting = c.status === "needs_you";
    out.push({ key: `${c.slot}:now`, slot: c.slot, title: c.title ?? "New chat", project: c.project, at: waiting ? c.active_at : (workingSince[c.slot] ?? c.active_at), kind: waiting ? "waiting" : "working", line: waiting ? "Needs you" : (c.preview ?? "Working") });
  }
  const cards = desk ? desk.desks.flatMap((d) => finished(desk, d.id, [])) : [];
  for (const card of cards) {
    if (only !== null && card.project !== only) continue;
    out.push({ key: card.key, slot: card.slot, title: card.title, project: card.project, at: card.at, kind: kindOf(card.outcome), line: card.said ? firstSentence(card.said) : card.asked });
  }
  // What needs you first, then what works, then what finished; newest first within each.
  const rank = (k: HistoryKind) => (k === "waiting" ? 2 : k === "working" ? 1 : 0);
  return out.sort((a, b) => rank(b.kind) - rank(a.kind) || (b.at ?? -1) - (a.at ?? -1)).slice(0, MAX_EVENTS);
}

/** Where an entry goes: Now for what is going on, then Today, Yesterday, or its day. One whose time isn't known goes under Earlier. */
export function dayOf(e: HistoryEvent, now: number): string {
  if (live(e.kind)) return "Now";
  if (e.at === null) return "Earlier";
  const day = (t: number) => new Date(t).toDateString();
  if (day(e.at) === day(now)) return "Today";
  if (day(e.at) === day(now - 24 * 60 * 60_000)) return "Yesterday";
  return new Date(e.at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

/** The events under their days, in order. */
export function byDay(events: HistoryEvent[], now: number): { day: string; events: HistoryEvent[] }[] {
  const days: { day: string; events: HistoryEvent[] }[] = [];
  for (const e of events) {
    const day = dayOf(e, now);
    if (days[days.length - 1]?.day !== day) days.push({ day, events: [] });
    days[days.length - 1].events.push(e);
  }
  return days;
}
