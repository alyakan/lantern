import type { ChatItem } from "../store";
import type { Mode } from "../types";
import { isApproval, parseHeading, startedFlavour } from "./steps";

/**
 * What Step by step is doing: building, building and explaining (for someone learning), reviewing a change, or
 * debugging. Claude suggests one and the user accepts it, or the user picks one; it doesn't change how claude runs.
 */
export type Flavour = "build" | "learn" | "review" | "debug";

export const FLAVOURS: Flavour[] = ["build", "learn", "review", "debug"];

export const FLAVOUR_LABEL: Record<Flavour, string> = { build: "Build", learn: "Learn", review: "Review", debug: "Debug" };

/** What Step by step's page buttons and status line say while a flavour runs. */
export const FLAVOUR_PHASE: Record<Flavour, string> = { build: "Building", learn: "Learning", review: "Reviewing", debug: "Debugging" };

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

/**
 * Put before the first message sent after picking a flavour yourself: Claude starts it without asking (see
 * STEPS_PROMPT), and the chat remembers it (the note stays in the session, so reopening it brings the flavour back).
 */
export function flavourNote(flavour: Flavour): string {
  return `[Lantern: this chat switched to ${FLAVOUR_LABEL[flavour]}. The user picked it: work in it from here on, starting each page with ${FLAVOUR_LABEL[flavour]}'s headings, not the format used earlier in this chat.]`;
}
export const withFlavourNote = (flavour: Flavour, text: string) => `${flavourNote(flavour)}\n\n${text}`;

// Older notes named a mode ("Step-by-step Review mode", "Teach mode"); they're read the same way.
const NOTE = /^\[Lantern: this chat switched to (?:Step-by-step )?(Build|Learn|Teach|Review|Debug)\b[^\]]*\]\s*/;

/** A prompt as you wrote it, and the flavour a note Lantern put before it picked. */
export function readFlavourNote(text: string): { text: string; flavour: Flavour | null } {
  const m = NOTE.exec(text);
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
      if (kind === "file" || kind === "summary") pages = "review";
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
