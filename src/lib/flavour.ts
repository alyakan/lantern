import type { ChatItem } from "../store";
import type { Mode } from "../types";
import { isApproval, parseHeading, startedFlavour } from "./steps";

/**
 * What Step by step is doing: building, building and explaining (for someone learning), reviewing a change, debugging,
 * or mapping the architecture of a feature, fix or PR. Claude suggests one and the user accepts it, or the user picks
 * one; it doesn't change how claude runs.
 */
export type Flavour = "build" | "learn" | "review" | "debug" | "architecture";

export const FLAVOURS: Flavour[] = ["build", "learn", "review", "debug", "architecture"];

export const FLAVOUR_LABEL: Record<Flavour, string> = { build: "Build", learn: "Learn", review: "Review", debug: "Debug", architecture: "Architecture" };

/** What Step by step's page buttons and status line say while a flavour runs. */
export const FLAVOUR_PHASE: Record<Flavour, string> = { build: "Building", learn: "Learning", review: "Reviewing", debug: "Debugging", architecture: "Mapping" };

/**
 * A mode as saved by an older Lantern: Plan first is gone (its chats reopen asking before actions), and Debug, Teach and
 * Review were modes of their own before they became Step by step's flavours.
 */
export function savedMode(raw: string | undefined | null): { mode: Mode; flavour: Flavour | null } {
  switch (raw) {
    case "auto":
    case "steps":
      return { mode: raw, flavour: null };
    case "debug":
      return { mode: "steps", flavour: "debug" };
    case "teach":
      return { mode: "steps", flavour: "learn" };
    case "review":
      return { mode: "steps", flavour: "review" };
    default:
      return { mode: "ask", flavour: null };
  }
}

/** What ends a note Lantern puts before a message that carries text of its own (which may have brackets in it). */
export const NOTE_END = "(end of Lantern's note)]";

/**
 * Put before the first message sent after picking a flavour yourself: Claude starts it without asking (see
 * STEPS_PROMPT), and the chat remembers it (the note stays in the session, so reopening it brings the flavour back).
 * `guide`: the flavour's own instructions, repeated in the note. A chat that switches partway through has a long way to
 * look back for them, and it's in the middle of a long chat that Claude starts writing pages its own way.
 */
export function flavourNote(flavour: Flavour, guide?: string | null): string {
  const label = FLAVOUR_LABEL[flavour];
  const note = `[Lantern: this chat switched to ${label}. The user picked it: work in it from here on, starting each page with ${label}'s headings, not the format used earlier in this chat.`;
  return guide ? `${note} How ${label} works, from Lantern's instructions:\n\n${guide}\n\n${NOTE_END}` : `${note}]`;
}
export const withFlavourNote = (flavour: Flavour, text: string, guide?: string | null) => `${flavourNote(flavour, guide)}\n\n${text}`;

// A note with the flavour's instructions in it runs to its end mark. Older notes named a mode ("Step-by-step Review
// mode", "Teach mode"); they're read the same way.
const NOTE_WITH_GUIDE = /^\[Lantern: this chat switched to (Build|Learn|Review|Debug|Architecture)\b[\s\S]*?\(end of Lantern's note\)\]\s*/;
const NOTE = /^\[Lantern: this chat switched to (?:Step-by-step )?(Build|Learn|Teach|Review|Debug|Architecture)\b[^\]]*\]\s*/;

/** A prompt as you wrote it, and the flavour a note Lantern put before it picked. */
export function readFlavourNote(text: string): { text: string; flavour: Flavour | null } {
  const m = NOTE_WITH_GUIDE.exec(text) ?? NOTE.exec(text);
  if (!m) return { text, flavour: null };
  const word = m[1].toLowerCase();
  return { text: text.slice(m[0].length), flavour: word === "teach" ? "learn" : (word as Flavour) };
}

/**
 * The flavour a Step-by-step chat is in, from its conversation: the latest one you picked, or started from Claude's
 * suggestion ("Start Debug.", or a yes to it). `start` is what it was in before any of that (an older session's mode).
 * When neither happened (Claude didn't ask), the pages say it: files are a review, evidence a debug, plans a build.
 */
export function flavourOf(items: ChatItem[], start: Flavour | null = null): Flavour | null {
  let current = start;
  let suggested: Flavour | null = null;
  let pages: Flavour | null = null;
  for (const it of items) {
    if (it.type === "assistant") {
      const h = parseHeading(it.text);
      // A reply without a heading answers a question: whatever was suggested still is.
      if (h) suggested = h.kind === "switch" ? (h.flavour ?? null) : null;
      const kind = h?.kind;
      // A Summary closes a Review and an Architecture map alike: it belongs to whichever the pages before it were.
      if (kind === "file" || (kind === "summary" && pages !== "architecture")) pages = "review";
      else if (kind === "overview" || kind === "part") pages = "architecture";
      else if (kind === "evidence" || kind === "fix") pages = "debug";
      else if (kind === "plan" || kind === "plan-complete" || kind === "step") pages = "build";
    } else if (it.type === "user" && !it.auto) {
      const started = it.switchedTo ?? startedFlavour(it.text) ?? (suggested && isApproval(it.text) ? suggested : null);
      if (started) {
        current = started;
        suggested = null;
      }
    }
  }
  return current ?? pages;
}
