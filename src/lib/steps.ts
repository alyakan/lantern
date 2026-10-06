import type { ChatItem } from "../store";
import { isVerdictNext } from "./review";
import { parsePlanStep } from "./markdown";

/** What a Step-by-step message says it is, from the heading it starts with (see STEPS_PROMPT in args.rs). */
export interface Heading {
  kind: "frame" | "plan" | "plan-complete" | "step" | "done" | "file" | "summary";
  /** The step's number, and for implementation steps the plan's length. */
  n: number | null;
  total: number | null;
  title: string;
}

type UserItem = Extract<ChatItem, { type: "user" }>;

const HEADING = /^#{1,3}\s*(Frame|Plan step\s+(\d+)|Plan complete|Step\s+(\d+)\s+of\s+(\d+)|File\s+(\d+)\s+of\s+(\d+)|Summary|Done)\b\s*(?:[—–-]+\s*(.*))?$/i;

/**
 * incremental-pr-review's own file line, when Claude writes the skill's format rather than a "# File N of M" heading:
 * `**nodejs/src/index.ts** (+2 −0)`. And its closing line, when it names itself: `**Summary**`, `Summary: …`.
 */
const FILE_LINE = /^\*\*\s*`?([^*`\n]+?)`?\s*\*\*\s*\(\s*(\+\d+\s*[−–-]\s*\d+)\s*\)\s*$/;
const SUMMARY_LINE = /^(?:\*\*Summary\*\*|Summary:)\s*[—–:-]?\s*(.*)$/i;

const fileTitle = (file: RegExpExecArray) => `${file[1].trim()} (${file[2].replace(/\s+/g, " ")})`;

/** The line after the heading, if it's the skill's file line. */
const fileLineUnder = (text: string) => FILE_LINE.exec((text.split("\n").filter((l) => l.trim())[1] ?? "").trim());

export function parseHeading(text: string): Heading | null {
  const first = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  const file = FILE_LINE.exec(first);
  if (file) return { kind: "file", n: null, total: null, title: fileTitle(file) };
  const summary = SUMMARY_LINE.exec(first);
  if (summary) return { kind: "summary", n: null, total: null, title: summary[1].replace(/\*\*/g, "").trim() };
  const m = HEADING.exec(first);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const title = (m[7] ?? "").trim();
  if (word.startsWith("file")) return { kind: "file", n: Number(m[5]), total: Number(m[6]), title };
  if (word === "summary") return { kind: "summary", n: null, total: null, title };
  if (word === "frame") return { kind: "frame", n: null, total: null, title };
  if (word.startsWith("plan step")) return { kind: "plan", n: Number(m[2]), total: null, title };
  if (word === "plan complete") return { kind: "plan-complete", n: null, total: Number(/(\d+)/.exec(title)?.[1] ?? NaN) || null, title };
  if (word.startsWith("step")) {
    // A review written under Build's headings (the chat was switched to Review and Claude kept the old format): a
    // "Step N of M" whose first line is the skill's file line is that file.
    const under = fileLineUnder(text);
    if (under) return { kind: "file", n: Number(m[3]), total: Number(m[4]), title: fileTitle(under) };
    return { kind: "step", n: Number(m[3]), total: Number(m[4]), title };
  }
  return { kind: "done", n: null, total: null, title };
}

/** One exchange on a page: what you sent, and Claude's reply to it. */
export interface StepTurn {
  prompt: UserItem;
  /** The reply's items, with the heading line taken out of the message it opens (it's the page's title). */
  items: ChatItem[];
  heading: Heading | null;
  /** The backend's turn number, for its changes; null when unknown (earlier turns of a reopened session). */
  turn: number | null;
  /** The message the heading opened (the step itself), if the reply had one. */
  messageId: string | null;
  /**
   * The reply repeats the step's heading but answers a question: it belongs in the discussion, and the step stays as
   * it was (Claude often keeps the heading on an answer).
   */
  answer?: boolean;
}

/**
 * One step, however many exchanges it took: the one that brought it, then questions about it and revisions of it
 * (replies under the same heading, or with none).
 */
export interface StepPage {
  key: string;
  /** The latest heading: the step's current title. */
  heading: Heading | null;
  turns: StepTurn[];
  /** Which turn holds the version the page shows: the latest with a heading. */
  main: number;
  /** The turns whose changes are this step's (null: some aren't known). */
  range: { from: number; to: number } | null;
}

// The heading line comes out of the message: a "#" heading, or the skill's bold file or summary line. A file line
// right under a "#" heading says the same as the heading, so it goes too.
const withoutHeading = (text: string) => {
  const first = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  const isLine = FILE_LINE.test(first) || /^\*\*Summary\*\*\s*$/i.test(first);
  const rest = (isLine ? text.replace(/^\s*[^\n]*\n?/, "") : text.replace(/^\s*#{1,3}[^\n]*\n?/, "")).replace(/^\s+/, "");
  return !isLine && fileLineUnder(text) ? rest.replace(/^[^\n]*\n?/, "").replace(/^\s+/, "") : rest;
};

// Files the skill's way have no number: they're told apart by path.
const headingKey = (h: Heading | null) => (h ? `${h.kind}:${h.n ?? (h.kind === "file" ? h.title : "")}` : null);

/** Added to a message sent with ⌘Enter on a Step-by-step page: do this, and count the step as approved. */
export const NEXT_SUFFIX = "Once that's done, this step is approved: go on to the next step.";
export const andNext = (text: string) => `${text.trim()}\n\n${NEXT_SUFFIX}`;
/** A prompt that moves on to the next step: an approval, or a message sent with ⌘Enter. */
export const movesOn = (text: string) => isApproval(text) || isVerdictNext(text) || text.trimEnd().endsWith(NEXT_SUFFIX);
/** What to show of a prompt: without the ⌘Enter suffix. */
export const promptText = (text: string) => text.trimEnd().replace(NEXT_SUFFIX, "").trimEnd();

/**
 * Put before the first message sent after switching Build, Learn or Review in a chat that has already started. The
 * restart gives Claude the new mode's system prompt, but the conversation it resumes is all in the old format, which
 * it otherwise keeps to (a review written as "# Step N of M").
 */
export function modeSwitchNote(mode: "steps" | "teach" | "review"): string {
  const build = "follow incremental-dev, and start each message you stop on with its headings (# Frame, # Plan step N, # Plan complete, # Step N of M, # Done)";
  const how =
    mode === "review"
      ? "Step-by-step Review mode. From here on follow incremental-pr-review, and start each message you stop on with Review's headings (# Frame, # File N of M — <path> (+added −removed), # Summary)"
      : mode === "teach"
        ? `Step-by-step Teach mode. From here on ${build}, and explain the why of every step`
        : `Step-by-step Build mode. From here on ${build}`;
  return `[Lantern: this chat switched to ${how}, not the format used earlier in this chat.]`;
}
const MODE_NOTE = /^\[Lantern: this chat switched to [^\]]*\]\s*/;
export const withModeNote = (mode: "steps" | "teach" | "review", text: string) => `${modeSwitchNote(mode)}\n\n${text}`;
/** A prompt as you wrote it: without a mode-switch note Lantern put before it. */
export const withoutModeNote = (text: string) => text.replace(MODE_NOTE, "");

function turnsOf(items: ChatItem[]): StepTurn[] {
  const turns: StepTurn[] = [];
  for (const it of items) {
    if (it.type === "user") turns.push({ prompt: it, items: [], heading: null, turn: it.turn ?? null, messageId: null });
    else turns[turns.length - 1]?.items.push(it);
  }
  for (const t of turns) {
    const at = t.items.map((it) => it.type === "assistant" && parseHeading(it.text) !== null).lastIndexOf(true);
    if (at < 0) continue;
    const msg = t.items[at] as Extract<ChatItem, { type: "assistant" }>;
    t.heading = parseHeading(msg.text);
    t.messageId = msg.id;
    t.items = t.items.map((it, i) => (i === at ? { ...msg, text: withoutHeading(msg.text) } : it));
  }
  return turns;
}

/**
 * The conversation as pages, one per step. A reply under a new heading starts a page, and so does a prompt that moves
 * on (so the next step's page is there while it streams); a question or change request whose reply keeps the heading,
 * or has none, stays on its step's page.
 */
export function pagesOf(items: ChatItem[]): StepPage[] {
  const pages: StepPage[] = [];
  for (const t of turnsOf(items)) {
    const last = pages[pages.length - 1];
    const key = headingKey(t.heading);
    const lastKey = last ? headingKey(last.heading) : null;
    // The same step only when both have the same heading: two replies without one (Claude didn't write them) aren't
    // the same step, so a prompt that moves on still gets a new page.
    const stays = last && ((key !== null && key === lastKey) || (key === null && !movesOn(t.prompt.text)));
    if (stays) {
      // A reply under the step's heading replaces the step only if it is the step, rewritten: not an answer to a
      // question, and not a reply that drops the step's plan (File / Change / Verify) for a discussion of it.
      if (t.heading && (isQuestion(t.prompt.text) || (planShaped(stepText(last)) && !planShaped(stepText(t))))) t.answer = true;
      last.turns.push(t);
      if (t.heading && !t.answer) {
        last.heading = t.heading;
        last.main = last.turns.length - 1;
      }
    } else pages.push({ key: t.prompt.id, heading: t.heading, turns: [t], main: 0, range: null });
  }
  // Files written the skill's way are numbered in the order they came.
  let files = 0;
  for (const page of pages) {
    if (page.heading?.kind !== "file") continue;
    files++;
    if (page.heading.n === null) page.heading = { ...page.heading, n: files };
  }
  for (const page of pages) {
    const numbers = page.turns.map((t) => t.turn);
    page.range = numbers.every((n): n is number => n !== null) ? { from: numbers[0], to: numbers[numbers.length - 1] } : null;
  }
  return pages;
}

/**
 * A page's title: its heading's, or, when Claude didn't write one, the first line of the step's message (markdown
 * taken out, cut to a readable length).
 */
export function pageTitle(page: StepPage): string | null {
  if (page.heading?.title) return page.heading.title;
  const text = page.turns[page.main].items.find((it) => it.type === "assistant" && it.text.trim());
  if (text?.type !== "assistant") return null;
  const line = text.text.trim().split("\n")[0].replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return line.length > 90 ? `${line.slice(0, 88).trimEnd()}…` : line;
}

/** "Plan step 2", "Step 3 of 5", …: the page's place in the flow. */
export function pageLabel(h: Heading | null): string {
  if (!h) return "Step";
  switch (h.kind) {
    case "frame":
      return "Frame";
    case "plan":
      return `Plan step ${h.n}`;
    case "plan-complete":
      return "Plan complete";
    case "step":
      return `Step ${h.n} of ${h.total}`;
    case "done":
      return "Done";
    case "file":
      return h.total ? `File ${h.n} of ${h.total}` : h.n ? `File ${h.n}` : "File";
    case "summary":
      return "Summary";
  }
}

/** The text of the step a turn wrote (its heading's message). */
function stepText(p: StepPage | StepTurn): string {
  const t = "turns" in p ? p.turns[p.main] : p;
  const msg = t.items.find((it) => it.id === t.messageId);
  return msg?.type === "assistant" ? msg.text : "";
}

/** Whether a message holds incremental-dev's plan block (File / Change / Verify in a code block). */
function planShaped(text: string): boolean {
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) if (parsePlanStep(m[1])) return true;
  return false;
}

/**
 * A prompt that asks about the step rather than asking to change it: it ends with "?", or opens like a question or a
 * request to explain ("why…", "what is…", "can you explain…", "tell me more…").
 */
export const isQuestion = (text: string) => {
  const t = promptText(text).trim();
  if (movesOn(text)) return false;
  return /\?\s*$/.test(t) || /^(why|what|what's|whats|how|when|where|which|who|whose|is|are|was|were|does|do|did|should|would|could|can|will|explain|elaborate|clarify|tell me|walk me through|help me understand|i don'?t (get|understand)|remind me)\b/i.test(t);
};

/** A prompt that just moves on ("Next", "ok", "yes"), rather than asking for a change. */
export const isApproval = (text: string) => /^(next|ok(ay)?|yes|y|go( on| ahead)?|continue|approved?|lgtm|👍)[.!]*$/i.test(text.trim());
