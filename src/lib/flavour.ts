import type { ChatItem } from "../store";
import type { Mode } from "../types";
import { EXPLAINING, flavourWord, FLAVOUR_WORDS } from "./flavourWord";
import { isApproval, parseHeading, startedChoice, UPDATE_MAP } from "./steps";
import { STEPS_AUTO } from "./workflow";

/**
 * What Step by step is doing: building, reviewing a change, debugging, or designing (reviewing the architecture of) a
 * feature, fix or PR. Claude suggests one and the user accepts it, or the user picks one; it doesn't change how claude
 * runs. The user sees "architecture" as Design; the id is older than the name. Build and Debug can also Explain as you
 * go (see `canExplain`), which used to be a flavour of its own, Learn.
 */
export type Flavour = "build" | "review" | "debug" | "architecture";

export const FLAVOURS: Flavour[] = ["build", "review", "debug", "architecture"];

export const FLAVOUR_LABEL: Record<Flavour, string> = { build: "Build", review: "Review", debug: "Debug", architecture: "Design" };

/** What Step by step's page buttons and status line say while a flavour runs. */
export const FLAVOUR_PHASE: Record<Flavour, string> = { build: "Building", review: "Reviewing", debug: "Debugging", architecture: "Mapping" };

/** The flavours that have the Explain as you go option. */
export const canExplain = (flavour: Flavour | null): boolean => flavour === "build" || flavour === "debug";

/** The option's name, and what it adds to a flavour's name ("Build, explaining as you go"). */
export const EXPLAIN_LABEL = "Explain as you go";
export const flavourName = (flavour: Flavour, explain: boolean) => `${FLAVOUR_LABEL[flavour]}${explain && canExplain(flavour) ? ", explaining as you go" : ""}`;

/**
 * A mode as saved by an older Lantern: Plan first is gone (its chats reopen asking before actions), and Debug, Teach and
 * Review were modes of their own before they became Step by step's flavours (Teach is Build with Explain as you go).
 * `autoApprove`: Step by step's Permissions when the save says ("steps:auto"); null when it doesn't (an older save,
 * whose auto-approve was the project's).
 */
export function savedMode(raw: string | undefined | null): { mode: Mode; autoApprove: boolean | null; flavour: Flavour | null; explain: boolean } {
  switch (raw) {
    case "auto":
      return { mode: "auto", autoApprove: false, flavour: null, explain: false };
    case "steps":
      return { mode: "steps", autoApprove: null, flavour: null, explain: false };
    case STEPS_AUTO:
      return { mode: "steps", autoApprove: true, flavour: null, explain: false };
    case "debug":
      return { mode: "steps", autoApprove: null, flavour: "debug", explain: false };
    case "teach":
      return { mode: "steps", autoApprove: null, flavour: "build", explain: true };
    case "review":
      return { mode: "steps", autoApprove: null, flavour: "review", explain: false };
    default:
      return { mode: "ask", autoApprove: false, flavour: null, explain: false };
  }
}

/** What ends a note Lantern puts before a message that carries text of its own (which may have brackets in it). */
export const NOTE_END = "(end of Lantern's note)]";

/** What a flavour note carries beyond the flavour: Explain as you go on, and the instructions to repeat. */
export interface NoteOptions {
  /** The flavour's own instructions, repeated in the note. */
  guide?: string | null;
  /** Explain as you go is on (Build and Debug). */
  explain?: boolean;
  /** The option's own instructions, repeated when it's on. */
  explainGuide?: string | null;
}

/**
 * Put before the first message sent after picking a flavour (or turning Explain as you go on or off) yourself: Claude
 * starts it without asking (see STEPS_PROMPT), and the chat remembers it (the note stays in the session, so reopening it
 * brings the flavour back). The guides are the instructions themselves, repeated in the note: a chat that switches
 * partway through has a long way to look back for them, and it's in the middle of a long chat that Claude starts writing
 * pages its own way.
 */
