/**
 * The sidebar's timeline: what happened in the open chats, one entry per event, newest first. A chat working or waiting on you
 * now is at the top; below it, each answer that finished, at the time it finished. Read from what the chats already hold.
 */

import type { State } from "../store";
import { chatState, type Chats } from "../sessions";
import { clip, doing, plain } from "./desk";
import type { InboxItem } from "./inbox";
import { projectLabels, type ProjectOpen } from "./sidebar";

export type TimelineKind = "waiting" | "working" | "done" | "failed" | "stopped";

export interface TimelineEvent {
  key: string;
  slot: string;
  /** The chat is a team's Lead: it opens on the team. */
  team: boolean;
  title: string;
  folder: string;
  where: string;
  /** When it happened (ms): when a turn finished, or since when a chat works or waits. */
  at: number;
  kind: TimelineKind;
  /** On one line: what Claude said, what it is doing, or what it needs. */
  line: string;
  /** The answer finished while you were elsewhere and you haven't opened the chat since. */
  unread: boolean;
}

/** How much of what was said an entry shows, and the most entries kept. */
export const LINE_CHARS = 160;
export const MAX_EVENTS = 120;

type Finished = Omit<TimelineEvent, "title" | "folder" | "where" | "team" | "unread">;

/**
 * A chat's finished turns: each ends at its start plus how long it ran, or (a transcript's turns, which don't say) when the
 * post-hook was sent, else at its start. Claude's words to the post-hook aren't the answer: the words before the hook are. A
 * turn whose start time isn't known has no place on a timeline.
 */
function finishedIn(slot: string, s: State): Finished[] {
  const out: Finished[] = [];
  let start: { id: string; at: number | undefined } | null = null;
  let said = "";
  let hookAt: number | null | undefined = null;
  const close = (key: string, kind: TimelineKind, ms: number | null) => {
    if (start?.at !== undefined && said) out.push({ key: `${slot}:${key}`, slot, at: ms !== null ? start.at + ms : (hookAt ?? start.at), kind, line: clip(plain(said), LINE_CHARS) });
    start = null;
  };
  for (const it of s.items) {
    if (it.type === "user") {
      close(`end-${it.id}`, "done", null);
      start = { id: it.id, at: it.at };
      said = "";
      hookAt = null;
    } else if (it.type === "assistant" && it.text.trim() && hookAt === null) said = it.text;
    else if (it.type === "hook") hookAt = it.at;
    else if (it.type === "turn") close(it.id, it.stopped ? "stopped" : it.isError ? "failed" : "done", it.durationMs);
  }
  if (chatState(s) === "done") close("end", "done", null);
  return out;
}

// Each chat's finished turns, kept while its state is the same object: the sidebar draws again with every streamed event.
const cached = new WeakMap<State, Finished[]>();
function finishedOf(slot: string, s: State): Finished[] {
  let hit = cached.get(s);
  if (!hit) {
    hit = finishedIn(slot, s);
    cached.set(s, hit);
  }
  return hit;
}

/**
 * Every open chat's events (`open`: by project; a team's agents are the Lead's business), newest first: a chat waiting on you
 * (with what it needs, from `needs`, the inbox's rows) or working, then each finished answer. A chat's last answer is unread
 * when the chat is.
 */
export function timelineEvents(chats: Chats, open: Record<string, ProjectOpen>, needs: InboxItem[], now = Date.now()): TimelineEvent[] {
  const folders = Object.keys(open);
  const labels = projectLabels(folders);
  const needOf = new Map(needs.filter((n) => n.needsYou).map((n) => [n.slot, n]));
  const out: TimelineEvent[] = [];
  folders.forEach((folder, i) => {
    for (const item of open[folder].items) {
      const s = chats.slots[item.slot];
      if (!s) continue;
      const base = { slot: item.slot, team: item.kind === "team", title: item.title, folder, where: labels[i] };
      const unread = item.unread || (item.kind === "team" && item.agents.some((a) => a.unread));
      const finished = finishedOf(item.slot, s);
      finished.forEach((f, n) => out.push({ ...base, ...f, unread: unread && n === finished.length - 1 }));
      const state = chatState(s);
      const need = needOf.get(item.slot);
      if (state === "waiting" || need) out.push({ ...base, key: `${item.slot}:now`, at: need?.since ?? s.activityAt ?? now, kind: "waiting", line: need?.need ?? "Needs you", unread: false });
      else if (state === "running") out.push({ ...base, key: `${item.slot}:now`, at: s.activityAt ?? now, kind: "working", line: doing(s), unread: false });
    }
  });
  const live = (e: TimelineEvent) => e.kind === "waiting" || e.kind === "working";
  return out.sort((a, b) => Number(live(b)) - Number(live(a)) || b.at - a.at).slice(0, MAX_EVENTS);
}

/** Where an entry goes on the timeline: Now for what is going on, then by day. */
export function dayOf(e: TimelineEvent, now: number): string {
  if (e.kind === "waiting" || e.kind === "working") return "Now";
  const day = (t: number) => new Date(t).toDateString();
  if (day(e.at) === day(now)) return "Today";
  if (day(e.at) === day(now - 24 * 60 * 60_000)) return "Yesterday";
  return new Date(e.at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
