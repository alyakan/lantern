import type { ChatItem } from "../store";
import { FLAVOUR_LABEL, NOTE_END, type Flavour } from "./flavour";
import { headingWords, parseHeading } from "./steps";
import type { ArchitectureMap } from "./architecture";

/** One flavour as the prompt Claude runs with has it (see args::flavour_guide): its section, and its pages' headings. */
export interface FlavourGuide {
  flavour: string;
  text: string;
  headings: string[];
}

/** The guides by flavour, as the backend gives them. */
export type Guides = Partial<Record<Flavour, FlavourGuide>>;

export const guidesByFlavour = (list: FlavourGuide[]): Guides => Object.fromEntries(list.map((g) => [g.flavour.toLowerCase(), g]));

/**
 * The latest reply, when it is set like a page (its first line a heading, or all bold) but isn't one of the flavour's
 * headings: Lantern couldn't make a page of it. `first` is its first line. Null when the turn's reply was a page, or an
 * answer with no heading, which is how answers should be.
 */
export function unreadReply(items: readonly ChatItem[]): { id: string; first: string } | null {
  const lastUser = items.map((it) => it.type === "user").lastIndexOf(true);
  if (lastUser < 0) return null;
  const replies = items.slice(lastUser + 1).filter((it): it is Extract<ChatItem, { type: "assistant" }> => it.type === "assistant" && !!it.text.trim());
  // The turn's page is its last heading; with one there, nothing went wrong.
  if (replies.length === 0 || replies.some((r) => parseHeading(r.text) !== null)) return null;
  const last = replies[replies.length - 1];
  const first = (last.text.split("\n").find((l) => l.trim()) ?? "").trim();
  if (headingWords(first) === null && !/^#{4,6}\s/.test(first)) return null;
  return { id: last.id, first };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * When Claude's last reply in a Step-by-step chat is set like a page (its first line a heading, or all bold) but isn't
 * one of the flavour's headings, Lantern couldn't make a page of it: the note that goes with the user's next message,
 * telling Claude what it wrote and the headings to use. Null when the reply was a page, or an answer with no heading.
 */
export function pageNote(items: readonly ChatItem[], flavour: Flavour | null, guides: Guides): string | null {
  const first = flavour ? unreadReply(items)?.first : undefined;
  if (!flavour || first === undefined) return null;
  const label = FLAVOUR_LABEL[flavour];
  const headings = guides[flavour]?.headings ?? [];
  const list = headings.length ? ` ${label}'s headings are:\n${headings.join("\n")}\n` : ` Read mcp__lantern__steps_guide for ${label}'s headings.`;
  return `[Lantern: your last message began "${clip(first, 100)}", which isn't one of ${label}'s headings, so it wasn't shown as a page. If it was a page, start it with exactly one of its headings as the first line, with nothing of your own before it.${list}If it answered a question, it needs no heading at all. ${NOTE_END}`;
}

/**
 * When the latest Architecture Overview's block doesn't read, the Map tab can't draw it: the note that goes with the
 * user's next message, telling Claude why. Null when the map reads (or there is none).
 */
export function mapNote(map: ArchitectureMap | null): string | null {
  if (!map || map.kind !== "broken") return null;
  const error = clip(map.error.replace(/\s+/g, " ").trim(), 200);
  return `[Lantern: your Overview's architecture block didn't read (${error}), so the Map tab can't draw it. Rewrite the Overview with a block that matches steps_guide's schema. ${NOTE_END}`;
}

export const withPageNote = (note: string | null, text: string) => (note ? `${note}\n\n${text}` : text);

const PAGE_NOTE = /^(?:\[Lantern: (?:your last message began|your Overview's architecture block didn't read) [\s\S]*?\(end of Lantern's note\)\]\s*)+/;

/** A prompt as the user wrote it, without the notes about a page, or an Overview map, Lantern couldn't read. */
export const readPageNote = (text: string) => text.replace(PAGE_NOTE, "");