export function flavourNote(flavour: Flavour, { guide, explain = false, explainGuide }: NoteOptions = {}): string {
  const label = FLAVOUR_LABEL[flavour];
  const named = flavourName(flavour, explain);
  const on = explain && canExplain(flavour);
  const note = `[Lantern: this chat switched to ${named}. The user picked it: work in it from here on, starting each page with ${label}'s headings, not the format used earlier in this chat.${on ? " Explain as you go is on until a later note says otherwise." : ""}`;
  const guides = [guide ? `How ${label} works, from Lantern's instructions:\n\n${guide}` : null, on && explainGuide ? `How ${EXPLAIN_LABEL} works, from Lantern's instructions:\n\n${explainGuide}` : null].filter(Boolean);
  return guides.length ? `${note} ${guides.join("\n\n")}\n\n${NOTE_END}` : `${note}]`;
}
export const withFlavourNote = (flavour: Flavour, text: string, options?: NoteOptions) => `${flavourNote(flavour, options)}\n\n${text}`;

// A note with the flavour's instructions in it runs to its end mark. Its "How … works" comes before any `]`, which tells it from a bare note that ends in `]`. Older notes named a mode ("Step-by-step Review
// mode", "Teach mode"), a flavour that is now Build with Explain as you go (Learn) or one that has been renamed
// (Architecture, now Design); they're read the same way.
const NOTE_WITH_GUIDE = new RegExp(`^\\[Lantern: this chat switched to (${FLAVOUR_WORDS})\\b(${EXPLAINING})?[^\\]]*? How [\\s\\S]*?\\(end of Lantern's note\\)\\]\\s*`);
const NOTE = new RegExp(`^\\[Lantern: this chat switched to (?:Step-by-step )?(${FLAVOUR_WORDS})\\b(${EXPLAINING})?[^\\]]*\\]\\s*`);

/** A prompt as you wrote it, and the flavour a note Lantern put before it picked (with whether Explain as you go is on). */
export function readFlavourNote(text: string): { text: string; flavour: Flavour | null; explain: boolean } {
  const m = NOTE_WITH_GUIDE.exec(text) ?? NOTE.exec(text);
  if (!m) return { text, flavour: null, explain: false };
  const { flavour, explain } = flavourWord(m[1]);
  return { text: text.slice(m[0].length), flavour, explain: explain || !!m[2] };
}

/**
 * The flavour a Step-by-step chat is in, from its conversation: the latest one you picked, or started from Claude's
 * suggestion ("Start Debug.", or a yes to it). `start` is what it was in before any of that (an older session's mode),
 * with `startExplain` for Explain as you go. When neither happened (Claude didn't ask), the pages say it: files are a
 * review, evidence a debug, plans a build. Explain as you go is whatever the latest pick or start said.
 */
export function flavourState(items: ChatItem[], start: Flavour | null = null, startExplain = false): { flavour: Flavour | null; explain: boolean } {
  let current = start;
  let explain = startExplain;
  let suggested: { flavour: Flavour; explain: boolean } | null = null;
  let pages: Flavour | null = null;
  // An Overview asked for with Update the map is the map brought up to date, in whatever flavour the chat was in.
  let mapUpdate = false;
  for (const it of items) {
    if (it.type === "assistant") {
      const h = parseHeading(it.text);
      // A reply without a heading answers a question: whatever was suggested still is.
      if (h) suggested = h.kind === "switch" && h.flavour ? { flavour: h.flavour, explain: !!h.explain } : null;
      const kind = h?.kind;
      // A Summary closes a Review and a Design map alike: it belongs to whichever the pages before it were.
      if (kind === "file" || (kind === "summary" && pages !== "architecture")) pages = "review";
      else if ((kind === "overview" && !mapUpdate) || kind === "part") pages = "architecture";
      else if (kind === "evidence" || kind === "fix") pages = "debug";
      else if (kind === "plan" || kind === "plan-complete" || kind === "step") pages = "build";
    } else if (it.type === "user" && !it.auto) {
      mapUpdate = it.text.trim() === UPDATE_MAP;
      const started = it.switchedTo ? { flavour: it.switchedTo, explain: !!it.explained } : (startedChoice(it.text) ?? (suggested && isApproval(it.text) ? suggested : null));
      if (started) {
        current = started.flavour;
        explain = started.explain;
        suggested = null;
      }
    }
  }
  return { flavour: current ?? pages, explain };
}

export const flavourOf = (items: ChatItem[], start: Flavour | null = null): Flavour | null => flavourState(items, start).flavour;
